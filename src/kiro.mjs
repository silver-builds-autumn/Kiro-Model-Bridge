// Kiro 请求/响应编解码。
// decodeKiroRequest: Kiro conversationState → 统一中间表示(与 Provider 无关)
// encodeUnifiedEvent: 统一流事件 → Kiro AWS 事件流帧
// 从旧项目 bridge/requestDecoder.ts + responseEncoder.ts 移植。
import { encodeAssistantTextFrame, encodeToolUseFrame } from './eventstream.mjs'

// ============ 请求:Kiro → 统一 ============

function extractTools(tools) {
  if (!tools) return []
  const out = []
  for (const t of tools) {
    if (t && t.toolSpecification) {
      const schema = t.toolSpecification.inputSchema?.json
      out.push({
        name: t.toolSpecification.name,
        description: t.toolSpecification.description,
        inputSchema: schema && typeof schema === 'object' ? schema : {}
      })
    }
  }
  return out
}

function imageBlock(img) {
  return { type: 'image', mimeType: `image/${img.format || 'png'}`, data: img.source?.bytes || '' }
}

function toolResultText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((c) => c?.text || '').join('')
}

function userMsgToBlocks(m) {
  const blocks = []
  const toolResults = m.userInputMessageContext?.toolResults
  if (toolResults) {
    for (const tr of toolResults) {
      blocks.push({
        type: 'tool_result',
        toolUseId: tr.toolUseId,
        content: toolResultText(tr.content),
        ...(tr.status === 'error' ? { isError: true } : {})
      })
    }
  }
  for (const img of m.images ?? []) blocks.push(imageBlock(img))
  if (m.content) blocks.push({ type: 'text', text: m.content })
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

function assistantMsgToBlocks(content, toolUses) {
  const blocks = []
  if (content) blocks.push({ type: 'text', text: content })
  for (const tu of toolUses ?? []) {
    blocks.push({ type: 'tool_use', toolUseId: tu.toolUseId, name: tu.name, input: tu.input ?? {} })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

/** 解码 Kiro 推理请求为统一表示。payload 为已 JSON.parse 的请求体。 */
export function decodeKiroRequest(payload) {
  const cs = payload.conversationState
  if (!cs || !cs.currentMessage?.userInputMessage) {
    throw new Error('无效 Kiro 请求: 缺 conversationState.currentMessage.userInputMessage')
  }
  const current = cs.currentMessage.userInputMessage
  const messages = []
  for (const h of cs.history ?? []) {
    if (h.userInputMessage) {
      messages.push({ role: 'user', content: userMsgToBlocks(h.userInputMessage) })
    } else if (h.assistantResponseMessage) {
      messages.push({
        role: 'assistant',
        content: assistantMsgToBlocks(
          h.assistantResponseMessage.content,
          h.assistantResponseMessage.toolUses
        )
      })
    }
  }
  messages.push({ role: 'user', content: userMsgToBlocks(current) })

  const tools = extractTools(current.userInputMessageContext?.tools)
  const req = {
    modelId: current.modelId || 'unknown',
    messages,
    conversationId: cs.conversationId
  }
  if (tools.length) req.tools = tools
  if (payload.inferenceConfig?.maxTokens) req.maxTokens = payload.inferenceConfig.maxTokens
  return req
}

/** 从 payload 快速取 modelId(用于路由,不做完整解码) */
export function peekModelId(payload) {
  return payload?.conversationState?.currentMessage?.userInputMessage?.modelId
}

// ============ 响应:统一流事件 → Kiro 帧 ============

/**
 * 把单个统一流事件编码成 Kiro 帧。toolNames 记住 toolUseId→工具名。
 * 返回 null 表示该事件不产生帧(usage/done/error)。
 */
export function encodeUnifiedEvent(ev, toolNames, state = {}) {
  switch (ev.type) {
    case 'text_delta':
      // 思考结束、正文开始:补一个分隔标记
      if (state.showThinking && state.inThinking && ev.text) {
        state.inThinking = false
        return ev.text ? encodeAssistantTextFrame('\n\n---\n\n' + ev.text) : null
      }
      return ev.text ? encodeAssistantTextFrame(ev.text) : null
    case 'thinking_delta':
      if (!state.showThinking || !ev.text) return null
      // 首个思考增量前加个标题,让 Kiro 里能看出这是思考过程
      if (!state.inThinking) {
        state.inThinking = true
        return encodeAssistantTextFrame('> 🧠 思考中…\n\n' + ev.text)
      }
      return encodeAssistantTextFrame(ev.text)
    case 'tool_use_start':
      toolNames.set(ev.toolUseId, ev.name)
      return encodeToolUseFrame({ toolUseId: ev.toolUseId, name: ev.name, input: '', stop: false })
    case 'tool_args_delta':
      return encodeToolUseFrame({
        toolUseId: ev.toolUseId,
        name: toolNames.get(ev.toolUseId) || '',
        input: ev.delta,
        stop: false
      })
    case 'tool_use_stop':
      return encodeToolUseFrame({
        toolUseId: ev.toolUseId,
        name: toolNames.get(ev.toolUseId) || '',
        stop: true
      })
    default:
      return null
  }
}
