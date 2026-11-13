import { apply } from '../lib/index.js'
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// scratch 位置由 DSH_HOME 决定；测试把它指到临时目录，不碰真实缓存。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-disk-cleanup-plugin-'))
process.env.DSH_HOME = HOME
after(() => rmSync(HOME, { recursive: true, force: true }))

/** 本测试里的 scratch 目录。 */
const SCRATCH = join(HOME, 'cache', 'scratch')

/** 默认配置：不碰真实访问控制列表，也不建包管理器缓存目录。 */
const SAFE = { grantProcessWrite: false, runtimeCache: 'never' }

/**
 * 造一个足够真的假 ctx：记录注册了哪些工具、装了哪些 section。
 * @param {object} [options] - mode 指定沙箱模式，config 追加插件配置。
 * @returns {object} 假宿主。
 */
function fakeHost(options = {}) {
  const mode = options.mode ?? 'workspace-write'
  const globals = new Map()
  const registered = []
  const sections = []
  const listeners = []
  const agents = []
  const writableRoots = []

  const makeTool = (name) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute(args) { return { path: args.file_path ?? args.command, args } },
  })

  for (const n of ['write', 'edit', 'apply_patch', 'pwsh', 'bash']) globals.set(n, makeTool(n))

  const sandboxPolicy = {
    resolve: () => ({ mode, workspaceRoot: 'C:\\ws' }),
    registerWritableRoot: (session, dir) => { writableRoots.push(dir); return () => {} },
  }

  const ctx = {
    tools: {
      get: (n) => globals.get(n),
      register: (def) => { registered.push(def); return () => {} },
    },
    agents: { list: () => agents },
    on: (event, handler) => { listeners.push({ event, handler }); return () => {} },
    inject: (names, fn) => {
      const child = {
        sandboxPolicy,
        systemPrompt: {
          getSectionOrder: () => 1200,
          section: (s) => { sections.push(s); return () => {} },
        },
      }
      fn(child)
      return () => {}
    },
    effect: (fn) => { const dispose = fn(); return () => dispose() },
    emit: async (event, payload) => { for (const l of listeners) if (l.event === event) await l.handler(payload) },
  }
  /** 真实 cordis 的 agent 上下文要先 inject 才能读 ctx.tools，这里照样模拟。 */
  const agentTools = {
    register: (def) => {
      registered.push(def)
      // 真实 ToolsService 注册后会发 tools/change；这里照样发，才能覆盖重入路径。
      for (const l of listeners) if (l.event === 'tools/change') l.handler()
      return () => {}
    },
  }
  const makeAgentCtx = () => ({
    inject: (names, fn) => { fn({ tools: agentTools }); return () => {} },
  })
  const agent = { ctx: makeAgentCtx(), session: { header: { cwd: 'C:\\ws' } } }
  agents.push(agent)
  return { ctx, registered, sections, agent, globals, makeAgentCtx, writableRoots, config: { ...SAFE, ...options.config } }
}

/** 装好插件并等一轮微任务，让 install 跑完。 */
async function boot(options) {
  const host = fakeHost(options)
  apply(host.ctx, host.config)
  // prepareAgent 里有一次真实的 mkdir，等它落地再断言。
  await new Promise(r => setTimeout(r, 20))
  return host
}

test('插件导出 name / inject / apply', () => {
  assert.equal(typeof apply, 'function')
})

test('apply 后只给 shell 工具装包装，文件工具不被覆盖', async () => {
  const host = await boot()
  const names = host.registered.map(d => d.name)
  assert.deepEqual(names.sort(), ['bash', 'pwsh'])
  for (const n of ['write', 'edit', 'apply_patch']) assert.equal(names.includes(n), false, n)
})

test('包装后的工具继承原定义的全部字段', async () => {
  const host = await boot()
  const wrapped = host.registered.find(d => d.name === 'pwsh')
  const original = host.globals.get('pwsh')
  assert.equal(wrapped.description, original.description)
  assert.deepEqual(wrapped.parameters, original.parameters)
  assert.equal(typeof wrapped.execute, 'function')
  assert.notEqual(wrapped.execute, original.execute)
})

test('pwsh 命令串被注入 TMP/TEMP', async () => {
  const host = await boot()
  const wrapped = host.registered.find(d => d.name === 'pwsh')
  const out = await wrapped.execute({ command: 'Get-ChildItem' }, { agent: host.agent })
  assert.ok(out.path.includes("$env:TMP='" + SCRATCH + "'"), out.path)
  assert.ok(out.path.endsWith('Get-ChildItem'))
})

test('接管包管理器时把缓存目录也注入子进程', async () => {
  const host = await boot({ config: { runtimeCache: 'always' } })
  const wrapped = host.registered.find(d => d.name === 'pwsh')
  const out = await wrapped.execute({ command: 'pnpm install' }, { agent: host.agent })
  assert.ok(out.path.includes('npm_config_store_dir='), out.path)
  assert.ok(out.path.includes('BUN_INSTALL_CACHE_DIR='), out.path)
  assert.ok(out.path.includes('UV_CACHE_DIR='), out.path)
  assert.ok(out.path.includes('npm_config_cache='), out.path)
  assert.ok(out.path.endsWith('pnpm install'))
})

test('不接管包管理器时不注入缓存变量', async () => {
  const host = await boot()
  const wrapped = host.registered.find(d => d.name === 'pwsh')
  const out = await wrapped.execute({ command: 'pnpm install' }, { agent: host.agent })
  assert.equal(out.path.includes('pnpm_config_store_dir'), false, out.path)
})

test('workspace-write 下给 scratch 追加可写根', async () => {
  const host = await boot({ config: { grantProcessWrite: true } })
  const wrapped = host.registered.find(d => d.name === 'pwsh')
  await wrapped.execute({ command: 'Get-ChildItem' }, { agent: host.agent })
  assert.ok(host.writableRoots.some(dir => dir.toLowerCase() === SCRATCH.toLowerCase()),
    host.writableRoots.join(','))
})

test('read-only 下不注入环境', async () => {
  const host = await boot({ mode: 'read-only' })
  const shell = host.registered.find(d => d.name === 'pwsh')
  const shellOut = await shell.execute({ command: 'Get-ChildItem' }, { agent: host.agent })
  assert.equal(shellOut.path, 'Get-ChildItem')
})

test('系统提示 section 被注册且 order 紧跟 TOOL_WRITE', async () => {
  const host = await boot()
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].name, 'disk-cleanup')
  assert.equal(host.sections[0].order, 1201)
  const text = host.sections[0].text({ agent: host.agent })
  assert.ok(text.includes(SCRATCH), text)
})

test('read-only 下提示词 section 不产出文本', async () => {
  const host = await boot({ mode: 'read-only' })
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].text({ agent: host.agent }), '')
})

test('agent/created 事件给新 agent 也装上', async () => {
  const host = await boot()
  const before = host.registered.length
  const fresh = { ctx: host.makeAgentCtx(), session: { header: { cwd: 'C:\\ws' } } }
  await host.ctx.emit('agent/created', { agent: fresh })
  assert.equal(host.registered.length - before, 2)
})

test('同一个 agent 不会被装两次', async () => {
  const host = await boot()
  const before = host.registered.length
  await host.ctx.emit('agent/created', { agent: host.agent })
  assert.equal(host.registered.length, before)
})

test('enabled=false 时什么都不做', async () => {
  const host = await boot({ config: { enabled: false } })
  assert.equal(host.registered.length, 0)
  assert.equal(host.sections.length, 0)
})

test('注册包装触发的 tools/change 不会导致重复注册', async () => {
  const host = await boot()
  await new Promise(r => setImmediate(r))
  const names = host.registered.map(d => d.name)
  assert.equal(names.length, 2, '每个工具只该注册一次，实际: ' + names.join(','))
  assert.deepEqual(names.slice().sort(), ['bash', 'pwsh'])
})

test('目标工具晚注册时由 tools/change 补装', async () => {
  const host = fakeHost()
  // 先摘掉 bash，模拟插件加载顺序靠后。
  const removed = host.globals.get('bash')
  host.globals.delete('bash')
  apply(host.ctx, host.config)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(host.registered.map(d => d.name).sort(), ['pwsh'])
  // 工具后来才注册，再发一次 tools/change
  host.globals.set('bash', removed)
  host.ctx.emit('tools/change', {})
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  const names = host.registered.map(d => d.name)
  assert.deepEqual(names.slice().sort(), ['bash', 'pwsh'])
  assert.equal(names.length, 2, '补装不该重复注册已装过的: ' + names.join(','))
})
test('read-only 下不创建 scratch 目录', async () => {
  const prev = process.env.DSH_HOME
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-disk-cleanup-ro-'))
  process.env.DSH_HOME = fresh
  try {
    const host = await boot({ mode: 'read-only' })
    const wrapped = host.registered.find(d => d.name === 'pwsh')
    await wrapped.execute({ command: 'Get-ChildItem' }, { agent: host.agent })
    assert.equal(existsSync(join(fresh, 'cache')), false, '只读模式不该在缓存目录留下任何东西')
  } finally {
    process.env.DSH_HOME = prev
    rmSync(fresh, { recursive: true, force: true })
  }
})

test('会话创建时就建好 scratch，不依赖 shell 命令执行', async () => {
  const prev = process.env.DSH_HOME
  const fresh = mkdtempSync(join(tmpdir(), 'dsh-disk-cleanup-eager-'))
  process.env.DSH_HOME = fresh
  try {
    const host = await boot()
    assert.equal(host.registered.length, 2)
    assert.equal(existsSync(join(fresh, 'cache', 'scratch')), true, '会话创建时就该建好 scratch')
    assert.ok(host.writableRoots.some(dir => dir.toLowerCase() === join(fresh, 'cache', 'scratch').toLowerCase()),
      '不执行 shell 命令也该登记可写根: ' + host.writableRoots.join(','))
  } finally {
    process.env.DSH_HOME = prev
    rmSync(fresh, { recursive: true, force: true })
  }
})

test('文件工具路径：不执行 shell 也已登记可写根', async () => {
  const host = await boot({ config: { grantProcessWrite: false } })
  assert.ok(host.writableRoots.some(dir => dir.toLowerCase() === SCRATCH.toLowerCase()),
    '文件工具不经过 shell 包装，必须在会话创建时登记: ' + host.writableRoots.join(','))
})

test('read-only 下不登记可写根', async () => {
  const host = await boot({ mode: 'read-only', config: { grantProcessWrite: false } })
  assert.equal(host.writableRoots.length, 0, host.writableRoots.join(','))
})
