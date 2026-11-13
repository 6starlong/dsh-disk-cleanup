import type { Context } from '@deepseek-ai/cordis'

/** runtimeCache 的合法取值。 */
export type RuntimeCachePolicy = 'auto' | 'always' | 'never'

/** 插件配置（与 `cordis.patch.yml` 里的 config 一致，全部可省略）。 */
export interface Config {
  /** 关掉整个插件。默认 true。 */
  enabled?: boolean
  /** 自定义 scratch 目录；空串表示用 `<DSH_HOME>/cache/scratch`。 */
  scratchDir?: string
  /** 让 pwsh / bash 的 TMP / TEMP / TMPDIR 指向 scratch。默认 true。 */
  injectShellTemp?: boolean
  /** Windows 上给 scratch 补访问控制项，让受限子进程也能写。默认 true。 */
  grantProcessWrite?: boolean
  /** 包管理器缓存接管策略。默认 'auto'。 */
  runtimeCache?: RuntimeCachePolicy
  /** 往系统提示里加一段说明。默认 true。 */
  promptSection?: boolean
}

/** Cordis 插件身份。 */
export declare const name: string
/** 必需服务。 */
export declare const inject: readonly string[]
/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - 插件配置。
 */
export declare function apply(ctx: Context, config?: Config): void
