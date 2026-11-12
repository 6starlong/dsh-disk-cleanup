/**
 * dsh-disk-cleanup —— 把模型的临时文件收进 scratch 目录。
 *
 * 四条机制：
 *  - 文件工具覆盖：在 agent 作用域注册同名 write / edit / apply_patch，
 *    改写 file_path 后调用原实现，返回给模型的 path 就是真实落点。
 *  - shell 环境注入：在 pwsh / bash 命令串前设置临时目录与包管理器缓存目录，
 *    让脚本和安装动作默认落在工作区之外。
 *  - 权限补齐：workspace-write 下给 scratch 与缓存目录追加可写根（文件工具）
 *    和访问控制列表授权（受限子进程）。
 *  - 系统提示：说明临时文件与用户文件的落点区别。
 * @module dsh-disk-cleanup
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './config.js'
import { dshHome, defaultTempRoots, ensureDir, scratchDirFor } from './scratch.js'
import { classifyRedirect, patchPaths, rewritePatchPaths } from './redirect.js'
import { injectShellEnv, injectShellTemp } from './shell-env.js'
import { grantProcessWrite, revokeAll } from './acl.js'
import { managedRuntimes, probeRuntimes, runtimeCacheDirs, runtimeCacheEnv } from './runtimes.js'
import { scratchPromptText } from './prompt.js'

/** Cordis 插件身份。 */
export const name = 'disk-cleanup'
/** 必需服务：工具注册表与 agent 注册表。 */
export const inject = ['tools', 'agents']

/** agent → 已装好包装的工具名。用来避免重复注册，也用来记下「当时还没加载」的工具。 */
const installed = new WeakMap()

/** 正在安装中的 agent。注册包装会触发 tools/change，不挡住就会重入、重复注册同一个工具名并抛错。 */
const installing = new WeakSet()

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @param {unknown} config - cordis.patch.yml 里的 config。
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  /** 可选服务：拿不到就退化（只保留能用的那部分），绝不因此报错。 */
  let sandboxPolicy
  ctx.inject(['sandboxPolicy'], (child) => { sandboxPolicy = child.sandboxPolicy })

  /** 包管理器探测结果，只在第一次需要时执行。 */
  let probeCache
  /**
   * 取包管理器探测结果（进程内缓存）。
   * @returns {Record<string, {present: boolean, path?: string}>} 探测结果。
   */
  function probes() {
    if (probeCache === undefined) probeCache = probeRuntimes(process.env)
    return probeCache
  }

  /**
   * 会话 → 已完成的授权。键里带模式与目录，模式一变就重新授权。
   * @type {WeakMap<object, {key: string, promise: Promise<boolean>}>}
   */
  const prepared = new WeakMap()

  /**
   * 会话 → 实际生效的落点。退路可能改掉 scratch 位置，系统提示要跟着改口。
   * @type {WeakMap<object, object>}
   */
  const effective = new WeakMap()

  /**
   * 取一个可选服务：优先用注入回调拿到的，其次直接问上下文。
   * 注入回调是异步触发的，落点计算可能早于它，所以这里必须能自己取到。
   * @param {string} serviceName - 服务名。
   * @param {unknown} injected - 注入回调里拿到的实例。
   * @returns {unknown} 服务实例，取不到时为 undefined。
   */
  function service(serviceName, injected) {
    if (injected !== undefined) return injected
    try {
      return typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 读一个会话解析后的沙箱策略。
   * @param {object | undefined} session - 会话对象。
   * @returns {{mode?: string, workspaceRoot?: string}} 策略；取不到时为空对象。
   */
  function policyFor(session) {
    const policyService = service('sandboxPolicy', sandboxPolicy)
    try {
      return policyService?.resolve({ session }) ?? {}
    } catch {
      return {}
    }
  }

  /**
   * 算出一个会话的落点信息。纯计算，不建目录、不授权。
   *
   * 每次调用都重新读策略：模式可能在会话中途变化，缓存住旧模式会把临时文件
   * 送进当时并不允许写的目录。
   * @param {object | undefined} session - 会话对象。
   * @returns {{mode?: string, workspaceRoot?: string, scratchDir?: string, cacheDirs: string[], shellEnv: Array<[string, string]>}} 落点信息。
   */
  function resolveState(session) {
    const policy = policyFor(session)
    const mode = policy.mode
    const workspaceRoot = policy.workspaceRoot ?? session?.header?.cwd
    const state = { mode, workspaceRoot, scratchDir: undefined, cacheDirs: [], shellEnv: [] }
    if (mode === undefined || mode === 'read-only') return state

    const scratchDir = scratchDirFor({ mode, workspaceRoot, configured: cfg.scratchDir })
    if (scratchDir === undefined) return state
    state.scratchDir = scratchDir

    // 依赖缓存只在真能写时才接管：写不进去的路径会让安装直接失败。
    if (cfg.runtimeCache !== 'never') {
      const cacheRoot = join(dshHome(), 'cache')
      const managed = managedRuntimes(cfg.runtimeCache, probes())
      state.cacheDirs = runtimeCacheDirs(cacheRoot, managed)
      state.shellEnv = Object.entries(runtimeCacheEnv(cacheRoot, managed))
    }
    return state
  }

  /**
   * 让一个目录可写：建出来，并补上文件工具与受限子进程各自的权限。
   * @param {object} session - 会话对象。
   * @param {string} mode - 沙箱模式。
   * @param {string | undefined} workspaceRoot - 工作区根。
   * @param {string} dir - 目标目录。
   * @returns {Promise<boolean>} 是否可用。
   */
  async function makeWritable(session, mode, workspaceRoot, dir) {
    try {
      await ensureDir(dir)
    } catch {
      return false
    }
    // 完全权限下没有围栏，建出来就能写。
    if (!cfg.grantProcessWrite || mode === 'danger-full-access') return true
    let rooted = true
    const policyService = service('sandboxPolicy', sandboxPolicy)
    try {
      if (typeof policyService?.registerWritableRoot !== 'function') rooted = false
      else policyService.registerWritableRoot(session, dir)
    } catch {
      rooted = false
    }
    const processWritable = await grantProcessWrite(workspaceRoot, dir)
    return rooted && processWritable
  }

  /**
   * 落实落点：建目录并补权限。首次真正要用时才调用——
   * 会话创建那一刻策略还没落定，提前算会把临时文件送进错误的目录。
   * @param {object | undefined} session - 会话对象。
   * @param {object} state - resolveState 的结果，可能被就地修正为退路目录。
   * @returns {Promise<boolean>} 是否可用。
   */
  function activate(session, state) {
    if (session === undefined || session === null) return Promise.resolve(false)
    if (state.scratchDir === undefined) return Promise.resolve(false)
    const key = [state.mode, state.scratchDir, state.cacheDirs.join(';')].join('|')
    const cached = prepared.get(session)
    if (cached !== undefined && cached.key === key) return cached.promise
    const promise = (async () => {
      const dirs = [state.scratchDir, ...state.cacheDirs]
      let ok = true
      for (const dir of dirs) {
        if (!(await makeWritable(session, state.mode, state.workspaceRoot, dir))) {
          ok = false
          break
        }
      }
      if (ok) {
        effective.set(session, state)
        return true
      }
      // 共享目录拿不到权限时退回工作区里的 cache/scratch：至少写入能成。
      if (state.mode !== 'workspace-write' || typeof state.workspaceRoot !== 'string') return false
      const fallback = scratchDirFor({
        mode: state.mode,
        workspaceRoot: state.workspaceRoot,
        configured: cfg.scratchDir,
        sharedCache: false,
      })
      if (fallback === undefined) return false
      if (!(await makeWritable(session, state.mode, state.workspaceRoot, fallback))) return false
      state.scratchDir = fallback
      state.cacheDirs = []
      state.shellEnv = []
      effective.set(session, state)
      return true
    })()
    prepared.set(session, { key, promise })
    return promise
  }

  /**
   * 决定一个路径要不要改到 scratch。
   * @param {string} rawPath - 模型给的路径。
   * @param {'write' | 'edit'} kind - 哪个工具在写。
   * @param {object} exec - 工具执行上下文。
   * @returns {Promise<{target: string, redirected: boolean}>} 最终路径。
   */
  async function decide(rawPath, kind, exec) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') return { target: rawPath, redirected: false }
    const session = exec?.agent?.session
    const state = resolveState(session)
    if (state.scratchDir === undefined) return { target: rawPath, redirected: false }
    if (!(await activate(session, state))) return { target: rawPath, redirected: false }
    const scratchDir = state.scratchDir
    if (scratchDir === undefined) return { target: rawPath, redirected: false }
    const cwd = state.workspaceRoot
    const bare = rawPath.trim()
    const hasDir = bare.includes('/') || bare.includes('\\')
    const workspaceHasFile = cwd !== undefined && hasDir === false ? existsSync(join(cwd, bare)) : false
    const scratchHasFile = hasDir === false ? existsSync(join(scratchDir, bare)) : false
    const verdict = classifyRedirect(bare, {
      scratchDir,
      workspaceRoot: cwd,
      tempRoots: defaultTempRoots(),
      kind,
      workspaceHasFile,
      scratchHasFile,
      redirectSystemTemp: cfg.redirectSystemTemp,
      redirectBareScripts: cfg.redirectBareScripts,
      scriptExtensions: cfg.bareScriptExtensions,
    })
    if (!verdict.redirect || verdict.target === undefined) return { target: rawPath, redirected: false }
    return { target: verdict.target, redirected: true }
  }

  /**
   * 包装一个以 file_path 为落点的文件工具。
   * @param {object} agentCtx - agent 作用域上下文。
   * @param {'write' | 'edit'} toolName - 工具名。
   * @returns {boolean} 是否注册成功。
   */
  function wrapFileTool(agentCtx, toolName) {
    const live = ctx.tools.get(toolName)
    if (live === undefined) return false
    agentCtx.tools.register({
      ...live,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        if (typeof input.file_path !== 'string') return live.execute(args, exec)
        const { target } = await decide(input.file_path, toolName, exec)
        if (target === input.file_path) return live.execute(args, exec)
        return live.execute({ ...input, file_path: target }, exec)
      },
    })
    return true
  }

  /**
   * 包装 apply_patch：它只有 input 一个参数，路径写在补丁文本的行里。
   * @param {object} agentCtx - agent 作用域上下文。
   * @returns {boolean} 是否注册成功。
   */
  function wrapApplyPatch(agentCtx) {
    const live = ctx.tools.get('apply_patch')
    if (live === undefined) return false
    agentCtx.tools.register({
      ...live,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        if (typeof input.input !== 'string' || input.input === '') return live.execute(args, exec)
        const paths = patchPaths(input.input)
        if (paths.length === 0) return live.execute(args, exec)
        const mapping = new Map()
        for (const path of paths) {
          const { target } = await decide(path, 'write', exec)
          if (target !== path) mapping.set(path, target)
        }
        if (mapping.size === 0) return live.execute(args, exec)
        const rewritten = rewritePatchPaths(input.input, path => mapping.get(path))
        if (!rewritten.changed) return live.execute(args, exec)
        return live.execute({ ...input, input: rewritten.text }, exec)
      },
    })
    return true
  }

  /**
   * 包装 shell 工具：在命令串前注入临时目录与缓存目录。
   * @param {object} agentCtx - agent 作用域上下文。
   * @param {'pwsh' | 'bash'} shell - shell 类型。
   * @returns {boolean} 是否注册成功。
   */
  function wrapShell(agentCtx, shell) {
    if (!cfg.injectShellTemp && cfg.runtimeCache === 'never') return false
    const live = ctx.tools.get(shell)
    if (live === undefined) return false
    agentCtx.tools.register({
      ...live,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        if (typeof input.command !== 'string' || input.command === '') return live.execute(args, exec)
        const session = exec?.agent?.session
        const state = resolveState(session)
        if (state.scratchDir === undefined) return live.execute(args, exec)
        if (!(await activate(session, state))) return live.execute(args, exec)
        let command = input.command
        if (state.scratchDir !== undefined) command = injectShellTemp(shell, command, state.scratchDir)
        if (state.shellEnv.length > 0) command = injectShellEnv(shell, command, state.shellEnv)
        if (command === input.command) return live.execute(args, exec)
        return live.execute({ ...input, command }, exec)
      },
    })
    return true
  }

  /** 要包装的工具清单。 */
  const TARGETS = ['write', 'edit', 'apply_patch', 'pwsh', 'bash']

  /**
   * 给一个 agent 装上全部包装；已经装过的跳过。
   * @param {object} agent - agent 实例。
   * @returns {Promise<void>}
   */
  async function install(agent) {
    if (agent === undefined || agent === null) return
    if (installing.has(agent)) return
    installing.add(agent)
    try {
      await installNow(agent)
    } finally {
      installing.delete(agent)
    }
  }

  /**
   * install 的实际内容，由 install 负责重入保护。
   * 目标工具当时还没注册时留待 tools/change 重试，不会永久漏掉。
   * @param {object} agent - agent 实例。
   * @returns {Promise<void>}
   */
  async function installNow(agent) {
    const agentCtx = agent.ctx
    if (agentCtx === undefined || typeof agentCtx.inject !== 'function') return
    let done = installed.get(agent)
    if (done === undefined) {
      done = new Set()
      installed.set(agent, done)
    }
    const ready = TARGETS.filter(toolName => !done.has(toolName) && ctx.tools.get(toolName) !== undefined)
    if (ready.length === 0) return
    // 真实的 agent 上下文要求先声明依赖才能读 ctx.tools；注册仍落在该 agent 的作用域层。
    await new Promise((resolve) => {
      agentCtx.inject(['tools'], (child) => {
        // 只有真的注册成功才记进 done；目标工具还没出现时留白，等 tools/change 再补。
        for (const toolName of ready) {
          const ok = toolName === 'apply_patch'
            ? wrapApplyPatch(child)
            : toolName === 'pwsh' || toolName === 'bash'
              ? wrapShell(child, toolName)
              : wrapFileTool(child, toolName)
          if (ok) done.add(toolName)
        }
        resolve()
      })
    })
  }

  // agent/created 是串行且被 await 的，返回 Promise 能保证新 agent 的第一步就用上包装。
  ctx.on('agent/created', ({ agent }) => install(agent))
  // 工具注册表变化时补装：目标工具可能比本插件晚加载。
  ctx.on('tools/change', () => {
    for (const agent of ctx.agents.list()) void install(agent)
  })
  for (const agent of ctx.agents.list()) void install(agent)

  if (cfg.promptSection) {
    ctx.inject(['systemPrompt'], (child) => {
      // 排在 write 工具的说明之后；取不到宿主顺序时用固定兜底值。
      let order = 1201
      try {
        const baseOrder = child.systemPrompt.getSectionOrder('TOOL_WRITE')
        if (Number.isFinite(baseOrder)) order = baseOrder + 1
      } catch {
        /* 宿主未提供顺序表时保留兜底值 */
      }
      child.systemPrompt.section({
        name: 'disk-cleanup',
        order,
        text: (context) => {
          const session = context?.agent?.session
          const fresh = resolveState(session)
          // 退路可能把 scratch 挪到了工作区，提示要跟着改口；但模式变了（比如切成只读）就先以新模式为准。
          const applied = session === undefined ? undefined : effective.get(session)
          const state = fresh.scratchDir === undefined ? fresh : applied ?? fresh
          return scratchPromptText({ scratchDir: state.scratchDir, cacheDirs: state.cacheDirs })
        },
      })
    })
  }

  // 插件卸载时撤销全部访问控制列表授权，不在磁盘上留残留。
  if (typeof ctx.effect === 'function') ctx.effect(() => () => revokeAll())
}