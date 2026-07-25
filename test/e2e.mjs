// 端到端自测:起一个假 OpenAI SSE 服务器,直接调 runRelay,验证 Kiro→OpenAI→Kiro 转换链。
// 不依赖真实中转站/Kiro,纯本地。运行:node test/e2e.mjs
import http from 'node:http'
import assert from 'node:assert'
import { runRelay } from '../src/relay.mjs'

// 假 OpenAI 中转站:收到 chat/completions 就回一段流式 SSE(文本 + 一个工具调用)
function startFakeStation() {
  return new Promise((resolve) => {
    let received = null
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = { url: req.url, headers: req.headers, body: JSON.parse(body) }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const sse = [
          'data: {"choices":[{"delta":{"content":"你好"}}]}',
          'data: {"choices":[{"delta":{"content":",世界"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"北京\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
          'data: [DONE]',
          ''
        ].join('\n\n')
        res.end(sse)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, getReceived: () => received })
    })
  })
}

// 构造一个最小 Kiro 推理 payload
function fakeKiroPayload() {
  return {
    conversationState: {
      conversationId: 'test-conv',
      currentMessage: {
        userInputMessage: {
          content: '北京天气怎么样?',
          modelId: 'auto',
          userInputMessageContext: {
            tools: [
              {
                toolSpecification: {
                  name: 'get_weather',
                  description: '查天气',
                  inputSchema: { json: { type: 'object', properties: { city: { type: 'string' } } } }
                }
              }
            ]
          }
        }
      },
      history: [
        { userInputMessage: { content: '你是谁' } },
        { assistantResponseMessage: { content: '我是助手', toolUses: [] } }
      ]
    },
    inferenceConfig: { maxTokens: 4096 }
  }
}

async function main() {
  const { server, port, getReceived } = await startFakeStation()
  const station = {
    id: 'fake',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test',
    headers: {}
  }

  const frames = []
  const result = await runRelay(fakeKiroPayload(), station, 'gpt-4o', null, (bytes) =>
    frames.push(bytes)
  )

  // --- 断言 1:改道成功 ---
  assert.strictEqual(result.ok, true, `改道应成功,实际: ${result.error}`)
  console.log('✓ 改道成功')

  // --- 断言 2:发给中转站的请求正确 ---
  const rec = getReceived()
  assert.strictEqual(rec.url, '/v1/chat/completions', 'URL 应为 /v1/chat/completions')
  assert.strictEqual(rec.headers.authorization, 'Bearer sk-test', 'Authorization 头应正确')
  assert.strictEqual(rec.body.model, 'gpt-4o', 'model 应为 gpt-4o')
  assert.strictEqual(rec.body.stream, true, '应流式')
  // messages: history(user+assistant) + current user = 3 条
  assert.strictEqual(rec.body.messages.length, 3, `messages 应 3 条,实际 ${rec.body.messages.length}`)
  assert.strictEqual(rec.body.messages[2].content, '北京天气怎么样?', '末条应为当前用户消息')
  assert.ok(rec.body.tools?.length === 1, '应带 1 个工具')
  assert.strictEqual(rec.body.tools[0].function.name, 'get_weather', '工具名应正确')
  console.log('✓ 发往中转站的 OpenAI 请求结构正确')

  // --- 断言 3:回写的 Kiro 帧非空且可解析 ---
  assert.ok(frames.length > 0, '应产生 Kiro 帧')
  const all = Buffer.concat(frames)
  assert.ok(all.length > 0, 'Kiro 字节应非空')
  // 帧头:前 4 字节 totalLen 应等于该帧总长(校验第一帧结构)
  const firstLen = frames[0].readUInt32BE(0)
  assert.strictEqual(firstLen, frames[0].length, '第一帧 totalLen 应等于帧字节数')
  // 内容里应含「你好」和工具名(帧 payload 是 JSON,含 UTF-8)
  const text = all.toString('utf8')
  assert.ok(text.includes('你好'), '帧中应含文本「你好」')
  assert.ok(text.includes('get_weather'), '帧中应含工具名')
  assert.ok(text.includes('assistantResponseEvent'), '应有 assistantResponseEvent 帧')
  assert.ok(text.includes('toolUseEvent'), '应有 toolUseEvent 帧')
  console.log(`✓ 回写 ${frames.length} 个 Kiro 帧,结构与内容正确`)

  // --- 断言 4:usage 透传 ---
  assert.ok(result.usage, '应有 usage')
  assert.strictEqual(result.usage.outputTokens, 5, 'outputTokens 应为 5')
  console.log('✓ usage 正确传出')

  server.close()
  console.log('\n全部通过 ✅')
}

main().catch((e) => {
  console.error('测试失败 ❌', e)
  process.exit(1)
})
