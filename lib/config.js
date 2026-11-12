/**
 * 配置解析与默认值。
 * @module dsh-disk-cleanup/config
 */
import { DEFAULT_SCRIPT_EXTENSIONS } from './redirect.js'

/** 默认配置。 */
export const DEFAULT_CONFIG = {
  enabled: true,
  scratchDir: '',
  redirectSystemTemp: true,
  redirectBareScripts: true,
  bareScriptExtensions: [...DEFAULT_SCRIPT_EXTENSIONS],
  injectShellTemp: true,
  grantProcessWrite: true,
  runtimeCache: 'auto',
  promptSection: true,
}

/** runtimeCache 的合法取值。 */
const RUNTIME_CACHE_POLICIES = ['auto', 'always', 'never']

/**
 * 把用户配置合并到默认值上，并做最小校验。
 * @param {unknown} raw - cordis.patch.yml 里的 config 对象。
 * @returns {typeof DEFAULT_CONFIG} 归一化后的配置。
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const text = (value, fallback) => (typeof value === 'string' ? value : fallback)
  const list = (value, fallback) => (Array.isArray(value) && value.every(item => typeof item === 'string') && value.length > 0
    ? value
    : fallback)
  const policy = RUNTIME_CACHE_POLICIES.includes(input.runtimeCache) ? input.runtimeCache : DEFAULT_CONFIG.runtimeCache
  return {
    enabled: bool(input.enabled, DEFAULT_CONFIG.enabled),
    scratchDir: text(input.scratchDir, DEFAULT_CONFIG.scratchDir).trim(),
    redirectSystemTemp: bool(input.redirectSystemTemp, DEFAULT_CONFIG.redirectSystemTemp),
    redirectBareScripts: bool(input.redirectBareScripts, DEFAULT_CONFIG.redirectBareScripts),
    bareScriptExtensions: list(input.bareScriptExtensions, DEFAULT_CONFIG.bareScriptExtensions),
    injectShellTemp: bool(input.injectShellTemp, DEFAULT_CONFIG.injectShellTemp),
    grantProcessWrite: bool(input.grantProcessWrite, DEFAULT_CONFIG.grantProcessWrite),
    runtimeCache: policy,
    promptSection: bool(input.promptSection, DEFAULT_CONFIG.promptSection),
  }
}
