import { apply } from '../lib/index.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** 造一个足够真的假 ctx：记录注册了哪些工具、装了哪些 section。 */
function fakeHost() {
  const globals = new Map()
  const registered = []
  const sections = []
  const listeners = []
  const agents = []

  const makeTool = (name) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute(args) { return { path: args.file_path ?? args.command, args } },
  })

  for (const n of ['write', 'edit', 'apply_patch', 'pwsh', 'bash']) globals.set(n, makeTool(n))

  const ctx = {
    tools: {
      get: (n) => globals.get(n),
      register: (def) => { registered.push(def); return () => {} },
    },
    agents: { list: () => agents },
    on: (event, handler) => { listeners.push({ event, handler }); return () => {} },
    inject: (names, fn) => {
      const child = {
        sandboxPolicy: {
          resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:\\ws' }),
        },
        systemPrompt: {
          getSectionOrder: () => 1200,
          section: (s) => { sections.push(s); return () => {} },
        },
      }
      fn(child)
      return () => {}
    },
    emit: (event, payload) => { for (const l of listeners) if (l.event === event) l.handler(payload) },
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
  const agent = { ctx: makeAgentCtx() }
  agents.push(agent)
  return { ctx, registered, sections, agent, globals, makeAgentCtx }
}

test('插件导出 name / inject / apply', () => {
  assert.equal(typeof apply, 'function')
})

test('apply 后给已有 agent 装上五个包装工具', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const names = host.registered.map(d => d.name)
  assert.deepEqual(names.sort(), ['apply_patch', 'bash', 'edit', 'pwsh', 'write'])
})

test('包装后的工具继承原定义的全部字段', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const wrapped = host.registered.find(d => d.name === 'write')
  const original = host.globals.get('write')
  assert.equal(wrapped.description, original.description)
  assert.deepEqual(wrapped.parameters, original.parameters)
  assert.equal(typeof wrapped.execute, 'function')
  assert.notEqual(wrapped.execute, original.execute)
})

test('write 裸脚本名被改到工作区的 cache/scratch', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const wrapped = host.registered.find(d => d.name === 'write')
  const out = await wrapped.execute({ file_path: 'probe.ps1', content: 'x' }, { agent: host.agent })
  assert.ok(out.path.endsWith('cache\\scratch\\probe.ps1'), out.path)
})

test('write 产物类文件落点不变', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const wrapped = host.registered.find(d => d.name === 'write')
  const out = await wrapped.execute({ file_path: 'report.md', content: 'x' }, { agent: host.agent })
  assert.equal(out.path, 'report.md')
})

test('pwsh 命令串被注入 TMP/TEMP', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const wrapped = host.registered.find(d => d.name === 'pwsh')
  const out = await wrapped.execute({ command: 'Get-ChildItem' }, { agent: host.agent })
  assert.ok(out.path.startsWith("$env:TMP="), out.path)
  assert.ok(out.path.endsWith('Get-ChildItem'))
})

test('apply_patch 补丁里的裸脚本路径被改写', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const wrapped = host.registered.find(d => d.name === 'apply_patch')
  const patch = '*** Begin Patch\n*** Add File: probe.ps1\n+hi\n*** End Patch'
  const out = await wrapped.execute({ input: patch }, { agent: host.agent })
  assert.ok(out.args.input.includes('cache\\scratch\\probe.ps1'), out.args.input)
  assert.ok(out.args.input.includes('*** Add File: '))
})

test('apply_patch 全是不该动的路径时原文透传', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const wrapped = host.registered.find(d => d.name === 'apply_patch')
  const patch = '*** Begin Patch\n*** Add File: src/main.ts\n+x\n*** End Patch'
  const out = await wrapped.execute({ input: patch }, { agent: host.agent })
  assert.equal(out.args.input, patch)
})

test('系统提示 section 被注册且 order 紧跟 TOOL_WRITE', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].name, 'disk-cleanup')
  assert.equal(host.sections[0].order, 1201)
  assert.ok(host.sections[0].text.includes('cache/scratch'))
})

test('agent/created 事件给新 agent 也装上', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const before = host.registered.length
  const fresh = { ctx: host.makeAgentCtx() }
  await host.ctx.emit('agent/created', { agent: fresh })
  assert.equal(host.registered.length - before, 5)
})

test('同一个 agent 不会被装两次', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  const before = host.registered.length
  await host.ctx.emit('agent/created', { agent: host.agent })
  assert.equal(host.registered.length, before)
})

test('enabled=false 时什么都不做', async () => {
  const host = fakeHost()
  apply(host.ctx, { enabled: false })
  await new Promise(r => setImmediate(r))
  assert.equal(host.registered.length, 0)
  assert.equal(host.sections.length, 0)
})

test('注册包装触发的 tools/change 不会导致重复注册', async () => {
  const host = fakeHost()
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  const names = host.registered.map(d => d.name)
  assert.equal(names.length, 5, '每个工具只该注册一次，实际: ' + names.join(','))
  assert.deepEqual(names.slice().sort(), ['apply_patch', 'bash', 'edit', 'pwsh', 'write'])
})

test('目标工具晚注册时由 tools/change 补装', async () => {
  const host = fakeHost()
  // 先摘掉 edit 与 bash，模拟插件加载顺序靠后。
  const removed = new Map([['edit', host.globals.get('edit')], ['bash', host.globals.get('bash')]])
  host.globals.delete('edit')
  host.globals.delete('bash')
  apply(host.ctx, undefined)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(host.registered.map(d => d.name).sort(), ['apply_patch', 'pwsh', 'write'])
  // 工具后来才注册，再发一次 tools/change
  for (const [k, v] of removed) host.globals.set(k, v)
  host.ctx.emit('tools/change', {})
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  const names = host.registered.map(d => d.name)
  assert.deepEqual(names.slice().sort(), ['apply_patch', 'bash', 'edit', 'pwsh', 'write'])
  assert.equal(names.length, 5, '补装不该重复注册已装过的: ' + names.join(','))
})
