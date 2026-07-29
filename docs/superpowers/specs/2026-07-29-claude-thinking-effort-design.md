# Claude 思考档位设计

## 目标

在 API2Kiro 的 `Claude`（Anthropic Messages `/v1/messages`）模式中，Kiro 聊天输入框也显示 `Low`、`Medium`、`High`、`XHigh`、`Max` 思考档位选择器。用户按对话选择档位，体验与 GPT Responses 模式一致。

## 范围和兼容性

- 仅修改 `silver-builds-autumn/Kiro-Model-Bridge` 的功能分支，不修改 `api2kiro-source`。
- 不增加侧边栏中的第二套档位控件。档位仍由 Kiro 原生聊天 UI 选择，避免侧边栏值与当前对话值冲突。
- 沿用现有 `api2kiro.effortMode` 和 `api2kiro.effortBudgets`：
  - `auto` 和 `thinkingBudget` 在 Claude 模式下公开全部五档，并映射为原生 Anthropic thinking token 预算。
  - `off` 继续不公开选择器，也不发送 thinking。
  - `modelVariant` 仅在中转站实际发现 `<model>-<effort>` 变体时公开相应档位；Claude 直连不猜测模型变体。
- 档位预算继续为 `low=2048`、`medium=4096`、`high=8192`、`xhigh=16384`、`max=24576`，用户可通过 `api2kiro.effortBudgets` 覆盖。

## 请求和响应流程

1. CPS 给 Claude 模型返回 Kiro 所需的 `output_config.effort` schema，使 Kiro 展示输入框旁的档位下拉。
2. Kiro 把所选档位附在本地 KRS 请求的 `output_config.effort` 中。
3. Claude Provider 读取该档位，计算对应预算，并构造标准 Anthropic 请求：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 8192
  }
}
```

4. Claude Provider 在发往上游前删除 `output_config`，绝不把 Kiro 私有字段发送给标准 Anthropic `/v1/messages` 接口。
5. 上游返回的 Anthropic `thinking` SSE 块继续走现有 reasoning/signature 转换路径。

如果中转站不支持 Anthropic extended thinking，保留上游的净化错误响应，不自动降级重试为无思考请求。用户可以把 `api2kiro.effortMode` 设为 `off`；自动忽略已选择的档位会造成难以察觉的行为偏差。

## 实现边界

- CPS 的 Anthropic 分支不再无条件隐藏 effort schema；它依据上述 `effortMode` 决定是否下发。
- 增加一个仅供 Claude Provider 使用的映射函数，复用现有预算校验逻辑，确保 `budget_tokens` 小于 `max_tokens` 且不低于 Anthropic 的最小值。
- GPT Responses 的 `reasoning.effort` 映射、Kiro 兼容模式的 `output_config` 透传、模型发现缓存和 SecretStorage 不变。

## 验证

- CPS 单元测试：Claude mode 在 `auto`/`thinkingBudget` 暴露五档，在 `off` 不暴露。
- Provider 单元测试：每个 Claude 档位生成正确的 native `thinking.budget_tokens`，且上游 body 没有 `output_config`。
- 回归测试：`thinking=disabled` 不发送 thinking；GPT Responses 仍发送 `reasoning.effort`。
- 运行 `npm test`、`npm run compile`、`npm run bundle`、`npm run package` 和 `npm run scan:secrets`。
- 仅在获得单独安装批准后安装 VSIX，并在 Claude 聊天输入框确认档位下拉出现及请求实际生效。
