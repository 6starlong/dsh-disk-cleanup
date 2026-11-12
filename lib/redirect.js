/**
 * 纯判据：决定一次写入的路径要不要改到 scratch 目录。
 * 不做 I/O —— 存在性、cwd 都由调用方查好后传入，便于单测。
 * @module dsh-disk-cleanup/redirect
 */
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

/** 裸文件名视为「临时脚本」的扩展名。产物类（.md/.json/.txt/.csv）不在此列。 */
export const DEFAULT_SCRIPT_EXTENSIONS = [
  '.ps1', '.sh', '.bash', '.bat', '.cmd', '.py', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.lua',
]

/** 名字像项目入口的文件不重定向，避免搬走真实的 server.js / vite.config.ts。 */
export const DEFAULT_ENTRY_POINT_NAMES = [
  'index', 'main', 'server', 'app', 'cli', 'setup', 'package', 'tsconfig',
  'vite.config', 'rollup.config', 'webpack.config', 'jest.config', 'vitest.config',
  'eslint.config', 'tailwind.config', 'next.config', 'nuxt.config', 'svelte.config',
]

const WIN32 = process.platform === 'win32'

/**
 * 归一化路径用于比较：去掉 Windows 的 \\?\ 长路径前缀，绝对化，Windows 下统一小写。
 * @param {string} p - 待归一化的路径。
 * @returns {string} 可直接做前缀比较的字符串。
 */
export function normalizeForCompare(p) {
  let s = String(p)
  if (s.startsWith('\\\\?\\')) s = s.slice(4)
  s = resolve(s)
  return WIN32 ? s.toLowerCase() : s
}

/**
 * 判断 child 是否就是 parent 或位于其下。
 * @param {string} child - 被检查的路径。
 * @param {string} parent - 期望的父目录。
 * @returns {boolean} 是否包含。
 */
export function isUnder(child, parent) {
  if (!child || !parent) return false
  const c = normalizeForCompare(child)
  const p = normalizeForCompare(parent)
  if (c === p) return true
  const withSep = p.endsWith(sep) ? p : p + sep
  return c.startsWith(withSep)
}

/**
 * 去掉开头的 ./ 与 .\\ 前缀。
 * @param {string} p - 原始路径。
 * @returns {string} 去掉前缀后的路径。
 */
export function stripLeadingDot(p) {
  let s = String(p)
  while (s.startsWith('./') || s.startsWith('.\\')) s = s.slice(2)
  return s
}

/**
 * 判断路径是否带目录成分（任一斜杠）。
 * @param {string} p - 原始路径。
 * @returns {boolean} 是否带目录。
 */
export function hasDirPart(p) {
  const s = stripLeadingDot(p)
  return s.includes('/') || s.includes('\\')
}

/**
 * 决定一次文件写入要不要改落点。
 * @param {string} filePath - 模型给的路径（原样）。
 * @param {object} options - 判据所需的上下文。
 * @param {string} options.scratchDir - scratch 目录绝对路径。
 * @param {string} [options.workspaceRoot] - 工作区根，其内的绝对路径写入一律不动。
 * @param {string[]} [options.tempRoots] - 视为系统临时目录的绝对路径列表。
 * @param {'write' | 'edit'} [options.kind] - 哪个工具在写，决定存在性偏向。
 * @param {boolean} [options.workspaceHasFile] - 工作区里是否已有同名文件。
 * @param {boolean} [options.scratchHasFile] - scratch 里是否已有同名文件。
 * @param {boolean} [options.redirectSystemTemp] - 是否重定向系统临时目录里的写入。
 * @param {boolean} [options.redirectBareScripts] - 是否重定向裸文件名脚本。
 * @param {string[]} [options.scriptExtensions] - 脚本扩展名集合。
 * @param {string[]} [options.entryPointNames] - 不重定向的入口名集合。
 * @returns {{redirect: boolean, target?: string, reason: string}} 判定结果。
 */
export function classifyRedirect(filePath, options) {
  const {
    scratchDir,
    workspaceRoot,
    tempRoots = [],
    kind = 'write',
    workspaceHasFile = false,
    scratchHasFile = false,
    redirectSystemTemp = true,
    redirectBareScripts = true,
    scriptExtensions = DEFAULT_SCRIPT_EXTENSIONS,
    entryPointNames = DEFAULT_ENTRY_POINT_NAMES,
  } = options ?? {}

  if (!scratchDir) return { redirect: false, reason: 'no-scratch-dir' }
  if (typeof filePath !== 'string' || filePath.trim() === '') return { redirect: false, reason: 'empty-path' }

  if (isAbsolute(filePath)) {
    if (isUnder(filePath, scratchDir)) return { redirect: false, reason: 'already-in-scratch' }
    if (workspaceRoot && isUnder(filePath, workspaceRoot)) return { redirect: false, reason: 'inside-workspace' }
    if (redirectSystemTemp && tempRoots.some(root => isUnder(filePath, root))) {
      return { redirect: true, target: join(scratchDir, basename(filePath)), reason: 'system-temp' }
    }
    return { redirect: false, reason: 'explicit-absolute' }
  }

  if (hasDirPart(filePath)) return { redirect: false, reason: 'relative-with-directory' }
  if (!redirectBareScripts) return { redirect: false, reason: 'bare-scripts-disabled' }

  const name = stripLeadingDot(filePath)
  const ext = extname(name).toLowerCase()
  if (!scriptExtensions.some(candidate => candidate.toLowerCase() === ext)) {
    return { redirect: false, reason: 'not-a-script-extension' }
  }
  const stem = basename(name, extname(name)).toLowerCase()
  if (entryPointNames.some(candidate => candidate.toLowerCase() === stem)) {
    return { redirect: false, reason: 'entry-point-name' }
  }

  if (kind === 'edit') {
    if (scratchHasFile) return { redirect: true, target: join(scratchDir, name), reason: 'bare-script-in-scratch' }
    if (workspaceHasFile) return { redirect: false, reason: 'workspace-file' }
    return { redirect: true, target: join(scratchDir, name), reason: 'bare-script' }
  }

  if (workspaceHasFile) return { redirect: false, reason: 'workspace-file' }
  return { redirect: true, target: join(scratchDir, name), reason: 'bare-script' }
}

/** apply_patch 里带路径的行前缀。 */
export const PATCH_PATH_PREFIXES = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: ']

/**
 * 从补丁文本里抽出所有会被改写的目标路径。
 * @param {string} text - 整段补丁文本。
 * @returns {string[]} 去重后的路径列表，按出现顺序。
 */
export function patchPaths(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = []
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '')
    for (const prefix of PATCH_PATH_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        const value = trimmed.slice(prefix.length).trim()
        if (value !== '' && !found.includes(value)) found.push(value)
        break
      }
    }
  }
  return found
}

/**
 * 按给定映射重写补丁文本里的路径行，其余字节原样保留。
 * @param {string} text - 整段补丁文本。
 * @param {(path: string) => (string | undefined)} mapPath - 返回新路径，undefined 表示不改。
 * @returns {{text: string, changed: boolean, targets: string[]}} 重写结果。
 */
export function rewritePatchPaths(text, mapPath) {
  if (typeof text !== 'string' || text === '') return { text, changed: false, targets: [] }
  const targets = []
  let changed = false
  const out = text.split('\n').map((line) => {
    const carriage = line.endsWith('\r') ? '\r' : ''
    const body = carriage === '' ? line : line.slice(0, -1)
    for (const prefix of PATCH_PATH_PREFIXES) {
      if (!body.startsWith(prefix)) continue
      const value = body.slice(prefix.length).trim()
      const next = mapPath(value)
      if (next === undefined || next === value) return line
      targets.push(next)
      changed = true
      return prefix + next + carriage
    }
    return line
  }).join('\n')
  return { text: out, changed, targets }
}
