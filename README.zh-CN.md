[English](./README.md) | 简体中文

# API2Kiro 多 Provider 衍生版

这个本地 VSIX 可把 [Kiro](https://kiro.dev) 接入 Kiro 兼容、Anthropic Messages 或 OpenAI Responses 中转站，同时保留 Kiro 需要的 AWS event-stream 接口。

> 安全提醒：任何曾发布在聊天、Issue、日志或截图里的 API Key 都必须先撤销并轮换。安装后只通过本地侧边栏输入新 Key。

<p align="center">
  <img src="./assets/panel.png" alt="API2Kiro 控制面板" width="360">
</p>

## Provider 模式

| 模式 | 上游端点 | 认证方式 |
| --- | --- | --- |
| `kiro` | `/v1/messages` | Kiro 兼容的 Anthropic 请求头 |
| `anthropic` | `/v1/messages` | Anthropic 请求头及 Bearer 兼容认证 |
| `openai-responses` | `/v1/responses` | 仅 Bearer |

三种模式各自保存独立 Profile：API Key、中转地址、默认模型、模型映射和模型发现缓存不会串用。Key 保存在 VS Code/Kiro `SecretStorage`，不写入扩展设置；旧版明文值只有在 SecretStorage 写入并精确回读成功后才清除。

## 运行行为

- KRS 监听 `127.0.0.1:19800`，把 CodeWhisperer 请求转换为当前 Provider 格式，再把上游 SSE 转回 Kiro 的 AWS event-stream 帧。
- CPS 监听 `127.0.0.1:19801`，处理模型列表和控制面请求。
- `/v1/models` 自动发现兼容 `{data:[...]}`、`{models:[...]}` 和原始数组。发现失败时，只显示当前 Profile 手工配置的默认模型和映射模型。
- OpenAI Responses 使用原生 function tool、`function_call`、`function_call_output`、reasoning summary、图片和无状态 encrypted reasoning。
- OpenAI 加密 reasoning 会封装进带版本的 Kiro reasoning 签名，用于下一轮工具回放。外部前缀、损坏或缺失的信封会被丢弃，但工具结果和普通对话仍会继续，不会因 reasoning 降级而中断。
- 只有在尚未输出正文、推理或工具事件前才允许重试；一旦已输出，流错误只报告一次，禁止重放。

## 安装与配置

1. 用 `Extensions: Install from VSIX` 安装 `api2kiro-1.8.0.vsix`，然后重新加载 Kiro。
2. 打开 API2Kiro 侧边栏并选择 Provider 模式。
3. 输入该模式的中转地址、新轮换的 API Key，以及可选的默认模型/模型映射。
4. 切换模式或端点配置后重新加载 Kiro。

模型发现会自动执行。如果中转站不提供 `/v1/models`，请在当前 Profile 中手工配置默认模型或映射。

## 配置项

| 配置 | 说明 |
| --- | --- |
| `api2kiro.mode` | `kiro`、`anthropic` 或 `openai-responses` |
| `api2kiro.baseUrl` / `officialBaseUrl` / `openaiBaseUrl` | 三种模式相互隔离的中转地址 |
| `api2kiro.defaultModel` / `officialDefaultModel` / `openaiDefaultModel` | 各模式的手工兜底模型 |
| `api2kiro.modelMapping` / `officialModelMapping` / `openaiModelMapping` | 各模式的 Kiro 到上游模型映射 |
| `api2kiro.maxTokens` | 最大输出 token |
| `api2kiro.autoRetry` / `api2kiro.maxRetries` | 仅输出前生效的安全重试策略 |
| `api2kiro.port` / `api2kiro.cpsPort` | 多窗口共享的本地代理端口 |

API Key 不属于公开配置项，只能通过侧边栏和 SecretStorage 管理。

## 构建与验证

需要 Node.js 18+ 和 PowerShell 7。

```powershell
npm install
npm test
npm run compile
npm run bundle
npm run package
npm run scan:secrets
```

`npm run package` 生成 `api2kiro-1.8.0.vsix`。使用 `Extensions: Install from VSIX` 本地安装。需要回滚时，用同一命令重新安装已知可用的旧版 VSIX 并重新加载 Kiro。保留的 `api2kiro.api2kiro` 身份用于本地原位升级/回滚；本衍生版不是上游 Marketplace 发布。

## 归属说明

本仓库是 [SunNorthGod/API2Kiro](https://github.com/SunNorthGod/API2Kiro) 的衍生构建，由 [silver-builds-autumn/Kiro-Model-Bridge](https://github.com/silver-builds-autumn/Kiro-Model-Bridge) 维护。准确的衍生状态见 [NOTICE](./NOTICE)。为满足 MIT 许可及本地 VSIX 原位升级兼容，保留上游许可证和 publisher/name。

同时感谢 [kiro2cc-proxy](https://github.com/TsinHzl/kiro2cc-proxy) 及 Kiro 互操作社区此前在端点重定向和事件流转换方面的探索。

## 许可

[MIT](./LICENSE)
