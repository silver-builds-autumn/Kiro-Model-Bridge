// 改道编排:Kiro 请求 → 中转站 → 流式写回 Kiro 事件流帧。
// 串起 decodeKiroRequest → build{OpenAI,Anthropic}Request → fetch(经 upstream) → parseSSE → encodeUnifiedEvent。
import { ProxyAgent } from 'undici'
import { decodeKiroRequest, encodeUnifiedEvent } from './kiro.mjs'
import {
  buildOpenAIRequest,
  buildAnthropicRequest,
  createOpenAISSEParser,
  createAnthropicSSEParser
} from './providers.mjs'
import { log } from './logger.mjs'

// 复用 dispatcher(每个 upstream 一个),避免每请求新建连接池
const dispatcherCache = new Map()
function dispatcherFor(upstreamProxy) {
  if (!upstreamProxy) return undefined
  let d = dispatcherCache.get(upstreamProxy)
  if (!d) {
    d = new ProxyAgent(upstreamProxy)
    dispatcherCache.set(upstreamProxy, d)
  }
  return d
}

/** 按协议构造中转站请求 */
function buildProviderRequest(station, modelName, unified, opts) {
  const headers = { 'content-type': 'application/json', ...(station.headers || {}) }
  if (station.protocol === 'anthropic-messages') {
    headers['x-api-key'] = station.apiKey
    headers['anthropic-version'] = '2023-06-01'
    return {
      url: `${station.baseUrl}/v1/messages`,
      headers,
      body: JSON.stringify(buildAnthropicRequest(unified, modelName, opts)),
      parser: createAnthropicSSEParser()
    }
  }
  headers['authorization'] = `Bearer ${station.apiKey}`
  return {
    url: `${station.baseUrl}/v1/chat/completions`,
    headers,
    body: JSON.stringify(buildOpenAIRequest(unified, modelName, opts)),
    parser: createOpenAISSEParser()
  }
}

// 粗略 token 估算:按字符数 /4(足够用于裁剪判断,不求精确)
function estimateTokens(unified) {
  let chars = unified.system ? unified.system.length : 0
  for (const m of unified.messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length
      else if (b.type === 'tool_result') chars += (b.content || '').length
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input || {}).length
      else if (b.type === 'image') chars += 1600 // 图片按固定量估
    }
  }
  return Math.ceil(chars / 4)
}

/**
 * 按 maxContextTokens 裁剪旧历史:从最早的消息开始丢,直到估算 token 达标。
 * 始终保留最后一条(当前用户消息)。丢弃后若首条是悬空 tool_result 继续丢,
 * 避免 Anthropic 报「tool_result 无对应 tool_use」。返回被丢弃的条数。
 */
function trimHistory(unified, maxContextTokens) {
  if (!maxContextTokens) return 0
  let dropped = 0
  while (estimateTokens(unified) > maxContextTokens && unified.messages.length > 1) {
    unified.messages.shift()
    dropped++
    // 丢到首条不再是带 tool_result 的 user 为止(或只剩当前消息)
    while (
      unified.messages.length > 1 &&
      unified.messages[0].content.some((b) => b.type === 'tool_result')
    ) {
      unified.messages.shift()
      dropped++
    }
  }
  return dropped
}

/**
 * 执行一次改道。onFrame 每产生一段 Kiro 字节就回调。
 * @returns {Promise<{ok:boolean, status:number, error?:string, usage?:object}>}
 */
export async function runRelay(payload, station, modelName, upstreamProxy, onFrame, signal, opts = {}) {
  let unified
  try {
    unified = decodeKiroRequest(payload)
  } catch (e) {
    return { ok: false, status: 0, error: `解码 Kiro 请求失败: ${e.message}` }
  }

  if (opts.maxContextTokens) {
    const dropped = trimHistory(unified, opts.maxContextTokens)
    if (dropped) log.info('relay', `上下文超限,裁剪最早 ${dropped} 条历史(上限 ${opts.maxContextTokens} tokens)`)
  }

  const { url, headers, body, parser } = buildProviderRequest(station, modelName, unified, opts)
  const dispatcher = dispatcherFor(upstreamProxy)

  let resp
  try {
    resp = await fetch(url, { method: 'POST', headers, body, signal, dispatcher })
  } catch (e) {
    return { ok: false, status: 0, error: `连接中转站失败: ${e.message}` }
  }
  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.text()).slice(0, 500)
    } catch {
      /* ignore */
    }
    return { ok: false, status: resp.status, error: `中转站返回 ${resp.status}: ${detail}` }
  }
  if (!resp.body) return { ok: false, status: resp.status, error: '中转站响应无 body' }

  const toolNames = new Map()
  const encState = { showThinking: !!opts.showThinking, inThinking: false }
  let usage
  const emit = (events) => {
    for (const ev of events) {
      if (ev.type === 'usage') usage = ev
      const frame = encodeUnifiedEvent(ev, toolNames, encState)
      if (frame) onFrame(frame)
    }
  }

  const decoder = new TextDecoder()
  const reader = resp.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) emit(parser.push(decoder.decode(value, { stream: true })))
    }
    const tail = decoder.decode()
    if (tail) emit(parser.push(tail))
  } catch (e) {
    return { ok: false, status: resp.status, error: `读取中转站流失败: ${e.message}` }
  }
  return { ok: true, status: resp.status, usage }
}

export { log }
