// AWS Event Stream 编码器(零依赖)。把事件编码成 Kiro 认识的二进制帧。
// 帧格式(big-endian):4B totalLen | 4B headersLen | 4B preludeCRC | headers | payload | 4B msgCRC
// 头格式:nameLen(1B) name valueType(1B=7 字符串) 2B valueLen value
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function encodeStringHeader(name, value) {
  const nameBytes = Buffer.from(name, 'utf8')
  const valueBytes = Buffer.from(value, 'utf8')
  const buf = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  let off = 0
  buf.writeUInt8(nameBytes.length, off); off += 1
  nameBytes.copy(buf, off); off += nameBytes.length
  buf.writeUInt8(7, off); off += 1
  buf.writeUInt16BE(valueBytes.length, off); off += 2
  valueBytes.copy(buf, off)
  return buf
}

/** 编码一个完整帧 */
export function encodeEventFrame(eventType, payload, extraHeaders = {}) {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
  const headerParts = [
    encodeStringHeader(':message-type', 'event'),
    encodeStringHeader(':event-type', eventType),
    encodeStringHeader(':content-type', 'application/json')
  ]
  for (const [k, v] of Object.entries(extraHeaders)) headerParts.push(encodeStringHeader(k, v))
  const headersBuf = Buffer.concat(headerParts)
  const headersLen = headersBuf.length
  const totalLen = 4 + 4 + 4 + headersLen + payloadBytes.length + 4
  const frame = Buffer.alloc(totalLen)
  let off = 0
  frame.writeUInt32BE(totalLen, off); off += 4
  frame.writeUInt32BE(headersLen, off); off += 4
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), off); off += 4
  headersBuf.copy(frame, off); off += headersLen
  payloadBytes.copy(frame, off); off += payloadBytes.length
  frame.writeUInt32BE(crc32(frame.subarray(0, totalLen - 4)), off)
  return frame
}

/** assistantResponseEvent:流式文本增量 */
export function encodeAssistantTextFrame(content) {
  return encodeEventFrame('assistantResponseEvent', { content })
}

/** toolUseEvent:工具调用(input 为字符串片段或完整对象;stop 标记结束) */
export function encodeToolUseFrame({ toolUseId, name, input, stop }) {
  const payload = { toolUseId, name }
  if (input !== undefined) payload.input = input
  if (stop !== undefined) payload.stop = stop
  return encodeEventFrame('toolUseEvent', payload)
}
