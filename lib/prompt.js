/**
 * 系统提示里那一段说明（软约束，配合硬机制用）。
 * @module dsh-disk-cleanup/prompt
 */
import { dshHome } from './scratch.js'

/**
 * 生成提示文本。刻意写成规则而不是绝对路径，因为路径随权限模式变化。
 * @returns {string} 一段提示。
 */
export function scratchPromptText() {
  const cacheScratch = 'cache/scratch'
  return [
    `Temporary files (probe scripts, one-off checks, scratch drafts) belong in ${cacheScratch}/ — a bare script filename such as \`probe.ps1\` is redirected there automatically, and the shell's TMP/TEMP already point at the scratch directory.`,
    'Files the user asked for stay in the workspace: give them a real relative path (for example src/main.ts or report.md) and they are written exactly where you say.',
    `Under full file access the scratch directory moves to ${dshHome()}\\cache\\scratch.`,
  ].join(' ')
}
