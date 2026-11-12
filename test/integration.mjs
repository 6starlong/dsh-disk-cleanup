/**
 * 集成冒烟：用真实的 cordis + ToolsService + SystemPromptService 跑一遍，
 * 验证同名工具覆盖在真实的注册校验（output.schema 等）下成立。
 *
 * 需要 DSH 运行时：设 DSH_ASAR_ROOT 指向安装目录的
 * resources/app.asar/dsh/node_modules/@deepseek-ai/。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asarBase, repoUrl, recorder } from './_helpers.mjs'

// scratch 位置由 DSH_HOME 决定；测试把它指到临时目录，不碰真实缓存。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-disk-cleanup-integration-'))
process.env.DSH_HOME = HOME

const SCRATCH = join(HOME, 'cache', 'scratch')

const ASAR = asarBase()
const { Context } = await import(ASAR + 'cordis/lib/index.js')
const { scopeOf, createScope } = await import(ASAR + 'dsh-scope/lib/index.js')
const SystemPromptService = (await import(ASAR + 'dsh-system-prompt/lib/index.js')).default
const ToolsService = (await import(ASAR + 'dsh-tools/lib/index.js')).default
const { apply } = await import(repoUrl('lib/index.js'))

const { check, finish } = recorder()

const ctx = new Context()
await ctx.plugin(SystemPromptService)
await ctx.plugin(ToolsService)

// 假的外部服务：真 DSH 里由对应插件提供。
const writableRoots = []
ctx.provide('sandboxPolicy')
ctx.set('sandboxPolicy', {
  resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'C:\\ws' }),
  registerWritableRoot: (session, dir) => { writableRoots.push(dir); return () => {} },
})
ctx.provide('agents')
ctx.set('agents', { list: () => [] })

// 一个尽量真的全局 write 定义：schema 走真实校验路径。
const original = {
  name: 'write',
  description: 'original write',
  parameters: {
    type: 'object',
    properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    required: ['file_path', 'content'],
  },
  output: {
    schema: { type: 'object', properties: { path: { type: 'string' } } },
    render: () => [{ type: 'text', text: 'ok' }],
  },
  async execute(args) { return { path: args.file_path } },
}
ctx.tools.register(original)

// 造一个 agent 作用域上下文（真实 scope 层）。
const scope = createScope(ctx, {})
const agent = { ctx: scope.ctx, session: { header: { cwd: 'C:\\ws' } } }

apply(ctx, { grantProcessWrite: true, runtimeCache: 'never' })
await ctx.emit('agent/created', { agent })

const key = scopeOf(agent.ctx)
const shadowed = ctx.tools.get('write', key)
check('作用域里拿到了被覆盖的 write', shadowed !== undefined && shadowed.execute !== original.execute)
check('全局 write 未被改动', ctx.tools.get('write').execute === original.execute)

const out = await shadowed.execute({ file_path: 'probe.ps1', content: 'x' }, { agent })
check('裸脚本名被改到 DSH_HOME 下的 scratch', String(out.path).toLowerCase() === join(SCRATCH, 'probe.ps1').toLowerCase(), out.path)

const out2 = await shadowed.execute({ file_path: 'report.md', content: 'x' }, { agent })
check('产物文件落点不变', out2.path === 'report.md', out2.path)

const out3 = await shadowed.execute({ file_path: 'src/main.ts', content: 'x' }, { agent })
check('带目录相对路径不变', out3.path === 'src/main.ts', out3.path)

check('覆盖后参数 schema 保留', JSON.stringify(shadowed.parameters) === JSON.stringify(original.parameters))
check('scratch 被注册成可写根', writableRoots.some(dir => dir.toLowerCase() === SCRATCH.toLowerCase()), writableRoots.join(','))

finish()
await scope.dispose()
rmSync(HOME, { recursive: true, force: true })