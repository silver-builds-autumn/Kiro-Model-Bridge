#!/usr/bin/env node
// kiro-relay CLI 入口。命令:run / doctor / install-ca / cert / help
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { loadConfig, resolveConfigPath, dataDir, rootDir } from './config.mjs'
import { CertManager, installCaWindows, isCaInstalledWindows } from './cert.mjs'
import { MitmProxy } from './proxy.mjs'
import { log } from './logger.mjs'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config' || a === '-c') args.config = argv[++i]
    else if (a.startsWith('--')) args[a.slice(2)] = true
    else args._.push(a)
  }
  return args
}

const HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || 'help'
  const configPath = resolveConfigPath(args.config)

  switch (cmd) {
    case 'run':
      return cmdRun(configPath)
    case 'doctor':
      return cmdDoctor(configPath)
    case 'install-ca':
      return cmdInstallCa()
    case 'cert':
      return cmdCert()
    default:
      return cmdHelp()
  }
}

async function cmdRun(configPath) {
  let config
  try {
    config = loadConfig(configPath)
  } catch (e) {
    log.error('config', e.message)
    process.exit(1)
  }
  log.info('config', `已加载 ${configPath}`)
  log.info('config', `中转站 ${Object.keys(config.stations).length} 个,监听端口 ${config.port},上游 ${config.upstreamProxy || '直连'}`)

  const cert = new CertManager(dataDir())
  cert.initialize()

  // 提醒:hosts 残留 / CA 未装
  checkHostsWarning()
  if (process.platform === 'win32') {
    const installed = await isCaInstalledWindows()
    if (!installed) {
      log.warn('cert', 'CA 尚未安装到系统信任库,Kiro 会因证书不受信而握手失败。')
      log.warn('cert', '请先运行: node src/index.mjs install-ca')
    }
  }

  // 热重载:每次改道调用 loadConfig 读盘(容忍读失败,回退上次成功配置)
  let live = config
  const getConfig = () => {
    try {
      live = loadConfig(configPath)
    } catch {
      /* 保留上次 */
    }
    return live
  }

  const proxy = new MitmProxy(cert, config, getConfig)
  await proxy.start()

  log.ok('proxy', '就绪。在 Kiro settings.json 设置 "http.proxy": ' + `"http://${config.host}:${config.port}"`)
  log.info('proxy', '按 Ctrl+C 停止。')

  const shutdown = async () => {
    log.info('proxy', '正在停止...')
    await proxy.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function checkHostsWarning() {
  try {
    const txt = fs.readFileSync(HOSTS_PATH, 'utf8')
    const bad = txt
      .split('\n')
      .filter((l) => /kiro\.dev/i.test(l) && !/^\s*#/.test(l) && /^\s*127\.|^\s*0\.0\.0\.0/.test(l))
    if (bad.length) {
      log.warn('doctor', 'hosts 文件里有把 kiro.dev 指向本机的残留条目,会导致透传失败(ECONNREFUSED):')
      for (const b of bad) log.warn('doctor', '  ' + b.trim())
      log.warn('doctor', `请编辑 ${HOSTS_PATH} 删除上述行(管理员权限)。`)
      return false
    }
  } catch {
    /* 读不到 hosts 就跳过 */
  }
  return true
}

async function cmdDoctor(configPath) {
  log.info('doctor', '开始体检...')
  let ok = true

  // 1. 配置
  let config
  try {
    config = loadConfig(configPath)
    log.ok('doctor', `配置合法:${Object.keys(config.stations).length} 个中转站,${Object.keys(config.routes.byModelId).length} 条 modelId 路由,default=${config.routes.default ? '有' : '无'}`)
  } catch (e) {
    log.error('doctor', `配置问题:${e.message}`)
    return
  }

  // 2. hosts 残留
  if (!checkHostsWarning()) ok = false
  else log.ok('doctor', 'hosts 无 kiro.dev 劫持残留')

  // 3. CA
  const cert = new CertManager(dataDir())
  cert.initialize()
  log.ok('doctor', `CA 指纹 ${cert.fingerprint()}`)
  if (process.platform === 'win32') {
    const installed = await isCaInstalledWindows()
    if (installed) log.ok('doctor', 'CA 已安装到系统信任库')
    else {
      log.warn('doctor', 'CA 未安装。运行 install-ca 安装。')
      ok = false
    }
  }

  // 4. 上游代理连通性
  if (config.upstreamProxy) {
    const reach = await probeProxy(config.upstreamProxy)
    if (reach) log.ok('doctor', `上游代理可达 ${config.upstreamProxy}`)
    else {
      log.warn('doctor', `上游代理不可达 ${config.upstreamProxy}(透传流量会失败)`)
      ok = false
    }
  } else {
    log.info('doctor', '未配置上游代理,透传走直连')
  }

  log.info('doctor', ok ? '✓ 全部通过' : '有告警项,见上。')
  printWireup(config)
}

function probeProxy(proxyUrl) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(proxyUrl)
    } catch {
      return resolve(false)
    }
    const sock = net.connect(parseInt(u.port, 10) || 80, u.hostname)
    const done = (v) => {
      sock.destroy()
      resolve(v)
    }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(2000, () => done(false))
  })
}

async function cmdInstallCa() {
  if (process.platform !== 'win32') {
    log.error('cert', '自动安装目前仅支持 Windows。请手动把 CA 导入系统信任库。')
    log.info('cert', 'CA 路径:' + path.join(dataDir(), 'kiro-relay-ca.crt'))
    return
  }
  const cert = new CertManager(dataDir())
  cert.initialize()
  const certPath = cert.caCertPath()
  log.info('cert', `安装 CA 到当前用户信任库:${certPath}`)
  const r = await installCaWindows(certPath)
  if (r.ok) log.ok('cert', 'CA 安装成功。重启 Kiro 后生效。')
  else log.error('cert', `安装失败:${r.message}\n可手动双击 ${certPath} 安装到「受信任的根证书颁发机构」。`)
}

function cmdCert() {
  const cert = new CertManager(dataDir())
  cert.initialize()
  log.info('cert', `CA 证书:${cert.caCertPath()}`)
  log.info('cert', `指纹(SHA-256):${cert.fingerprint()}`)
}

function printWireup(config) {
  const line = (s) => console.log('  ' + s)
  console.log('')
  console.log('接线步骤:')
  line(`1. 安装 CA:node src/index.mjs install-ca`)
  line(`2. 启动:node src/index.mjs run`)
  line(`3. Kiro settings.json 加:"http.proxy": "http://${config.host}:${config.port}"`)
  line(`4. 重启 Kiro,发一条消息,看本终端 [relay] 日志`)
  console.log('')
}

function cmdHelp() {
  console.log(`
kiro-relay — 拦截 Kiro 推理请求并改道到自建中转站

用法:
  node src/index.mjs <命令> [--config <路径>]

命令:
  run          启动代理(默认读 ${path.join(rootDir(), 'config.json')})
  doctor       体检:配置/hosts/CA/上游代理,并打印接线步骤
  install-ca   生成并安装 CA 到系统信任库(Windows)
  cert         显示 CA 证书路径与指纹
  help         显示本帮助

首次使用:
  1. 复制 config.example.json 为 config.json,填写中转站
  2. node src/index.mjs install-ca
  3. node src/index.mjs doctor
  4. node src/index.mjs run
`)
}

main().catch((e) => {
  log.error('fatal', e.stack || e.message)
  process.exit(1)
})
