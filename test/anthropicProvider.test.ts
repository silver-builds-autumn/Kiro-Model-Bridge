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

function fakeProviderDeps(effort?: ProviderEffort): ProviderDeps {
  return {
    version: "1.8.0",
    getApiKey: () => "secret",
    getBaseUrl: () => "https://relay.example",
    resolveModel: () => "claude-test",
    getMaxTokens: () => 32000,
    getEffort: async () => effort,
    getReasoningMode: () => undefined,
  };
}

test("Anthropic 模式剥离 Kiro 私有字段并发送双认证", async () => {
  const prepared = await createAnthropicProvider(
    "anthropic",
    fakeProviderDeps("high"),
  ).prepare(cwRequest());
  const body = JSON.parse(prepared.body);

  assert.equal(prepared.url, "https://relay.example/v1/messages");
  assert.equal(body.model, "claude-test");
  assert.equal(body.max_tokens, 32000);
  assert.equal(body.output_config, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(prepared.headers.Authorization, "Bearer secret");
  assert.equal(prepared.headers["x-api-key"], "secret");
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
