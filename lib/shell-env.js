/**
 * 往 pwsh / bash 的命令串前注入临时目录环境变量，
 * 让脚本里的临时目录 API 默认落在 scratch。
 * @module dsh-disk-cleanup/shell-env
 */

/**
 * 单引号包裹并转义，供 pwsh 与 bash 共用。
 * @param {string} value - 原始字符串。
 * @param {'pwsh' | 'bash'} shell - 目标 shell。
 * @returns {string} 已加引号的字面量。
 */
export function quote(value, shell) {
  if (shell === 'pwsh') return `'${String(value).replace(/'/g, "''")}'`
  return `'${String(value).replace(/'/g, "'\\\\''")}'`
}

/**
 * 生成环境变量赋值前缀。
 * @param {'pwsh' | 'bash'} shell - 目标 shell。
 * @param {string} dir - 临时目录绝对路径。
 * @returns {string} 可直接拼在命令前的字符串。
 */
export function envPrefix(shell, dir) {
  if (shell === 'pwsh') {
    const q = quote(dir, 'pwsh')
    return `$env:TMP=${q}; $env:TEMP=${q}; `
  }
  const q = quote(dir, 'bash')
  return `export TMPDIR=${q} TMP=${q} TEMP=${q}; `
}

/**
 * 判断命令串是否自己设置过临时目录（用户显式指定时不覆盖）。
 * @param {'pwsh' | 'bash'} shell - 目标 shell。
 * @param {string} command - 原始命令串。
 * @returns {boolean} 是否已自行设置。
 */
export function alreadySetsTemp(shell, command) {
  if (typeof command !== 'string') return false
  if (shell === 'pwsh') return /\$env:(?:TMP|TEMP)\s*=/i.test(command)
  return /(?:^|[;&|(\s])(?:export\s+)?(?:TMPDIR|TMP|TEMP)\s*=/i.test(command)
}

/**
 * 给命令串注入临时目录前缀。
 * @param {'pwsh' | 'bash'} shell - 目标 shell。
 * @param {string} command - 原始命令串。
 * @param {string | undefined} dir - 临时目录；为空表示本次不注入。
 * @returns {string} 注入后的命令串（不需要注入时原样返回）。
 */
export function injectShellTemp(shell, command, dir) {
  if (typeof command !== 'string' || command === '') return command
  if (typeof dir !== 'string' || dir === '') return command
  if (alreadySetsTemp(shell, command)) return command
  return envPrefix(shell, dir) + command
}
