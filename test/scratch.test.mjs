import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { scratchDirFor, dshHome, defaultTempRoots } from '../lib/scratch.js'
import { injectShellTemp, envPrefix, alreadySetsTemp } from '../lib/shell-env.js'
import { resolveConfig, DEFAULT_CONFIG } from '../lib/config.js'

test('workspace-write 用工作区里的 cache/scratch', () => {
  const dir = scratchDirFor({ mode: 'workspace-write', workspaceRoot: 'C:\\ws' })
  assert.equal(dir, join('C:\\ws', 'cache', 'scratch'))
})

test('danger-full-access 用 DSH_HOME/cache/scratch', () => {
  const dir = scratchDirFor({ mode: 'danger-full-access', workspaceRoot: 'C:\\ws' })
  assert.equal(dir, join(dshHome(), 'cache', 'scratch'))
})

test('read-only 不启用', () => {
  assert.equal(scratchDirFor({ mode: 'read-only', workspaceRoot: 'C:\\ws' }), undefined)
})

test('显式配置优先于模式推导', () => {
  const dir = scratchDirFor({ mode: 'danger-full-access', workspaceRoot: 'C:\\ws', configured: 'D:\\scratch' })
  assert.equal(dir, 'D:\\scratch')
})

test('没有 workspaceRoot 时退到 DSH_HOME', () => {
  const dir = scratchDirFor({ mode: 'workspace-write' })
  assert.equal(dir, join(dshHome(), 'cache', 'scratch'))
})

test('dshHome 尊重 DSH_HOME 环境变量', () => {
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\custom-home'
  try {
    assert.equal(dshHome(), 'C:\\custom-home')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('dshHome 缺省是 ~/.dsh', () => {
  const saved = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    assert.equal(dshHome(), join(homedir(), '.dsh'))
  } finally {
    if (saved !== undefined) process.env.DSH_HOME = saved
  }
})

test('defaultTempRoots 去重且非空', () => {
  const roots = defaultTempRoots()
  assert.ok(roots.length > 0)
  assert.equal(new Set(roots).size, roots.length)
})

test('pwsh 前缀注入 TMP 与 TEMP', () => {
  const out = injectShellTemp('pwsh', 'Get-ChildItem', 'C:\\scratch')
  assert.ok(out.startsWith("$env:TMP='C:\\scratch'; $env:TEMP='C:\\scratch'; "))
  assert.ok(out.endsWith('Get-ChildItem'))
})

test('bash 前缀注入 TMPDIR/TMP/TEMP', () => {
  const out = injectShellTemp('bash', 'ls -la', '/tmp/scratch')
  assert.equal(out, "export TMPDIR='/tmp/scratch' TMP='/tmp/scratch' TEMP='/tmp/scratch'; ls -la")
})

test('用户自己设了临时目录时不覆盖', () => {
  assert.equal(alreadySetsTemp('pwsh', '$env:TEMP = "D:\\t"; Get-ChildItem'), true)
  assert.equal(alreadySetsTemp('bash', 'export TMPDIR=/x; ls'), true)
  const cmd = '$env:TEMP = "D:\\t"; Get-ChildItem'
  assert.equal(injectShellTemp('pwsh', cmd, 'C:\\scratch'), cmd)
})

test('没有目录时原样返回', () => {
  assert.equal(injectShellTemp('pwsh', 'ls', undefined), 'ls')
  assert.equal(injectShellTemp('pwsh', 'ls', ''), 'ls')
})

test('路径里的单引号被转义', () => {
  const out = envPrefix('pwsh', "C:\\it's\\scratch")
  assert.ok(out.includes("C:\\it''s\\scratch"))
})

test('resolveConfig 用默认值补齐并拒绝错类型', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  const merged = resolveConfig({ enabled: false, scratchDir: '  D:\\s  ', redirectSystemTemp: 'yes', bareScriptExtensions: [] })
  assert.equal(merged.enabled, false)
  assert.equal(merged.scratchDir, 'D:\\s')
  assert.equal(merged.redirectSystemTemp, true)
  assert.deepEqual(merged.bareScriptExtensions, DEFAULT_CONFIG.bareScriptExtensions)
})
