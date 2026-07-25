// 配置加载与校验。配置文件默认 <工具根>/config.json,可用 --config 覆盖。
// 每次改道时按需重读(热更新),所以 loadConfig 每次读盘。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const VALID_PROTOCOLS = new Set(['openai-chat', 'openai-responses', 'anthropic-messages'])

/** 解析配置文件路径:显式 --config 优先,否则工具根目录 config.json */
export function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit)
  return path.join(ROOT, 'config.json')
}

/** 数据目录(存 CA 证书等),固定在工具根 .data/ 下 */
export function dataDir() {
  const dir = path.join(ROOT, '.data')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function rootDir() {
  return ROOT
}

/**
 * 读取并校验配置。抛错即致命配置错误(调用方负责打印并退出)。
 * 返回规范化后的配置对象。
 */
export function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `配置文件不存在: ${configPath}\n请复制 config.example.json 为 config.json 并填写你的中转站信息。`
    )
  }
  let raw
  try {
    raw = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8')))
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON: ${e.message}`)
  }

  const port = Number.isInteger(raw.port) ? raw.port : 8899
  const host = typeof raw.host === 'string' ? raw.host : '127.0.0.1'
  const upstreamProxy =
    typeof raw.upstreamProxy === 'string' && raw.upstreamProxy.trim()
      ? raw.upstreamProxy.trim()
      : null
  const mitmDomains =
    Array.isArray(raw.mitmDomains) && raw.mitmDomains.length ? raw.mitmDomains : ['kiro.dev']

  const stations = normalizeStations(raw.stations)
  const routes = normalizeRoutes(raw.routes, stations)

  return { port, host, upstreamProxy, mitmDomains, stations, routes, configPath }
}

function normalizeStations(stations) {
  if (!stations || typeof stations !== 'object') {
    throw new Error('配置缺少 stations(中转站列表)')
  }
  const out = {}
  for (const [id, s] of Object.entries(stations)) {
    if (id.startsWith('//')) continue // 跳过注释键
    if (!s || typeof s !== 'object') continue
    if (!VALID_PROTOCOLS.has(s.protocol)) {
      throw new Error(`中转站 "${id}" 的 protocol 非法: ${s.protocol}(应为 ${[...VALID_PROTOCOLS].join(' / ')})`)
    }
    if (!s.baseUrl || typeof s.baseUrl !== 'string') {
      throw new Error(`中转站 "${id}" 缺少 baseUrl`)
    }
    if (!s.apiKey || typeof s.apiKey !== 'string') {
      throw new Error(`中转站 "${id}" 缺少 apiKey`)
    }
    out[id] = {
      id,
      protocol: s.protocol,
      baseUrl: s.baseUrl.replace(/\/+$/, ''),
      apiKey: s.apiKey,
      headers: s.headers && typeof s.headers === 'object' ? s.headers : {}
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error('stations 里没有有效的中转站')
  }
  return out
}

function normalizeRoutes(routes, stations) {
  const r = routes && typeof routes === 'object' ? routes : {}
  const byModelId = {}
  if (r.byModelId && typeof r.byModelId === 'object') {
    for (const [modelId, route] of Object.entries(r.byModelId)) {
      if (modelId.startsWith('//')) continue
      const norm = normalizeRoute(route, stations, `byModelId["${modelId}"]`)
      if (norm) byModelId[modelId] = norm
    }
  }
  const def = r.default ? normalizeRoute(r.default, stations, 'default') : null
  return { default: def, byModelId }
}

function normalizeRoute(route, stations, label) {
  if (!route || typeof route !== 'object') return null
  if (!route.station || !stations[route.station]) {
    throw new Error(`路由 ${label} 指向不存在的中转站: ${route.station}`)
  }
  if (!route.model || typeof route.model !== 'string') {
    throw new Error(`路由 ${label} 缺少 model(中转站真实模型名)`)
  }
  const out = { station: route.station, model: route.model }
  if (route.maxTokens != null) {
    if (!Number.isInteger(route.maxTokens) || route.maxTokens <= 0) {
      throw new Error(`路由 ${label} 的 maxTokens 必须是正整数`)
    }
    out.maxTokens = route.maxTokens
  }
  if (route.model_reasoning_effort != null) {
    if (!['low', 'medium', 'high'].includes(route.model_reasoning_effort)) {
      throw new Error(`路由 ${label} 的 model_reasoning_effort 只能是 low / medium / high`)
    }
    out.model_reasoning_effort = route.model_reasoning_effort
  }
  if (route.showThinking != null) {
    if (typeof route.showThinking !== 'boolean') {
      throw new Error(`路由 ${label} 的 showThinking 必须是 true / false`)
    }
    out.showThinking = route.showThinking
  }
  if (route.maxContextTokens != null) {
    if (!Number.isInteger(route.maxContextTokens) || route.maxContextTokens <= 0) {
      throw new Error(`路由 ${label} 的 maxContextTokens 必须是正整数`)
    }
    out.maxContextTokens = route.maxContextTokens
  }
  return out
}

/**
 * 按 Kiro modelId 解析出目标中转站与模型名。
 * 优先精确匹配 byModelId,否则回退 default。都没有则返回 null(放行透传)。
 */
export function resolveRoute(config, modelId) {
  const byId = modelId && config.routes.byModelId[modelId]
  const route = byId || config.routes.default
  if (!route) return null
  const station = config.stations[route.station]
  if (!station) return null
  return {
    station,
    model: route.model,
    maxTokens: route.maxTokens,
    model_reasoning_effort: route.model_reasoning_effort,
    showThinking: route.showThinking,
    maxContextTokens: route.maxContextTokens
  }
}

// 去掉 JSON 里的 "// key": "..." 注释行不需要处理(它们是合法字符串键);
// 这里仅剥离行内 // 注释与块注释以宽容手写配置。保守起见只去整行 // 开头的行。
function stripJsonComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}
