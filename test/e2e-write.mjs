/**
 * 端到端：真实的 LocalFileSystem + 真实 write 工具 + 本插件，跑一次真写入。
 *
 * 需要 DSH 运行时：设 DSH_ASAR_ROOT。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
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

const BASE = tempDir('write')
const WS = join(BASE, 'workspace')
mkdirSync(WS, { recursive: true })

const { check, finish } = recorder()

const ctx = new Context()
await ctx.plugin(SystemPromptService)
await ctx.plugin(ToolsService)
// LocalFileSystem 是 Service，构造时自己 provide('fs')。
new LocalFileSystem(ctx, { cwd: WS, diffBasisMaxBytes: 1048576 })
ctx.provide('workingDirectory')
ctx.set('workingDirectory', { ensure: async () => WS, get: () => WS, contextText: () => 'Current working directory: "' + WS + '".' })
ctx.provide('sandboxPolicy')
ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WS }) })
ctx.provide('agents')
ctx.set('agents', { list: () => [] })

// 真实的 write / edit 工具；配置需要完整数值（插件加载时由 schema 补默认值）。
toolFs.apply(ctx, {
  read: false, readImage: false, write: true, edit: true, applyPatch: false,
  readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 51200, readStreamMinSize: 262144,
})

apply(ctx, undefined)
const scope = createScope(ctx, {})
const agent = { ctx: scope.ctx, session: { header: { cwd: WS } } }
await ctx.emit('agent/created', { agent })

const key = scopeOf(agent.ctx)
const write = ctx.tools.get('write', key)
check('作用域里的 write 是包装后的', write !== undefined)

const exec = { agent, callId: 'c1', name: 'write', arguments: {}, signal: new AbortController().signal }

// 1) 裸脚本名 → 落到 cache/scratch
const r1 = await write.execute({ file_path: 'probe.ps1', content: 'Write-Host hi' }, exec)
const expected = join(WS, 'cache', 'scratch', 'probe.ps1')
check('裸脚本名落到 cache/scratch', r1.path.toLowerCase() === expected.toLowerCase(), r1.path)
check('文件真的存在', existsSync(expected))
check('工作区根没有多出 probe.ps1', !existsSync(join(WS, 'probe.ps1')))

// 2) 产物文件 → 原地
const r2 = await write.execute({ file_path: 'report.md', content: '# hi' }, exec)
check('产物文件留在工作区', existsSync(join(WS, 'report.md')), r2.path)

// 3) 带目录的相对路径 → 原地
const r3 = await write.execute({ file_path: 'src/main.ts', content: 'export {}' }, exec)
check('带目录相对路径留在工作区', existsSync(join(WS, 'src', 'main.ts')), r3.path)

// 4) 连续两次写同一个裸脚本名 → 都落 scratch，不来回跳
await write.execute({ file_path: 'keep.ps1', content: 'first' }, exec)
const r4 = await write.execute({ file_path: 'keep.ps1', content: 'second' }, exec)
check('同一裸脚本名两次写都落 scratch', r4.path.toLowerCase() === join(WS, 'cache', 'scratch', 'keep.ps1').toLowerCase(), r4.path)

// 5) 工作区里已经存在的同名脚本不被搬走
writeFileSync(join(WS, 'deploy.ps1'), '# 已有脚本\n')
const r5 = await write.execute({ file_path: 'deploy.ps1', content: '# 更新\n' }, exec)
check('工作区已有同名脚本时不重定向', r5.path.toLowerCase() === join(WS, 'deploy.ps1').toLowerCase(), r5.path)
check('原文件被原地更新', readFileSync(join(WS, 'deploy.ps1'), 'utf8') === '# 更新\n')

// 6) 系统临时目录里的写入 → 搬到 scratch
const sysTemp = join(process.env.TEMP ?? process.env.TMP ?? WS, 'dsh-e2e-probe.ps1')
const r6 = await write.execute({ file_path: sysTemp, content: 'Write-Host tmp' }, exec)
check('系统临时目录的写入搬到 scratch', r6.path.toLowerCase() === join(WS, 'cache', 'scratch', 'dsh-e2e-probe.ps1').toLowerCase(), r6.path)

// 7) scratch 里的内容可读回
check('scratch 里的内容正确', readFileSync(expected, 'utf8') === 'Write-Host hi')

finish()
await scope.dispose()
rmSync(BASE, { recursive: true, force: true })
