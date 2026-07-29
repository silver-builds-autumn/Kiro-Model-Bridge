import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicProvider } from "../src/providers/anthropicProvider";
import type { CwRequest } from "../src/cwTypes";
import type { ProviderDeps, ProviderEffort } from "../src/providers/types";

function cwRequest(): CwRequest {
  return {
    conversationState: {
      currentMessage: {
        userInputMessage: { content: "hello", modelId: "MODEL" },
      },
    },
  };
}

function fakeProviderDeps(
  effort?: ProviderEffort,
  effortMode: "off" | "modelVariant" | "thinkingBudget" | "auto" = "auto",
  thinking?: { type: "enabled" | "disabled"; budget_tokens?: number },
): ProviderDeps {
  return {
    version: "1.8.0",
    getApiKey: () => "secret",
    getBaseUrl: () => "https://relay.example",
    resolveModel: () => "claude-test",
    getMaxTokens: () => 32000,
    getEffort: async () => effort,
    getEffortBudget: (selected) => ({
      low: 2048,
      medium: 4096,
      high: 8192,
      xhigh: 16384,
      max: 24576,
    })[selected],
    getReasoningMode: () => undefined,
    getEffortMode: () => effortMode,
    getThinkingConfig: () => thinking,
  };
}

test("Anthropic 模式把档位映射为原生 thinking 且不泄漏 Kiro 字段", async () => {
  for (const [effort, budget] of [
    ["low", 2048],
    ["medium", 4096],
    ["high", 8192],
    ["xhigh", 16384],
    ["max", 24576],
  ] as const) {
    const prepared = await createAnthropicProvider(
      "anthropic",
      fakeProviderDeps(effort),
    ).prepare(cwRequest());
    const body = JSON.parse(prepared.body);

    assert.equal(prepared.url, "https://relay.example/v1/messages");
    assert.equal(body.model, "claude-test");
    assert.equal(body.max_tokens, 32000);
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: budget });
    assert.equal(body.output_config, undefined);
    assert.equal(prepared.headers.Authorization, "Bearer secret");
    assert.equal(prepared.headers["x-api-key"], "secret");
  }
});

test("Anthropic 禁用思考时不发送 thinking", async () => {
  const prepared = await createAnthropicProvider(
    "anthropic",
    fakeProviderDeps("high", "auto", { type: "disabled" }),
  ).prepare(cwRequest());
  const body = JSON.parse(prepared.body);

  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
});

test("Kiro 模式保留 output_config effort", async () => {
  const prepared = await createAnthropicProvider(
    "kiro",
    fakeProviderDeps("high"),
  ).prepare(cwRequest());

  assert.deepEqual(JSON.parse(prepared.body).output_config, { effort: "high" });
  assert.equal(prepared.headers.Authorization, undefined);
});

test("成熟 Provider 保留签名 thinking 历史", async () => {
  const request = cwRequest();
  request.conversationState.history = [{
    assistantResponseMessage: {
      content: "working",
      reasoningContent: {
        reasoningText: { text: "analysis", signature: "signed-thinking" },
      },
    },
  }];
  const prepared = await createAnthropicProvider(
    "anthropic",
    fakeProviderDeps(),
  ).prepare(request);
  const body = JSON.parse(prepared.body);

  assert.deepEqual(body.messages[0].content[0], {
    type: "thinking",
    thinking: "analysis",
    signature: "signed-thinking",
  });
});

test("Anthropic 流只在输出内容后标记 committed", async () => {
  const prepared = await createAnthropicProvider(
    "kiro",
    fakeProviderDeps(),
  ).prepare(cwRequest());
  const converter = prepared.createConverter("conversation-1");

  converter.processLine('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}');
  assert.equal(converter.committed, false);
  converter.processLine('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}');
  assert.equal(converter.committed, true);
  assert.equal(converter.terminalError, undefined);
});
