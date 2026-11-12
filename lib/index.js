/**
 * dsh-disk-cleanup —— 把模型写的临时文件收进 scratch 目录。
 *
 * 三条机制：
 *  - 文件工具覆盖：在 agent 作用域注册同名 write / edit / apply_patch，
 *    改写 file_path 后调用原实现，返回给模型的 path 就是真实落点。
 *  - shell 环境注入：在 pwsh / bash 命令串前设置 TMP/TEMP/TMPDIR，
 *    让脚本里的临时目录 API 默认落在 scratch。
 *  - 系统提示：说明临时文件与用户文件的落点区别。
 * @module dsh-disk-cleanup
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from './config.js'
import { ensureDir, scratchDirFor, defaultTempRoots } from './scratch.js'
import { classifyRedirect, patchPaths, rewritePatchPaths } from './redirect.js'
import { injectShellTemp } from './shell-env.js'
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
  let systemPrompt
  ctx.inject(['sandboxPolicy'], (child) => { sandboxPolicy = child.sandboxPolicy })
  ctx.inject(['systemPrompt'], (child) => { systemPrompt = child.systemPrompt })

  /**
   * 解析本次调用该用的 scratch 目录。
   * @param {object} exec - 工具执行上下文。
   * @returns {string | undefined} 绝对路径；不可用时 undefined。
   */
  function scratchFor(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    let policy
    try {
      policy = sandboxPolicy?.resolve({ session: exec?.agent?.session })
    } catch {
      policy = undefined
    }
    const dir = scratchDirFor({
      mode: policy?.mode,
      workspaceRoot: policy?.workspaceRoot ?? cwd,
      configured: cfg.scratchDir,
    })
    return dir === undefined ? undefined : dir
  }

  /**
   * 决定一个路径要不要改到 scratch。
   * @param {string} rawPath - 模型给的路径。
   * @param {'write' | 'edit'} kind - 哪个工具在写。
   * @param {object} exec - 工具执行上下文。
   * @returns {Promise<{target: string, redirected: boolean}>} 最终路径。
   */
  async function decide(rawPath, kind, exec) {
    const scratchDir = scratchFor(exec)
    const cwd = exec?.agent?.session?.header?.cwd
    if (scratchDir === undefined || typeof rawPath !== 'string' || rawPath.trim() === '') {
      return { target: rawPath, redirected: false }
    }
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
    await ensureDir(scratchDir)
    return { target: verdict.target, redirected: true }
  }

  /**
   * 包装一个以 file_path 为落点的文件工具。
   * @param {object} agentCtx - agent 作用域上下文。
   * @param {'write' | 'edit'} toolName - 工具名。
   * @returns {void}
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
   * @returns {void}
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
   * 包装 shell 工具：在命令串前注入临时目录。
   * @param {object} agentCtx - agent 作用域上下文。
   * @param {'pwsh' | 'bash'} shell - shell 类型。
   * @returns {void}
   */
  function wrapShell(agentCtx, shell) {
    if (!cfg.injectShellTemp) return false
    const live = ctx.tools.get(shell)
    if (live === undefined) return false
    agentCtx.tools.register({
      ...live,
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {}
        if (typeof input.command !== 'string') return live.execute(args, exec)
        const scratchDir = scratchFor(exec)
        if (scratchDir === undefined) return live.execute(args, exec)
        const command = injectShellTemp(shell, input.command, scratchDir)
        if (command === input.command) return live.execute(args, exec)
        await ensureDir(scratchDir)
        return live.execute({ ...input, command }, exec)
      },
    })
    return true
  }

  /** 要包装的工具清单。 */
  const TARGETS = ['write', 'edit', 'apply_patch', 'pwsh', 'bash']

  /**
   * 给一个 agent 装上全部包装；已经装过的跳过。
   * 目标工具当时还没注册（插件顺序靠后）时留待 tools/change 重试，不会永久漏掉。
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
    // 只装此刻已注册的工具；还没注册的留给 tools/change 重试，不阻塞其余的。
    const ready = TARGETS.filter(name => !done.has(name) && ctx.tools.get(name) !== undefined)
    if (ready.length === 0) return
    // 真实的 agent 上下文要求先声明依赖才能读 ctx.tools；注册仍落在该 agent 的作用域层。
    // ctx.inject 的回调是延后到服务就绪时才跑的，所以这里等它跑完再返回。
    await new Promise((resolve) => {
      agentCtx.inject(['tools'], (child) => {
        // 只有真的注册成功才记进 done；目标工具还没出现时留白，等 tools/change 再补。
        for (const name of ready) {
          const ok = name === 'apply_patch'
            ? wrapApplyPatch(child)
            : name === 'pwsh' || name === 'bash'
              ? wrapShell(child, name)
              : wrapFileTool(child, name)
          if (ok) done.add(name)
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
        const base = child.systemPrompt.getSectionOrder('TOOL_WRITE')
        if (Number.isFinite(base)) order = base + 1
      } catch {
        /* 宿主未提供顺序表时保留兜底值 */
      }
      child.systemPrompt.section({ name: 'disk-cleanup', order, text: scratchPromptText() })
    })
  }
}
