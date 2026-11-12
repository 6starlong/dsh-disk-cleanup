import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件身份。 */
export declare const name: string
/** 必需服务。 */
export declare const inject: readonly string[]
/**
 * 插件入口。
 * @param ctx - 宿主上下文。
 * @param config - 插件配置。
 */
export declare function apply(ctx: Context, config?: unknown): void
