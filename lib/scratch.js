/**
 * 权限模式 → scratch 目录；目录创建。
 * @module dsh-disk-cleanup/scratch
 */
import { mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 解析 DSH 的 home 目录：优先环境变量 DSH_HOME，否则 ~/.dsh。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 系统临时目录列表（去重）。插件跑在宿主进程里，环境变量是完整的。
 * @returns {string[]} 绝对路径列表。
 */
export function defaultTempRoots() {
  const roots = []
  const push = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return
    const trimmed = value.trim()
    if (!roots.includes(trimmed)) roots.push(trimmed)
  }
  try { push(tmpdir()) } catch { /* 环境变量缺失时忽略 */ }
  push(process.env.TEMP)
  push(process.env.TMP)
  return roots
}

/**
 * 按权限模式给出 scratch 目录。
 * @param {object} options - 解析输入。
 * @param {string} [options.mode] - 沙箱模式：workspace-write / danger-full-access / read-only。
 * @param {string} [options.workspaceRoot] - 会话工作区根。
 * @param {string} [options.configured] - 配置里显式指定的目录，优先于模式推导。
 * @returns {string | undefined} 绝对路径；read-only 或无可用根时返回 undefined。
 */
export function scratchDirFor({ mode, workspaceRoot, configured } = {}) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (mode === 'read-only') return undefined
  if (mode === 'danger-full-access') return join(dshHome(), 'cache', 'scratch')
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '') {
    return join(workspaceRoot, 'cache', 'scratch')
  }
  return join(dshHome(), 'cache', 'scratch')
}

/**
 * 确保目录存在（幂等）。
 * @param {string} dir - 目录绝对路径。
 * @returns {Promise<void>} 完成信号。
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}
