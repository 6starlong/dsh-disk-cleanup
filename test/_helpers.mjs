/**
 * 测试用的小工具：路径解析与临时目录。
 *
 * 端到端测试要加载 DSH 运行时里的模块，那个位置随安装方式变化，
 * 所以由环境变量 DSH_ASAR_ROOT 指定（指向安装目录下的
 * resources/app.asar/dsh/node_modules/@deepseek-ai/）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 仓库根目录。 */
export const REPO_ROOT = new URL('../', import.meta.url)

/**
 * 仓库内的文件转成可 import 的 URL。
 * @param {string} relative - 相对仓库根的路径。
 * @returns {string} file:// URL。
 */
export function repoUrl(relative) {
  return new URL(relative, REPO_ROOT).href
}

/**
 * DSH 运行时模块的 URL 前缀。
 * @returns {string} 以斜杠结尾的 file:// URL。
 */
export function asarBase() {
  const root = process.env.DSH_ASAR_ROOT
  if (typeof root !== 'string' || root.trim() === '') {
    throw new Error('set DSH_ASAR_ROOT to <install>/resources/app.asar/dsh/node_modules/@deepseek-ai/')
  }
  let dir = root.trim().replace(/\\/g, '/')
  if (!dir.endsWith('/')) dir += '/'
  return pathToFileURL(dir).href
}

/**
 * 建一个本次测试专用的临时目录，退出时由调用方清理。
 * @param {string} tag - 目录名前缀里的标记。
 * @returns {string} 绝对路径。
 */
export function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), 'dsh-disk-cleanup-' + tag + '-'))
}

/**
 * 收集断言结果并统一输出。
 * @returns {{check: (label: string, ok: boolean, extra?: unknown) => void, finish: () => number}} 记录器。
 */
export function recorder() {
  const results = []
  const check = (label, ok, extra) => {
    results.push({ label, ok })
    console.log((ok ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' :: ' + extra))
  }
  const finish = () => {
    const failed = results.filter(r => !r.ok)
    console.log('')
    console.log(results.length + ' checks, ' + failed.length + ' failed')
    if (failed.length > 0) process.exitCode = 1
    return failed.length
  }
  return { check, finish }
}
