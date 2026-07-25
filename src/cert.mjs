// CA 证书管理:生成/加载自签 CA,按域名签发叶子证书(供 MITM 用),安装 CA 到系统信任库。
// 从旧项目 kproxy/certManager.ts 移植为纯 ESM。
import forge from 'node-forge'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { log } from './logger.mjs'

const CA_CERT_FILENAME = 'kiro-relay-ca.crt'
const CA_KEY_FILENAME = 'kiro-relay-ca.key'

const leafCache = new Map()

export class CertManager {
  constructor(dataPath) {
    this.dataPath = dataPath
    this.caCert = null
    this.caKey = null
    this.certPath = path.join(dataPath, CA_CERT_FILENAME)
    this.keyPath = path.join(dataPath, CA_KEY_FILENAME)
  }

  /** 加载已有 CA;不存在或过期则生成新的 */
  initialize() {
    if (fs.existsSync(this.certPath) && fs.existsSync(this.keyPath)) {
      try {
        const certPem = fs.readFileSync(this.certPath, 'utf8')
        const keyPem = fs.readFileSync(this.keyPath, 'utf8')
        const cert = forge.pki.certificateFromPem(certPem)
        if (cert.validity.notAfter > new Date()) {
          this.caCert = cert
          this.caKey = forge.pki.privateKeyFromPem(keyPem)
          log.debug('cert', '加载已有 CA 证书')
          return
        }
        log.warn('cert', 'CA 证书已过期,重新生成')
      } catch (e) {
        log.warn('cert', `加载 CA 失败,重新生成: ${e.message}`)
      }
    }
    this.generateCA()
  }

  generateCA() {
    log.info('cert', '生成新的 CA 证书...')
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = serial()
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10)
    const attrs = [
      { name: 'commonName', value: 'Kiro Relay CA' },
      { name: 'organizationName', value: 'Kiro Relay' },
      { name: 'countryName', value: 'CN' }
    ]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' }
    ])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    fs.writeFileSync(this.certPath, forge.pki.certificateToPem(cert))
    fs.writeFileSync(this.keyPath, forge.pki.privateKeyToPem(keys.privateKey))
    this.caCert = cert
    this.caKey = keys.privateKey
    log.ok('cert', `CA 已生成: ${this.certPath}`)
  }

  /** 为域名签发叶子证书(带缓存) */
  certForHost(hostname) {
    const cached = leafCache.get(hostname)
    if (cached) return cached
    if (!this.caCert || !this.caKey) throw new Error('CA 未初始化')

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = serial()
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
    cert.setSubject([
      { name: 'commonName', value: hostname },
      { name: 'organizationName', value: 'Kiro Relay' }
    ])
    cert.setIssuer(this.caCert.subject.attributes)
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: hostname },
          { type: 2, value: '*.' + hostname }
        ]
      }
    ])
    cert.sign(this.caKey, forge.md.sha256.create())
    const result = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey)
    }
    leafCache.set(hostname, result)
    return result
  }

  caCertPath() {
    return this.certPath
  }

  fingerprint() {
    if (!this.caCert) return null
    return forge.md.sha256
      .create()
      .update(forge.asn1.toDer(forge.pki.certificateToAsn1(this.caCert)).getBytes())
      .digest()
      .toHex()
      .match(/.{2}/g)
      .join(':')
      .toUpperCase()
  }
}

function serial() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * 把 CA 安装到 Windows 当前用户信任库(certutil -user -addstore Root)。
 * 返回 Promise<{ok, message}>。需要用户机器是 Windows。
 */
export function installCaWindows(certPath) {
  return new Promise((resolve) => {
    execFile(
      'certutil',
      ['-user', '-addstore', 'Root', certPath],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, message: (stderr || err.message || '').trim() })
        } else {
          resolve({ ok: true, message: (stdout || '').trim() })
        }
      }
    )
  })
}

/**
 * 检查 CA 是否已在 Windows 用户信任库。
 * 按证书主题 CN "Kiro Relay CA" 匹配(纯 ASCII,不受 certutil 中文输出的 GBK 编码影响;
 * 且不像 SHA-256 指纹那样与 certutil 默认打印的 SHA-1 指纹格式不一致)。
 */
export function isCaInstalledWindows() {
  return new Promise((resolve) => {
    execFile(
      'certutil',
      ['-user', '-store', 'Root'],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '')
        if (!out) return resolve(false)
        resolve(/Kiro Relay CA/.test(out))
      }
    )
  })
}
