/**
 * 端到端：edit 与 apply_patch 的重定向（真实 LocalFileSystem + 真实工具）。
 *
 * 需要 DSH 运行时：设 DSH_ASAR_ROOT。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { asarBase, repoUrl, recorder, tempDir } from './_helpers.mjs'

const ASAR = asarBase()
const { Context } = await import(ASAR + 'cordis/lib/index.js')
const { scopeOf, createScope } = await import(ASAR + 'dsh-scope/lib/index.js')
const SystemPromptService = (await import(ASAR + 'dsh-system-prompt/lib/index.js')).default
const ToolsService = (await import(ASAR + 'dsh-tools/lib/index.js')).default
const LocalFileSystem = (await import(ASAR + 'dsh-fs-local/lib/index.js')).default
const toolFs = await import(ASAR + 'dsh-tool-fs/lib/index.js')
const { apply } = await import(repoUrl('lib/index.js'))

const BASE = tempDir('edit')
const WS = join(BASE, 'workspace')
mkdirSync(WS, { recursive: true })

const { check, finish } = recorder()

const ctx = new Context()
await ctx.plugin(SystemPromptService)
await ctx.plugin(ToolsService)
new LocalFileSystem(ctx, { cwd: WS, diffBasisMaxBytes: 1048576 })
ctx.provide('workingDirectory')
ctx.set('workingDirectory', { ensure: async () => WS, get: () => WS, contextText: () => 'Current working directory: "' + WS + '".' })
ctx.provide('sandboxPolicy')
ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WS }) })
ctx.provide('agents')
ctx.set('agents', { list: () => [] })

toolFs.apply(ctx, {
  read: false, readImage: false, write: true, edit: true, applyPatch: true,
  readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 262144,
})

apply(ctx, undefined)

const scope = createScope(ctx, {})
const agent = { ctx: scope.ctx, session: { header: { cwd: WS } } }
await ctx.emit('agent/created', { agent })

const key = scopeOf(agent.ctx)
const write = ctx.tools.get('write', key)
const edit = ctx.tools.get('edit', key)
const patch = ctx.tools.get('apply_patch', key)
check('三个包装都装上了', write !== undefined && edit !== undefined && patch !== undefined,
  [write, edit, patch].map(x => x === undefined ? 'missing' : 'ok').join(','))
const exec = { callId: 'c1', name: 'write', arguments: {}, agent, signal: new AbortController().signal }

const SCRATCH = join(WS, 'cache', 'scratch')

// 1) 先用 write 把脚本放进 scratch，再 edit 同一个裸名 → 改 scratch 那份
await write.execute({ file_path: 'probe.ps1', content: 'Write-Host one\n' }, exec)
const e1 = await edit.execute({ file_path: 'probe.ps1', old_string: 'one', new_string: 'two' }, exec)
check('edit 裸脚本名改到 scratch', e1.path.toLowerCase() === join(SCRATCH, 'probe.ps1').toLowerCase(), e1.path)
check('scratch 里的内容真的被改', readFileSync(join(SCRATCH, 'probe.ps1'), 'utf8').includes('two'))
check('工作区根没有 probe.ps1', !existsSync(join(WS, 'probe.ps1')))

// 2) edit 一个带目录的普通文件 → 不动
mkdirSync(join(WS, 'src'), { recursive: true })
await write.execute({ file_path: 'src/app.ts', content: 'const a = 1\n' }, exec)
const e2 = await edit.execute({ file_path: 'src/app.ts', old_string: '1', new_string: '2' }, exec)
check('带目录的文件 edit 落点不变', e2.path.toLowerCase() === join(WS, 'src', 'app.ts').toLowerCase(), e2.path)

// 3) apply_patch 加一个裸脚本名 → 改写进 scratch
await patch.execute({ input: '*** Begin Patch\n*** Add File: patchprobe.ps1\n+Write-Host patched\n*** End Patch' }, exec)
check('apply_patch 裸脚本名落 scratch', existsSync(join(SCRATCH, 'patchprobe.ps1')))
check('工作区根没有 patchprobe.ps1', !existsSync(join(WS, 'patchprobe.ps1')))
check('apply_patch 内容正确', readFileSync(join(SCRATCH, 'patchprobe.ps1'), 'utf8').includes('patched'))

// 4) apply_patch 改普通文件 → 落点不变
await patch.execute({ input: '*** Begin Patch\n*** Add File: src/notes.md\n+# hi\n*** End Patch' }, exec)
check('apply_patch 普通文件落工作区', existsSync(join(WS, 'src', 'notes.md')))

// 5) 全局工具没被污染
check('全局 write 未被改动', ctx.tools.get('write').execute !== write.execute)

finish()
rmSync(BASE, { recursive: true, force: true })
