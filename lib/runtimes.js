/**
 * 探测本机装了哪些包管理器，并给出它们该用的缓存目录。
 * @module dsh-disk-cleanup/runtimes
 */
import { accessSync, constants, statSync } from 'node:fs'
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
 * 受管的包管理器。
 *
 * 两条判据都要能独立回答「用户是不是已经有自己的缓存」：
 * - `cacheVars`：该工具认的缓存环境变量，已经设了就别覆盖；
 * - `defaultCache`：没设环境变量时它会用的默认位置，存在说明用户在用它。
 *
 * 名字以 `npm_config_` 开头不是笔误：npm / pnpm / bun 都认这一套前缀
 * （配置键里的 `-` 写成 `_`），`pnpm_config_` 是无效前缀。
 * @type {ReadonlyArray<{name: string, commands: string[], cacheVars: string[], defaultCache: (env: NodeJS.ProcessEnv) => string | undefined, env: (cacheRoot: string) => Record<string, string>}>}
 */
export const RUNTIMES = [
  {
    name: 'pnpm',
    commands: ['pnpm'],
    cacheVars: ['npm_config_store_dir', 'npm_config_cache_dir', 'npm_config_state_dir'],
    defaultCache: env => env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'pnpm', 'store'),
    env: cacheRoot => ({
      npm_config_store_dir: join(cacheRoot, 'pnpm', 'store'),
      npm_config_cache_dir: join(cacheRoot, 'pnpm', 'cache'),
      npm_config_state_dir: join(cacheRoot, 'pnpm', 'state'),
    }),
  },
  {
    name: 'bun',
    commands: ['bun'],
    cacheVars: ['BUN_INSTALL_CACHE_DIR'],
    defaultCache: env => env.USERPROFILE === undefined ? undefined : join(env.USERPROFILE, '.bun', 'install', 'cache'),
    env: cacheRoot => ({
      BUN_INSTALL_CACHE_DIR: join(cacheRoot, 'bun', 'cache'),
    }),
  },
  {
    name: 'uv',
    commands: ['uv'],
    cacheVars: ['UV_CACHE_DIR'],
    defaultCache: env => env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'uv', 'cache'),
    env: cacheRoot => ({
      UV_CACHE_DIR: join(cacheRoot, 'uv', 'cache'),
    }),
  },
  {
    name: 'npm',
    commands: ['npm'],
    cacheVars: ['npm_config_cache'],
    defaultCache: env => env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'npm-cache'),
    env: cacheRoot => ({
      npm_config_cache: join(cacheRoot, 'npm', 'cache'),
    }),
  },
]

/**
 * 探测一个目录是否存在。
 * @param {string | undefined} path - 目标目录；探不出来位置时为 undefined。
 * @returns {boolean} 是否已经存在一个目录。
 */
function directoryExists(path) {
  if (path === undefined) return false
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 逐个探测包管理器在本机的状态。
 *
 * `present` 只看 PATH：命令跑不跑得起来。
 * `hasCache` 回答「用户是不是已经有自己的缓存」——环境变量设了，或默认位置已经存在。
 * 两者不等价：装了 npm 却没进 PATH 时 present 为假，缓存却真实存在。
 * @param {NodeJS.ProcessEnv} [env] - 用于查找的环境变量。
 * @returns {Record<string, {present: boolean, path?: string, hasCache: boolean, cachePath?: string}>} 按名字索引的探测结果。
 */
export function probeRuntimes(env = process.env) {
  const result = {}
  for (const runtime of RUNTIMES) {
    let found
    for (const command of runtime.commands) {
      found = findOnPath(command, env)
      if (found !== undefined) break
    }
    const fromEnv = runtime.cacheVars.find(name => {
      const value = env[name]
      return typeof value === 'string' && value !== ''
    })
    const cachePath = fromEnv === undefined ? runtime.defaultCache(env) : env[fromEnv]
    const hasCache = fromEnv !== undefined
      || (cachePath !== undefined && directoryExists(cachePath))
    result[runtime.name] = {
      ...found === undefined ? {} : { path: found },
      present: found !== undefined,
      hasCache,
      ...cachePath === undefined ? {} : { cachePath },
    }
  }
  return result
}

/**
 * 决定哪些包管理器需要改缓存位置。
 *
 * auto 的判据是「用户有没有现成的缓存」，不是「命令在不在 PATH」：
 * 有现成缓存的跳过，没有的才接管。命令在 PATH 上但没有任何缓存时接管是安全的，
 * 我们给的位置就是它第一次写缓存的地方。
 * @param {'auto' | 'always' | 'never'} policy - auto 只接管没有现成缓存的，always 全部接管，never 一个都不碰。
 * @param {Record<string, {hasCache?: boolean}>} probes - probeRuntimes 的结果。
 * @returns {Array<typeof RUNTIMES[number]>} 需要接管的条目。
 */
export function managedRuntimes(policy, probes) {
  if (policy === 'never') return []
  if (policy === 'always') return [...RUNTIMES]
  return RUNTIMES.filter(runtime => probes[runtime.name]?.hasCache !== true)
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
