/**
 * 系统提示里那一段说明（软约束，配合硬机制用）。
 * @module dsh-disk-cleanup/prompt
 */

/**
 * 生成提示文本。
 * @param {object} options - 生成输入。
 * @param {string} [options.scratchDir] - 当前会话的 scratch 目录。
 * @param {string[]} [options.cacheDirs] - 被接管的依赖缓存目录。
 * @returns {string} 一段提示。
 */
export function scratchPromptText({ scratchDir, cacheDirs = [] } = {}) {
  const lines = [
    'Write temporary files (probe scripts, one-off checks, scratch drafts) to the scratch directory'
      + (scratchDir === undefined ? '' : ` (${scratchDir})`)
      + ': the shell\'s TMP/TEMP point there.',
    'Files the user asked for stay in the workspace: give them a real relative path (for example src/main.ts or report.md) and they are written exactly where you say.',
  ]
  if (cacheDirs.length > 0) {
    lines.push(`Package-manager caches are configured under ${cacheDirs.length === 1 ? cacheDirs[0] : cacheDirs.join(', ')}: installs put their global store outside the workspace. Files a project generates itself, such as node_modules or .venv, still belong in the project directory.`)
  }
  return lines.join(' ')
}
