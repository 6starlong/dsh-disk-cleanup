import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyRedirect,
  isUnder,
  hasDirPart,
  stripLeadingDot,
  patchPaths,
  rewritePatchPaths,
} from '../lib/redirect.js'

const scratch = resolve(tmpdir(), 'dsh-test-scratch')
const workspace = resolve(tmpdir(), 'dsh-test-ws')
const base = { scratchDir: scratch, workspaceRoot: workspace, tempRoots: [resolve(tmpdir())] }

test('裸脚本名重定向到 scratch', () => {
  const verdict = classifyRedirect('probe.ps1', base)
  assert.equal(verdict.redirect, true)
  assert.equal(verdict.target, join(scratch, 'probe.ps1'))
  assert.equal(verdict.reason, 'bare-script')
})

test('产物类扩展名不重定向', () => {
  for (const name of ['report.md', 'data.json', 'notes.txt', 'out.csv', 'index.html']) {
    const verdict = classifyRedirect(name, base)
    assert.equal(verdict.redirect, false, name)
    assert.equal(verdict.reason, 'not-a-script-extension')
  }
})

test('带目录的相对路径一律不动', () => {
  for (const name of ['src/main.js', 'cache/scratch/foo.ps1', '.scratch/x.py']) {
    const verdict = classifyRedirect(name, base)
    assert.equal(verdict.redirect, false, name)
    assert.equal(verdict.reason, 'relative-with-directory')
  }
})

test('项目入口名不重定向', () => {
  for (const name of ['server.js', 'main.py', 'vite.config.ts', 'index.mjs']) {
    const verdict = classifyRedirect(name, base)
    assert.equal(verdict.redirect, false, name)
    assert.equal(verdict.reason, 'entry-point-name')
  }
})

test('系统临时目录内的绝对路径改到 scratch', () => {
  const abs = join(resolve(tmpdir()), 'x.ps1')
  const verdict = classifyRedirect(abs, base)
  assert.equal(verdict.redirect, true)
  assert.equal(verdict.target, join(scratch, 'x.ps1'))
  assert.equal(verdict.reason, 'system-temp')
})

test('工作区内的绝对路径不动', () => {
  const abs = join(workspace, 'src', 'main.js')
  const verdict = classifyRedirect(abs, base)
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'inside-workspace')
})

test('scratch 内的写入不重复重定向', () => {
  const abs = join(scratch, 'probe.ps1')
  const verdict = classifyRedirect(abs, base)
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'already-in-scratch')
})

test('工作区外显式绝对路径不动', () => {
  const abs = resolve('/', 'opt', 'data', 'x.ps1')
  const verdict = classifyRedirect(abs, base)
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'explicit-absolute')
})

test('write 遇到工作区已有同名文件不动（可能是在改自己的产物）', () => {
  const verdict = classifyRedirect('probe.ps1', { ...base, kind: 'write', workspaceHasFile: true })
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'workspace-file')
})

test('edit 优先改 scratch 里已存在的那份', () => {
  const verdict = classifyRedirect('probe.ps1', { ...base, kind: 'edit', scratchHasFile: true, workspaceHasFile: true })
  assert.equal(verdict.redirect, true)
  assert.equal(verdict.reason, 'bare-script-in-scratch')
})

test('edit 只存在于工作区时不动', () => {
  const verdict = classifyRedirect('probe.ps1', { ...base, kind: 'edit', workspaceHasFile: true })
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'workspace-file')
})

test('没有 scratch 目录时全部不动', () => {
  const verdict = classifyRedirect('probe.ps1', { ...base, scratchDir: undefined })
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'no-scratch-dir')
})

test('关闭裸脚本重定向后不动', () => {
  const verdict = classifyRedirect('probe.ps1', { ...base, redirectBareScripts: false })
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'bare-scripts-disabled')
})

test('关闭系统临时目录重定向后不动', () => {
  const abs = join(resolve(tmpdir()), 'x.ps1')
  const verdict = classifyRedirect(abs, { ...base, redirectSystemTemp: false })
  assert.equal(verdict.redirect, false)
  assert.equal(verdict.reason, 'explicit-absolute')
})

test('isUnder 处理大小写与尾部斜杠', () => {
  assert.equal(isUnder(join(workspace, 'a', 'b.txt'), workspace), true)
  assert.equal(isUnder(workspace, workspace), true)
  assert.equal(isUnder(workspace + '-other', workspace), false)
})

test('hasDirPart 与 stripLeadingDot', () => {
  assert.equal(hasDirPart('a/b.txt'), true)
  assert.equal(hasDirPart('a\\b.txt'), true)
  assert.equal(hasDirPart('./a.txt'), false)
  assert.equal(stripLeadingDot('./probe.ps1'), 'probe.ps1')
})

test('patchPaths 抽出四类路径行', () => {
  const text = [
    '*** Begin Patch',
    '*** Add File: probe.ps1',
    '+hello',
    '*** Update File: src/main.js',
    '@@',
    '*** Move to: moved.py',
    '*** Delete File: old.sh',
    '*** End Patch',
  ].join('\n')
  assert.deepEqual(patchPaths(text), ['probe.ps1', 'src/main.js', 'moved.py', 'old.sh'])
})

test('rewritePatchPaths 只改命中的行并保留其余字节', () => {
  const text = '*** Begin Patch\n*** Add File: probe.ps1\n+hello\n*** End Patch'
  const out = rewritePatchPaths(text, p => (p === 'probe.ps1' ? 'C:/scratch/probe.ps1' : undefined))
  assert.equal(out.changed, true)
  assert.equal(out.text, '*** Begin Patch\n*** Add File: C:/scratch/probe.ps1\n+hello\n*** End Patch')
})

test('rewritePatchPaths 无命中时原文返回', () => {
  const text = '*** Begin Patch\n*** Add File: src/main.js\n*** End Patch'
  const out = rewritePatchPaths(text, () => undefined)
  assert.equal(out.changed, false)
  assert.equal(out.text, text)
})
