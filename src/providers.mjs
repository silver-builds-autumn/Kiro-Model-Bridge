// Provider 适配器:统一表示 ↔ OpenAI Chat / Anthropic Messages,及其 SSE 流解析。
// 从旧项目 bridge/providers/{sse,openai,anthropic}.ts 合并移植。

// ============ 增量 SSE 行解析 ============
class SSELineParser {
  constructor() {
    this.buf = ''
  }
  feed(chunk, onData) {
    this.buf += chunk
    let idx
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.startsWith('data:')) onData(line.slice(5).replace(/^ /, ''))
    }
  }
}

// ============ OpenAI:请求构造 ============
function blocksToOpenAIMessages(role, blocks) {
  const out = []
  const toolResults = blocks.filter((b) => b.type === 'tool_result')
  for (const tr of toolResults) {
    out.push({ role: 'tool', tool_call_id: tr.toolUseId, content: tr.content })
  }
  const textParts = blocks.filter((b) => b.type === 'text')
  const images = blocks.filter((b) => b.type === 'image')
  const toolUses = blocks.filter((b) => b.type === 'tool_use')

  if (role === 'assistant') {
    const msg = { role: 'assistant', content: textParts.map((t) => t.text).join('') }
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((tu) => ({
        id: tu.toolUseId,
        type: 'function',
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) }
      }))
      if (!msg.content) msg.content = ''
    }
    out.push(msg)
  } else if (role === 'user') {
    if (images.length) {
      const parts = []
      for (const t of textParts) parts.push({ type: 'text', text: t.text })
      for (const img of images)
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })
      out.push({ role: 'user', content: parts })
    } else if (textParts.length || out.length === 0) {
      out.push({ role: 'user', content: textParts.map((t) => t.text).join('') })
    }
  } else if (role === 'system') {
    out.push({ role: 'system', content: textParts.map((t) => t.text).join('') })
  }
  return out
}

export function buildOpenAIRequest(req, modelName, opts = {}) {
  const messages = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) messages.push(...blocksToOpenAIMessages(m.role, m.content))
  const body = { model: modelName, messages, stream: true }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema }
    }))
  }
  const maxTokens = opts.maxTokens ?? req.maxTokens
  if (maxTokens) body.max_tokens = maxTokens
  // 思考强度:OpenAI 系推理模型走 reasoning_effort(low/medium/high)
  if (opts.model_reasoning_effort) body.reasoning_effort = opts.model_reasoning_effort
  return body
}

// ============ OpenAI:SSE 解析 ============
export function createOpenAISSEParser() {
  const line = new SSELineParser()
  const toolByIndex = new Map()
  return {
    push(chunk) {
      const out = []
      line.feed(chunk, (data) => {
        if (data === '[DONE]') {
          out.push({ type: 'done' })
          return
        }
        let obj
        try {
          obj = JSON.parse(data)
        } catch {
          return
        }
        const choice = obj.choices?.[0]
        // 思考增量:不同中转站字段名不一(reasoning_content / reasoning)
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
        if (reasoning) out.push({ type: 'thinking_delta', text: reasoning })
        if (choice?.delta?.content) out.push({ type: 'text_delta', text: choice.delta.content })
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const acc = toolByIndex.get(tc.index)
            if (!acc) {
              const id = tc.id || `call_${tc.index}`
              toolByIndex.set(tc.index, { id })
              out.push({ type: 'tool_use_start', toolUseId: id, name: tc.function?.name || '' })
              if (tc.function?.arguments)
                out.push({ type: 'tool_args_delta', toolUseId: id, delta: tc.function.arguments })
            } else if (tc.function?.arguments) {
              out.push({ type: 'tool_args_delta', toolUseId: acc.id, delta: tc.function.arguments })
            }
          }
        }
        if (obj.usage) {
          out.push({
            type: 'usage',
            inputTokens: obj.usage.prompt_tokens,
            outputTokens: obj.usage.completion_tokens,
            totalTokens: obj.usage.total_tokens
          })
        }
        if (choice?.finish_reason) {
          for (const acc of toolByIndex.values()) out.push({ type: 'tool_use_stop', toolUseId: acc.id })
          toolByIndex.clear()
          out.push({ type: 'done', stopReason: choice.finish_reason })
        }
      })
      return out
    }
  }
}

// ============ Anthropic:请求构造 ============
function blocksToClaudeContent(blocks) {
  const out = []
  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        out.push({ type: 'text', text: b.text })
        break
      case 'image':
        out.push({ type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } })
        break
      case 'tool_use':
        out.push({ type: 'tool_use', id: b.toolUseId, name: b.name, input: b.input ?? {} })
        break
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {})
        })
        break
      // 历史 thinking 不回传
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '' })
  return out
}

// model_reasoning_effort → Anthropic thinking.budget_tokens 预算
const THINKING_BUDGET = { low: 4096, medium: 10240, high: 24576 }

export function buildAnthropicRequest(req, modelName, opts = {}) {
  const messages = req.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: blocksToClaudeContent(m.content) }))
  let maxTokens = opts.maxTokens ?? req.maxTokens ?? 8192
  const body = { model: modelName, messages, stream: true }
  if (req.system) body.system = req.system
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema
    }))
  }
  // 思考强度:Anthropic 走 extended thinking,budget_tokens 必须 < max_tokens
  if (opts.model_reasoning_effort) {
    const budget = THINKING_BUDGET[opts.model_reasoning_effort]
    if (maxTokens <= budget) maxTokens = budget + 4096
    body.thinking = { type: 'enabled', budget_tokens: budget }
  }
  body.max_tokens = maxTokens
  return body
}

// ============ Anthropic:SSE 解析 ============
export function createAnthropicSSEParser() {
  const line = new SSELineParser()
  const toolByIndex = new Map()
  let inputTokens
  return {
    push(chunk) {
      const out = []
      line.feed(chunk, (data) => {
        let obj
        try {
          obj = JSON.parse(data)
        } catch {
          return
        }
        switch (obj.type) {
          case 'message_start':
            inputTokens = obj.message?.usage?.input_tokens
            break
          case 'content_block_start': {
            const cb = obj.content_block
            if (cb?.type === 'tool_use' && cb.id) {
              toolByIndex.set(obj.index ?? 0, { id: cb.id })
              out.push({ type: 'tool_use_start', toolUseId: cb.id, name: cb.name || '' })
            } else if (cb?.type === 'text' && cb.text) {
              out.push({ type: 'text_delta', text: cb.text })
            } else if (cb?.type === 'thinking' && cb.thinking) {
              out.push({ type: 'thinking_delta', text: cb.thinking })
            }
            break
          }
          case 'content_block_delta': {
            const d = obj.delta
            if (d?.type === 'text_delta' && d.text) out.push({ type: 'text_delta', text: d.text })
            else if (d?.type === 'thinking_delta' && d.thinking)
              out.push({ type: 'thinking_delta', text: d.thinking })
            else if (d?.type === 'input_json_delta' && d.partial_json != null) {
              const tool = toolByIndex.get(obj.index ?? 0)
              if (tool) out.push({ type: 'tool_args_delta', toolUseId: tool.id, delta: d.partial_json })
            }
            break
          }
          case 'content_block_stop': {
            const tool = toolByIndex.get(obj.index ?? 0)
            if (tool) {
              out.push({ type: 'tool_use_stop', toolUseId: tool.id })
              toolByIndex.delete(obj.index ?? 0)
            }
            break
          }
          case 'message_delta':
            if (obj.usage?.output_tokens != null) {
              out.push({
                type: 'usage',
                inputTokens,
                outputTokens: obj.usage.output_tokens,
                totalTokens: (inputTokens ?? 0) + obj.usage.output_tokens
              })
            }
            break
          case 'message_stop':
            out.push({ type: 'done', stopReason: obj.delta?.stop_reason })
            break
        }
      })
      return out
    }
  }
}
