// MITM 代理引擎:监听 HTTP CONNECT,对 mitmDomains 命中的连接解密,
// 命中推理请求(x-amz-target *GenerateAssistantResponse)则改道中转站,其余透传到真实上游。
// 从旧项目 kproxy/mitmProxy.ts 移植,去掉机器码替换,加入 upstream 代理透传与内置改道。
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'
import { log } from './logger.mjs'
import { peekModelId } from './kiro.mjs'
import { runRelay } from './relay.mjs'
import { resolveRoute } from './config.mjs'

// ---- HTTP chunked 编解码(内联自旧项目 httpChunked.ts)----
function encodeHttpChunk(bytes) {
  const sizeLine = Buffer.from(`${bytes.length.toString(16)}\r\n`, 'ascii')
  return Buffer.concat([sizeLine, bytes, Buffer.from('\r\n', 'ascii')])
}
const HTTP_CHUNK_TERMINATOR = Buffer.from('0\r\n\r\n', 'ascii')
function splitHeaderBody(all, headerByteLen) {
  const header = all.subarray(0, Math.max(0, headerByteLen - 4)).toString('utf8')
  const body = all.subarray(headerByteLen).toString('utf8')
  return { header, body }
}

/** 判定是否推理请求(需改道) */
function isInferenceRequest(headerStr) {
  return /x-amz-target:\s*\S*GenerateAssistantResponse/i.test(headerStr)
}

export class MitmProxy {
  constructor(certManager, config, getConfig) {
    this.certManager = certManager
    this.config = config
    // getConfig: 热重载配置的取值函数(每次改道时调用,拿最新 stations/routes)
    this.getConfig = getConfig || (() => config)
    this.server = null
    this.sockets = new Set()
    this.stats = { total: 0, mitm: 0, bypass: 0, relayed: 0, passthrough: 0 }
  }

  start() {
    if (this.server) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttp(req, res))
      this.server.on('connect', (req, socket, head) => this.handleConnect(req, socket, head))
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') reject(new Error(`端口 ${this.config.port} 已被占用`))
        else reject(err)
      })
      this.server.listen(this.config.port, this.config.host, () => {
        log.ok('proxy', `已监听 ${this.config.host}:${this.config.port}`)
        resolve()
      })
    })
  }

  async stop() {
    if (!this.server) return
    for (const s of this.sockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()
    const srv = this.server
    this.server = null
    await new Promise((resolve) => {
      const done = () => resolve()
      srv.close(done)
      setTimeout(done, 1000)
    })
    log.info('proxy', '已停止')
  }

  // 普通 HTTP(非 CONNECT):直接转发(Kiro 走 HTTPS,此路径基本用不到,保底实现)
  handleHttp(req, res) {
    const target = new URL(req.url)
    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )
    proxyReq.on('error', () => {
      res.writeHead(502)
      res.end('Bad Gateway')
    })
    req.pipe(proxyReq)
  }

  handleConnect(req, clientSocket, head) {
    this.sockets.add(clientSocket)
    clientSocket.once('close', () => this.sockets.delete(clientSocket))
    this.stats.total++

    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr, 10) || 443

    if (this.shouldMitm(hostname)) {
      this.stats.mitm++
      this.handleMitmConnect(hostname, port, clientSocket)
    } else {
      this.stats.bypass++
      this.handleDirectConnect(hostname, port, clientSocket, head)
    }
  }

  shouldMitm(hostname) {
    return this.config.mitmDomains.some((d) => hostname.includes(d))
  }

  // 不解密:建立到上游的原始隧道(经 upstream 代理或直连),双向 pipe
  handleDirectConnect(hostname, port, clientSocket, head) {
    this.connectUpstream(hostname, port, (err, upstream) => {
      if (err) {
        log.error('proxy', `隧道连接失败 ${hostname}:${port}: ${err.message}`)
        clientSocket.end()
        return
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
      const kill = () => {
        upstream.destroy()
        clientSocket.destroy()
      }
      upstream.on('error', kill)
      clientSocket.on('error', kill)
    })
  }

  // MITM:用签发证书扮演目标站,解密后处理明文请求
  handleMitmConnect(hostname, port, clientSocket) {
    try {
      const { cert, key } = this.certManager.certForHost(hostname)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, cert, key })
      tlsSocket.on('error', (e) => {
        log.debug('proxy', `TLS 错误 ${hostname}: ${e.message}`)
        clientSocket.end()
      })
      this.handleDecrypted(tlsSocket, hostname, port)
    } catch (e) {
      log.error('proxy', `MITM 建立失败 ${hostname}: ${e.message}`)
      clientSocket.end()
    }
  }

  handleDecrypted(clientSocket, hostname, port) {
    let requestData = ''
    let headersParsed = false
    let contentLength = 0

    // 原始字节累积:body 是 UTF-8 JSON,多字节字符可能被 TCP 分块切断,
    // 必须按 header 字节偏移从完整字节流切 body 再一次性 toString。
    const rawBufs = []
    let rawLen = 0
    let buffering = false
    let headerByteLen = 0
    let fired = false

    const fire = () => {
      if (fired) return
      fired = true
      const all = Buffer.concat(rawBufs, rawLen)
      const { header, body } = splitHeaderBody(all, headerByteLen)
      this.dispatchInference(header, body, hostname, port, clientSocket)
    }

    clientSocket.on('data', (chunk) => {
      if (!headersParsed || buffering) {
        rawBufs.push(chunk)
        rawLen += chunk.length
      }
      if (buffering) {
        if (rawLen >= headerByteLen + contentLength) fire()
        return
      }
      if (!headersParsed) {
        requestData += chunk.toString('latin1')
        const end = requestData.indexOf('\r\n\r\n')
        if (end !== -1) {
          headersParsed = true
          const headers = requestData.substring(0, end)
          const clMatch = headers.match(/content-length:\s*(\d+)/i)
          if (clMatch) contentLength = parseInt(clMatch[1], 10)

          if (isInferenceRequest(headers)) {
            buffering = true
            headerByteLen = Buffer.byteLength(headers, 'utf8') + 4
            if (rawLen >= headerByteLen + contentLength) fire()
            return
          }
          // 非推理请求:透传到真实上游(把已读字节完整转发)
          this.passthrough(clientSocket, hostname, port, rawBufs, rawLen)
        }
      }
    })

    clientSocket.on('error', (e) => log.debug('proxy', `解密连接错误: ${e.message}`))
  }

  // 推理请求:解析路由 → 改道中转站 → chunked 流式写回。无匹配路由则透传。
  async dispatchInference(headerStr, body, hostname, port, clientSocket) {
    const cfg = this.getConfig()
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      log.warn('relay', '推理请求体 JSON 解析失败,透传')
      return this.passthroughRaw(headerStr, body, hostname, port, clientSocket)
    }

    const modelId = peekModelId(payload)
    const route = resolveRoute(cfg, modelId)
    if (!route) {
      log.warn('relay', `modelId=${modelId} 无匹配路由且无 default,透传`)
      return this.passthroughRaw(headerStr, body, hostname, port, clientSocket)
    }

    log.info('relay', `改道 modelId=${modelId} → [${route.station.id}] ${route.station.protocol} ${route.model}`)
    this.stats.relayed++

    // 写响应头(AWS 事件流 + chunked)
    let responded = false
    const writeHead = () => {
      if (responded) return
      responded = true
      const head =
        'HTTP/1.1 200 OK\r\n' +
        'content-type: application/vnd.amazon.eventstream\r\n' +
        'transfer-encoding: chunked\r\n\r\n'
      clientSocket.write(head)
    }
    writeHead()

    const onFrame = (bytes) => {
      if (bytes && bytes.length) clientSocket.write(encodeHttpChunk(bytes))
    }
    const result = await runRelay(
      payload,
      route.station,
      route.model,
      cfg.upstreamProxy,
      onFrame,
      undefined,
      {
        maxTokens: route.maxTokens,
        model_reasoning_effort: route.model_reasoning_effort,
        showThinking: route.showThinking,
        maxContextTokens: route.maxContextTokens
      }
    )
    if (!result.ok) {
      log.error('relay', `改道失败: ${result.error ?? result.status}`)
    } else if (result.usage) {
      log.ok('relay', `完成 in=${result.usage.inputTokens ?? '?'} out=${result.usage.outputTokens ?? '?'}`)
    } else {
      log.ok('relay', '完成')
    }
    clientSocket.write(HTTP_CHUNK_TERMINATOR)
    clientSocket.end()
  }

  // 透传:已缓冲的原始字节直接送到真实上游,再双向 pipe
  passthrough(clientSocket, hostname, port, rawBufs, rawLen) {
    this.stats.passthrough++
    this.connectUpstreamTls(hostname, port, (err, upstream) => {
      if (err) {
        log.error('proxy', `透传上游失败 ${hostname}: ${err.message}`)
        clientSocket.end()
        return
      }
      if (rawLen) upstream.write(Buffer.concat(rawBufs, rawLen))
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
      const kill = () => {
        upstream.destroy()
        clientSocket.destroy()
      }
      upstream.on('error', kill)
      clientSocket.on('error', kill)
    })
  }

  // 透传(改道解析失败的回退):重组 header+body 送上游
  passthroughRaw(headerStr, body, hostname, port, clientSocket) {
    this.connectUpstreamTls(hostname, port, (err, upstream) => {
      if (err) {
        log.error('proxy', `回退透传失败 ${hostname}: ${err.message}`)
        clientSocket.end()
        return
      }
      upstream.write(headerStr + '\r\n\r\n' + body)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
      const kill = () => {
        upstream.destroy()
        clientSocket.destroy()
      }
      upstream.on('error', kill)
      clientSocket.on('error', kill)
    })
  }

  // 建立到上游的原始 TCP(用于不解密的隧道):经 upstream 代理或直连
  connectUpstream(hostname, port, cb) {
    const up = this.config.upstreamProxy
    if (!up) {
      const sock = net.connect(port, hostname, () => cb(null, sock))
      sock.on('error', (e) => cb(e))
      return
    }
    this.connectViaProxy(up, hostname, port, cb)
  }

  // 建立到上游的 TLS(用于 MITM 后重新加密转发透传流量)
  connectUpstreamTls(hostname, port, cb) {
    const up = this.config.upstreamProxy
    const wrapTls = (rawSock) => {
      const tlsSock = tls.connect(
        { socket: rawSock, servername: hostname, rejectUnauthorized: true },
        () => cb(null, tlsSock)
      )
      tlsSock.on('error', (e) => cb(e))
    }
    if (!up) {
      const sock = net.connect(port, hostname, () => wrapTls(sock))
      sock.on('error', (e) => cb(e))
      return
    }
    this.connectViaProxy(up, hostname, port, (err, rawSock) => {
      if (err) return cb(err)
      wrapTls(rawSock)
    })
  }

  // 经 HTTP 代理(如 Clash)建 CONNECT 隧道,回调裸 socket
  connectViaProxy(proxyUrl, hostname, port, cb) {
    let u
    try {
      u = new URL(proxyUrl)
    } catch {
      return cb(new Error(`upstreamProxy 非法: ${proxyUrl}`))
    }
    const sock = net.connect(parseInt(u.port, 10) || 80, u.hostname, () => {
      sock.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
    })
    let established = false
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('latin1')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return
      established = true
      sock.removeListener('data', onData)
      const statusLine = buf.slice(0, buf.indexOf('\r\n'))
      if (!/\s2\d\d\s/.test(statusLine)) {
        return cb(new Error(`代理 CONNECT 拒绝: ${statusLine}`))
      }
      const leftover = Buffer.from(buf.slice(idx + 4), 'latin1')
      if (leftover.length) sock.unshift(leftover)
      cb(null, sock)
    }
    sock.on('data', onData)
    sock.on('error', (e) => {
      if (!established) cb(e)
    })
  }

  getStats() {
    return { ...this.stats }
  }
}
