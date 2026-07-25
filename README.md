# kiro-relay

拦截 Kiro 的推理请求(`GenerateAssistantResponse`),改道到你自建的中转站(OpenAI / Anthropic 格式),其余 kiro.dev 流量原样透传。纯命令行 Node 工具,无 Electron、无构建步骤。

## 原理

```
Kiro ──http.proxy──▶ kiro-relay(:8899)
                        │
     ┌──────────────────┴───────────────────┐
     │ 推理请求(x-amz-target                 │ 其余 kiro.dev 请求
     │ *GenerateAssistantResponse)           │ (鉴权/遥测等)
     ▼                                        ▼
  解码 conversationState                    透传到真实 kiro.dev
     │                                    (经 upstreamProxy 或直连)
     ▼
  转成 OpenAI/Anthropic 请求 ──▶ 你的中转站
     │
     ◀── 中转站 SSE 流
     ▼
  重新编码成 AWS 事件流帧 ──▶ 回写给 Kiro
```

kiro-relay 作为 HTTPS MITM 代理:对 `kiro.dev` 用自签 CA 动态签发证书解密流量。只有推理请求被改道,其它一律透传,所以 Kiro 的登录、鉴权、遥测都正常。

## 快速开始

```bash
cp config.example.json config.json     # 1. 复制配置模板
# 2. 编辑 config.json,填你的中转站 baseUrl / apiKey / 模型名
node src/index.mjs install-ca          # 3. 生成并安装 CA 到系统信任库
node src/index.mjs doctor              # 4. 体检(配置/hosts/CA/上游代理)
node src/index.mjs run                 # 5. 启动
```

然后在 Kiro 的 `settings.json` 加一行,重启 Kiro:

```json
"http.proxy": "http://127.0.0.1:8899"
```

发一条消息,回到 `run` 的终端看 `[relay]` 日志确认改道生效。

## 配置说明(config.json)

| 字段 | 说明 |
|------|------|
| `port` / `host` | 代理监听地址,默认 `127.0.0.1:8899` |
| `upstreamProxy` | 非推理流量出网方式。`null`=直连;填 HTTP 代理(如 Clash `http://127.0.0.1:7897`)则走它。也用于连接中转站。 |
| `mitmDomains` | 需解密的域名,默认 `["kiro.dev"]` |
| `stations` | 中转站列表:每个含 `protocol`(`openai-chat`/`anthropic-messages`)、`baseUrl`、`apiKey` |
| `routes.default` | 兜底路由:未列出的 modelId 都走这个站+模型 |
| `routes.byModelId` | 按 Kiro modelId 精确路由。modelId 会打印在日志里,先跑一次照着填。 |

配置支持热更新:改完 `config.json` 直接生效,不用重启。

### route 可选开关

每条 route(`default` 或 `byModelId` 里的任意一条)除了必填的 `station` / `model`,还可以加下面四个可选字段。不填就是透明转发(交给中转站默认行为)。

| 字段 | 类型 | 作用 |
|------|------|------|
| `maxTokens` | 正整数 | 覆盖输出上限。不填时:OpenAI 用中转站默认,Anthropic 默认 `8192`(易截断长回复,建议显式设大)。 |
| `model_reasoning_effort` | `low`/`medium`/`high` | 思考强度。OpenAI 走 `reasoning_effort`;Anthropic 走 extended thinking 的 `budget_tokens`(分别约 4096 / 10240 / 24576,并自动抬高 `max_tokens` 以容纳)。 |
| `showThinking` | 布尔 | `true` 时把模型的思考过程也显示到 Kiro 里(带 `🧠 思考中…` 标题、思考完插 `---` 分隔线)。会占用输出 token,长对话更费。 |
| `maxContextTokens` | 正整数 | 上下文上限。请求历史估算(≈字符数/4)超过它时,在本层从最早的消息开始裁剪,防止中转站报「上下文超限」。裁剪会避开悬空的 `tool_result`。 |

示例:

```json
"routes": {
  "default": {
    "station": "my-claude-relay",
    "model": "claude-opus-4-8",
    "maxTokens": 32000,
    "model_reasoning_effort": "high",
    "showThinking": true,
    "maxContextTokens": 180000
  }
}
```

两点提醒:

- `model_reasoning_effort` / `showThinking` 能否生效,取决于**中转站是否透传这些字段、模型是否为推理模型**。kiro-relay 按标准协议发送(OpenAI `reasoning_effort`、Anthropic `thinking`),但如果上游不支持,思考就不会出现——这是上游的限制,不是本工具的问题。
- `maxContextTokens` 是**粗估**(字符/4),偏保守。设值时给目标模型的真实窗口留余量;中转站模型窗口更小就把它调小。

## 命令

- `run` — 启动代理
- `doctor` — 体检:检查配置合法性、hosts 残留劫持、CA 是否已装、上游代理连通性
- `install-ca` — 生成并安装 CA(Windows:`certutil -user -addstore Root`)
- `cert` — 显示 CA 路径与指纹

调试:设 `KIRO_RELAY_DEBUG=1` 打开 DEBUG 日志。

## 常见问题

- **Kiro 无响应 / 握手失败**:CA 没装或没重启 Kiro。跑 `doctor`。
- **透传报 ECONNREFUSED 127.0.0.1:443**:hosts 里有 `127.0.0.1 ...kiro.dev` 残留(旧抓包工具留下的)。`doctor` 会指出,手动删掉那行(管理员权限编辑 `C:\Windows\System32\drivers\etc\hosts`)。
- **中转站返回 4xx/5xx**:看 `[relay]` 错误日志里的状态码和响应片段,通常是 apiKey 或模型名不对。

## 测试

```bash
node test/e2e.mjs         # 转换链:Kiro→OpenAI→Kiro
node test/proxy-e2e.mjs   # 代理层:CONNECT→TLS 解密→改道→回写
```
