/**
 * 探测本机装了哪些包管理器，并给出它们该用的缓存目录。
 * @module dsh-disk-cleanup/runtimes
 */
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Windows 上可执行文件的后缀表。 */
const EXECUTABLE_EXTS = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .map(item => item.trim())
  .filter(item => item !== '')

/**
 * 在 PATH 里找一个可执行文件。
 * @param {string} command - 命令名，不带后缀。
 * @param {NodeJS.ProcessEnv} [env] - 用于查找的环境变量，默认取当前进程。
 * @returns {string | undefined} 命中时返回绝对路径。
 */
export function findOnPath(command, env = process.env) {
  const raw = env.PATH ?? env.Path ?? ''
  const dirs = raw.split(delimiter).filter(dir => dir !== '')
  const suffixes = process.platform === 'win32' ? ['', ...EXECUTABLE_EXTS] : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        /* 不存在或不可执行，继续找 */
      }
    }
  }
  return undefined
}

/**
 * 受管的包管理器。env 把缓存根映射成该工具认的环境变量。
 * @type {ReadonlyArray<{name: string, commands: string[], env: (cacheRoot: string) => Record<string, string>}>}
 */
export const RUNTIMES = [
  {
    name: 'pnpm',
    commands: ['pnpm'],
    env: cacheRoot => ({
      pnpm_config_store_dir: join(cacheRoot, 'pnpm', 'store'),
      pnpm_config_cache_dir: join(cacheRoot, 'pnpm', 'cache'),
      pnpm_config_state_dir: join(cacheRoot, 'pnpm', 'state'),
    }),
  },
  {
    name: 'bun',
    commands: ['bun'],
    env: cacheRoot => ({
      BUN_INSTALL_CACHE_DIR: join(cacheRoot, 'bun', 'cache'),
    }),
  },
  {
    name: 'uv',
    commands: ['uv'],
    env: cacheRoot => ({
      UV_CACHE_DIR: join(cacheRoot, 'uv', 'cache'),
    }),
  },
  {
    name: 'npm',
    commands: ['npm'],
    env: cacheRoot => ({
      npm_config_cache: join(cacheRoot, 'npm', 'cache'),
    }),
  },
]

/**
 * 逐个探测包管理器是否已由用户自己安装（在 PATH 上）。
 * @param {NodeJS.ProcessEnv} [env] - 用于查找的环境变量。
 * @returns {Record<string, {present: boolean, path?: string}>} 按名字索引的探测结果。
 */
export function probeRuntimes(env = process.env) {
  const result = {}
  for (const runtime of RUNTIMES) {
    let found
    for (const command of runtime.commands) {
      found = findOnPath(command, env)
      if (found !== undefined) break
    }
    result[runtime.name] = found === undefined ? { present: false } : { present: true, path: found }
  }
  return result
}

/**
 * 决定哪些包管理器需要改缓存位置。
 * @param {'auto' | 'always' | 'never'} policy - auto 只接管用户没装的，always 全部接管，never 一个都不碰。
 * @param {Record<string, {present: boolean}>} probes - probeRuntimes 的结果。
 * @returns {Array<typeof RUNTIMES[number]>} 需要接管的条目。
 */
export function managedRuntimes(policy, probes) {
  if (policy === 'never') return []
  if (policy === 'always') return [...RUNTIMES]
  return RUNTIMES.filter(runtime => probes[runtime.name]?.present !== true)
}

/**
 * 生成需要注入给子进程的缓存环境变量。
 * @param {string} cacheRoot - 缓存根目录。
 * @param {Array<typeof RUNTIMES[number]>} managed - 需要接管的条目。
 * @returns {Record<string, string>} 环境变量表。
 */
export function runtimeCacheEnv(cacheRoot, managed) {
  const env = {}
  for (const runtime of managed) Object.assign(env, runtime.env(cacheRoot))
  return env
}

/**
 * 列出这些包管理器会用到的缓存目录（用于建目录与授权）。
 * @param {string} cacheRoot - 缓存根目录。
 * @param {Array<typeof RUNTIMES[number]>} managed - 需要接管的条目。
 * @returns {string[]} 目录列表。
 */
export function runtimeCacheDirs(cacheRoot, managed) {
  const dirs = new Set()
  for (const runtime of managed) {
    for (const value of Object.values(runtime.env(cacheRoot))) dirs.add(value)
  }
  return [...dirs]
}
