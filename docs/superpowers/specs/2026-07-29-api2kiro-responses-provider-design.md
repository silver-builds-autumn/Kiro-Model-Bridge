# API2Kiro 多协议单站点接入设计

日期：2026-07-29

## 1. 目标

在用户自有仓库 `silver-builds-autumn/Kiro-Model-Bridge` 中构建 API2Kiro 的衍生版本，使 Kiro 可以在以下三种单站点模式之间切换：

- Kiro 深度兼容中转；
- Anthropic Messages，端点为 `/v1/messages`；
- OpenAI Responses，端点为 `/v1/responses`。

GPT 与 Claude 分别保存地址、Key、默认模型及模型映射。模型优先从 `/v1/models` 自动发现，失败时使用手动兜底配置。第一版必须支持文本流、图片、工具调用与续轮、reasoning/thinking、模型列表、错误回写和安全重试。

交付版本为 `1.8.0`，产物名为 `api2kiro-1.8.0.vsix`。原始 `api2kiro-1.7.14.vsix` 保留，不覆盖、不修改。

## 2. 仓库与许可边界

- 所有设计文档、源码、测试和提交只进入 `silver-builds-autumn/Kiro-Model-Bridge`。
- `SunNorthGod/API2Kiro` 及本地 `api2kiro-source` 仅作只读参考，不产生修改或提交。
- 目标仓库允许直接替换现有简易 CLI 实现；实际删除或替换文件的清单在实施计划中列明。
- API2Kiro 为 MIT 许可。衍生版本必须保留许可证及原项目归属说明，并在 README 中说明参考来源，避免把上游成果表述为本仓库原创。
- VSIX 清单保持 `publisher=api2kiro`、`name=api2kiro` 和 `api2kiro` 配置命名空间，使 `1.8.0` 能在本机原位升级现有扩展；该身份只用于本地 VSIX 兼容，不得发布到 Marketplace。README、许可证和 NOTICE 必须明确标注衍生来源及本仓库维护者，不能把衍生改动冒充为上游官方发布。

## 3. 架构

保留 API2Kiro 的 KRS/CPS 本地服务、Kiro 端点重定向、事件流编码、错误回写和重试机制。在 KRS 的上游边界加入 Provider 接口：

```text
Kiro CodeWhisperer 请求
        |
        v
KRS：校验、意图分类、模型解析
        |
        v
当前 Provider
  |-- KiroCompatibleProvider
  |-- AnthropicProvider
  `-- OpenAIResponsesProvider
        |
        v
现有安全重试与 AWS event-stream 输出
        |
        v
Kiro
```

Provider 负责：

1. 生成 URL、认证头和请求体；
2. 转换历史、图片、工具和工具结果；
3. 增量解析 SSE；
4. 产出 API2Kiro 现有 `CwEvent`，包括文本、reasoning、工具、usage、完成和错误事件。

Anthropic Provider 只包装现有 `buildAnthropicRequest` 和 `AnthropicStreamConverter`，不得重写已验证的 thinking 签名、上下文统计和工具循环。OpenAI Responses 使用独立模块实现。Kiro-Model-Bridge 现有 Chat Completions 代码只参考工具参数拼接和流式解析思路，不直接作为 Responses 实现。

## 4. 配置与面板

模式为互斥选择：

- `kiro`：深度兼容；
- `anthropic`：Claude Messages；
- `openai-responses`：GPT Responses。

每个模式分别持久化：

- Base URL；
- 默认模型；
- Kiro 模型 ID 到上游模型 ID 的映射。

面板切换模式时恢复对应配置。Key 输入框不回显；空值保存表示保留已有 Key，另设明确的清除操作。修改协议、地址或 Key 后，使该配置对应的模型缓存失效，并提示重载 Kiro。

用量与费用显示维持现有兼容模式行为。Anthropic 与 Responses 模式若没有明确的标准计费接口，只显示本次响应 usage，不虚构余额或费用。

## 5. 凭据安全

三种模式的 Key 分别存入 VS Code `SecretStorage`，不再写入 `settings.json` 或普通 `globalState`。

迁移规则：

1. 激活时检测旧版明文 Key；
2. SecretStorage 中没有对应值时才执行迁移；
3. 写入后必须回读验证；
4. 验证成功后清除旧明文值；
5. 写入或回读失败时保留旧值并报告真实错误；
6. 不允许降级为新的明文存储。

Webview 只能接收 `hasKey`。日志、异常、测试快照和 VSIX 中不得出现真实 Key。用户已在对话中公开的旧 Key 不得用于开发或验证，必须轮换后仅在本地面板输入。

## 6. 模型发现

当前 Provider 通过其 Base URL 请求 `/v1/models`：

- OpenAI Responses 使用 `Authorization: Bearer <key>`；
- Anthropic 使用其兼容认证头；
- 深度兼容模式维持现有认证行为。

响应兼容常见的 `{data: [...]}`、`{models: [...]}` 和数组结构。缓存键至少包含 Provider 类型和规范化 Base URL，避免协议切换后串用旧模型。

自动发现失败时：

- 保留并展示错误原因；
- 使用当前模式的默认模型和模型映射；
- 不回退到其他 Provider 的缓存或 Key。

## 7. OpenAI Responses 请求转换

Responses 调用采用无状态模式，不依赖 `previous_response_id`，因为 Kiro 会携带完整历史，且第三方中转站未必持久化响应状态。

转换规则：

- 用户和助手文本转换为 Responses 消息项；
- 图片转换为 data URL 形式的图片输入项；
- Kiro 工具定义转换为 function tools；
- 历史工具调用转换为 function-call 项；
- 工具结果以相同 `call_id` 转换为 function-call-output 项；
- 请求启用流式响应并设置 `store: false`；
- Kiro reasoning effort 转换为 Responses `reasoning.effort`；
- `max` 映射到目标模型支持的最高合法档位，不静默发送非法枚举。

具体 Responses 字段和事件名在实施前以 OpenAI 官方文档及目标中转站实际协议为准。若中转站偏离官方协议，兼容逻辑必须局限在 OpenAI Provider 内，不能污染 Anthropic 或 Kiro Provider。

## 8. Reasoning 与工具续轮

Responses 推理模型的无状态工具续轮需要保留可回传的 encrypted reasoning：

1. 请求 reasoning summary 及可回传的 encrypted reasoning；
2. summary 增量输出为 `reasoningContentEvent.text`；
3. encrypted reasoning 编码为带版本和 Provider 前缀的不透明字符串，写入 `reasoningContentEvent.signature`；
4. 下一轮从 Kiro 历史识别该前缀并恢复 Responses reasoning 输入项；
5. Claude 签名与 GPT encrypted reasoning 使用不同前缀，禁止跨 Provider 解析。

不得把隐藏的模型思维链伪装为可展示内容；界面只展示上游明确返回的 reasoning summary。若中转站不返回 encrypted reasoning，普通对话仍可继续，但日志必须记录工具续轮处于降级状态，测试与文档不得宣称完整推理保持。

## 9. Responses 流转换

转换器必须增量处理：

- 输出文本增量；
- reasoning summary 增量；
- function call 开始、参数增量及结束；
- usage 与完成事件；
- failed、incomplete 及 error 事件。

SSE 解析必须支持任意网络分块、CRLF、单块多个事件以及末尾无换行。解析器提供显式 `flush()`，不得依赖每个事件都以换行结束。

上下文占用优先使用上游真实百分比。上游只返回 token 时，使用当前模型的已知上下文窗口估算，并明确这是估算值。

## 10. 错误与重试

沿用 API2Kiro 的提交边界：

- 连接失败、HTTP 429、HTTP 5xx 或流式失败，且尚未向 Kiro 输出正文、reasoning 或工具事件时，可以按配置重试；
- 一旦已输出任何用户可见或可执行事件，禁止重试，避免重复文本和重复执行工具；
- HTTP 4xx、Responses failed/incomplete/error 以及协议解析错误要转换为明确的 Kiro 错误信息；
- 日志记录状态码、事件类型和脱敏响应片段，不记录认证头和 Key。

## 11. 测试

### 11.1 单元测试

- 文本、图片、工具、工具结果和完整历史的请求转换；
- 默认模型、模型映射及 effort 合法化；
- encrypted reasoning 编码、解码、Provider 隔离及续轮回放；
- SSE 任意分块、CRLF、多事件、无尾换行；
- 文本、summary、函数参数、usage、完成和错误事件；
- SecretStorage 成功迁移、回读失败保留旧值、Webview 不泄露 Key；
- 模型缓存按 Provider/Base URL 隔离及失败兜底。

### 11.2 本地端到端测试

启动假的 `/v1/responses`、`/v1/messages` 和 `/v1/models` 服务，从 CodeWhisperer 请求一直验证到 AWS event-stream 帧，覆盖：

- 普通流式文本；
- 图片输入；
- 工具调用、工具结果及第二轮续接；
- reasoning summary 与 encrypted reasoning 往返；
- 未输出前重试；
- 输出后不重试；
- HTTP 和流式协议错误。

### 11.3 回归与打包

- Kiro 深度兼容模式回归；
- Anthropic thinking 签名与工具循环回归；
- TypeScript 类型检查；
- bundle 与 VSIX 打包；
- 包内版本、扩展 ID、README、许可证及敏感信息扫描；
- 核验产物名为 `api2kiro-1.8.0.vsix`，原 `1.7.14` 文件未变化。

没有现成性能基准，因此不承诺性能不恶化。验证只报告实际测得的功能结果和基本流式行为。

## 12. 文档与交付

更新中英文 README，说明：

- 三种 Provider 模式；
- Responses 支持范围与中转站兼容要求；
- 模型自动发现和手动兜底；
- SecretStorage 迁移；
- reasoning 降级条件；
- 本地构建、安装和回退方法；
- API2Kiro 与 Kiro-Model-Bridge 的来源和许可关系。

交付源码、测试和 `api2kiro-1.8.0.vsix`。不自动覆盖或安装现有扩展；安装及使用轮换后的真实 Key 联调需单独确认。提交只产生在 `silver-builds-autumn/Kiro-Model-Bridge` 对应仓库，推送远程需用户另行授权。
