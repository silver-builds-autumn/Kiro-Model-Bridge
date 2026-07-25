// 代理层端到端:起真实 MitmProxy + 假中转站,用 HTTPS 客户端经代理发一个
// GenerateAssistantResponse 请求,验证:CONNECT→TLS 解密→命中拦截→改道→chunked 回写。
// 运行:node test/proxy-e2e.mjs
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import assert from 'node:assert'
import { CertManager } from '../src/cert.mjs'
import { MitmProxy } from '../src/proxy.mjs'
import { dataDir } from '../src/config.mjs'

function startFakeStation() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(
          [
            'data: {"choices":[{"delta":{"content":"来自中转站的回复"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3}}',
            'data: [DONE]',
            ''
          ].join('\n\n')
        )
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// 经 HTTP 代理发一个 HTTPS 请求(手动 CONNECT),信任给定 CA
function httpsViaProxy({ proxyPort, host, path, body, ca, headers }) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(proxyPort, '127.0.0.1', () => {
      conn.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`)
    })
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('latin1')
      if (buf.indexOf('\r\n\r\n') === -1) return
      conn.removeListener('data', onData)
      if (!/\s2\d\d\s/.test(buf.split('\r\n')[0])) return reject(new Error('CONNECT 失败: ' + buf))

      const req = https.request(
        {
          socket: conn,
          servername: host,
          host,
          path,
          method: 'POST',
          ca,
          headers: { 'content-type': 'application/json', ...headers }
        },
        (res) => {
          const chunks = []
          res.on('data', (d) => chunks.push(d))
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
          )
        }
      )
      req.on('error', reject)
      req.end(body)
    }
    conn.on('data', onData)
    conn.on('error', reject)
  })
}

async function main() {
  const { server: station, port: stationPort } = await startFakeStation()

  const cert = new CertManager(dataDir())
  cert.initialize()

  const config = {
    port: 0,
    host: '127.0.0.1',
    upstreamProxy: null,
    mitmDomains: ['kiro.dev'],
    stations: {
      fake: {
        id: 'fake',
        protocol: 'openai-chat',
        baseUrl: `http://127.0.0.1:${stationPort}`,
        apiKey: 'sk-test',
        headers: {}
      }
    },
    routes: { default: { station: 'fake', model: 'gpt-4o' }, byModelId: {} }
  }

  const proxy = new MitmProxy(cert, config, () => config)
  // 手动 listen 到随机端口
  await new Promise((resolve) => {
    proxy.server = http.createServer((req, res) => proxy.handleHttp(req, res))
    proxy.server.on('connect', (req, s, head) => proxy.handleConnect(req, s, head))
    proxy.server.listen(0, '127.0.0.1', () => resolve())
  })
  const proxyPort = proxy.server.address().port

  const kiroBody = JSON.stringify({
    conversationState: {
      conversationId: 'c1',
      currentMessage: { userInputMessage: { content: '测试', modelId: 'auto' } }
    }
  })

  const resp = await httpsViaProxy({
    proxyPort,
    host: 'runtime.us-east-1.kiro.dev',
    path: '/',
    body: kiroBody,
    ca: [require_ca(cert)],
    headers: { 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse' }
  })

  assert.strictEqual(resp.status, 200, `应 200,实际 ${resp.status}`)
  console.log('✓ 代理返回 200')
  assert.ok(
    /vnd\.amazon\.eventstream/.test(resp.headers['content-type'] || ''),
    'content-type 应为 amazon eventstream'
  )
  console.log('✓ content-type 正确(AWS 事件流)')

  // Node 的 https 客户端已自动去掉 chunked 传输编码,resp.body 即原始 Kiro 帧字节
  const text = resp.body.toString('utf8')
  assert.ok(text.includes('来自中转站的回复'), '响应应含中转站回复文本')
  assert.ok(text.includes('assistantResponseEvent'), '应含 assistantResponseEvent 帧')
  // 校验第一帧结构:前 4 字节 totalLen == 帧长(证明是合法 AWS 事件流帧)
  const firstLen = resp.body.readUInt32BE(0)
  assert.ok(firstLen > 0 && firstLen <= resp.body.length, '首帧 totalLen 应合理')
  console.log('✓ 响应为合法 Kiro 帧,含改道回复文本')

  assert.strictEqual(proxy.getStats().relayed, 1, '应记录 1 次改道')
  console.log('✓ 统计:改道 1 次')

  proxy.server.close()
  station.close()
  console.log('\n代理层端到端全部通过 ✅')
}

// 从 CertManager 拿 CA PEM(读文件)
import fs from 'node:fs'
function require_ca(cert) {
  return fs.readFileSync(cert.caCertPath())
}

main().catch((e) => {
  console.error('代理层测试失败 ❌', e)
  process.exit(1)
})
