// 极简终端日志。带时间戳与彩色标签。tag 用于区分子系统(proxy/relay/cert/http)。
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}

function ts() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function line(color, level, tag, msg) {
  const t = `${COLORS.gray}${ts()}${COLORS.reset}`
  const l = `${color}${level.padEnd(5)}${COLORS.reset}`
  const g = `${COLORS.cyan}[${tag}]${COLORS.reset}`
  return `${t} ${l} ${g} ${msg}`
}

export const log = {
  info: (tag, msg) => console.log(line(COLORS.blue, 'INFO', tag, msg)),
  ok: (tag, msg) => console.log(line(COLORS.green, 'OK', tag, msg)),
  warn: (tag, msg) => console.warn(line(COLORS.yellow, 'WARN', tag, msg)),
  error: (tag, msg) => console.error(line(COLORS.red, 'ERROR', tag, msg)),
  debug: (tag, msg) => {
    if (process.env.KIRO_RELAY_DEBUG) console.log(line(COLORS.gray, 'DEBUG', tag, msg))
  }
}
