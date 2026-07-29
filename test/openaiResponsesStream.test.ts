import assert from "node:assert/strict";
import test from "node:test";
import type { CwEvent, CwRequest } from "../src/cwTypes";
import { decodeReasoningEnvelope } from "../src/providers/reasoningEnvelope";
import { providerFor } from "../src/providers/registry";
import { OpenAIResponsesStreamConverter } from "../src/providers/openaiResponsesStream";
import type { ProviderDeps } from "../src/providers/types";

function pushEvent(
  converter: OpenAIResponsesStreamConverter,
  event: Record<string, unknown>,
): CwEvent[] {
  const chunk = `data: ${JSON.stringify(event)}\r\n\r\n`;
  const split = Math.max(1, Math.floor(chunk.length / 2));
  return [
    ...converter.processLine(chunk.slice(0, split)),
    ...converter.processLine(chunk.slice(split)),
  ];
}

test("Responses 事件映射文本、推理、工具、usage 和加密信封", () => {
  const converter = new OpenAIResponsesStreamConverter("conversation-1", "gpt-test");
  const output: CwEvent[] = [];
  const events = [
    { type: "response.output_text.delta", delta: "你好" },
    { type: "response.reasoning_summary_text.delta", delta: "检查文件" },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "rs_1",
        type: "reasoning",
        encrypted_content: "cipher",
        summary: [],
      },
    },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "fc_1",
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: "",
      },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: "fc_1",
      output_index: 1,
      delta: "{\"path\":" ,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      output_index: 1,
      arguments: "{\"path\":\"a.ts\"}",
    },
    {
      type: "response.completed",
      response: {
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [],
      },
    },
  ];

  for (const event of events) {
    output.push(...pushEvent(converter, event));
  }
  output.push(...converter.flush());

  assert.deepEqual(output.find((event) => event.messageMetadataEvent), {
    messageMetadataEvent: { conversationId: "conversation-1" },
  });
  assert.deepEqual(output.find((event) => event.assistantResponseEvent), {
    assistantResponseEvent: { content: "你好", modelId: "gpt-test" },
  });
  assert.deepEqual(output.find((event) => event.reasoningContentEvent?.text), {
    reasoningContentEvent: { text: "检查文件" },
  });
  assert.deepEqual(output.filter((event) => event.toolUseEvent), [{
    toolUseEvent: {
      toolUseId: "call-1",
      name: "read_file",
      input: "{\"path\":\"a.ts\"}",
    },
  }]);
  assert.deepEqual(output.find((event) => event.metadataEvent), {
    metadataEvent: { type: "token_usage", inputTokens: 10, outputTokens: 5 },
  });
  const signature = output.find((event) => event.reasoningContentEvent?.signature)
    ?.reasoningContentEvent?.signature;
  assert.deepEqual(decodeReasoningEnvelope(signature ?? ""), {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "cipher",
    summary: [],
  });
  assert.deepEqual(converter.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(converter.committed, true);
  assert.equal(converter.terminalError, undefined);
});

test("Responses 事件错误只暴露净化后的终态", () => {
  const converter = new OpenAIResponsesStreamConverter("conversation-1", "gpt-test");
  pushEvent(converter, {
    type: "error",
    code: "server_error",
    message: "encrypted_content=cipher-secret",
  });

  assert.match(converter.terminalError ?? "", /stream error/i);
  assert.doesNotMatch(converter.terminalError ?? "", /cipher-secret|encrypted_content/);
  assert.equal(converter.committed, false);
});

test("Responses 事件兼容缺少 item id 和 output index 的工具开始事件", () => {
  const converter = new OpenAIResponsesStreamConverter("conversation-1", "gpt-test");
  const output: CwEvent[] = [];
  output.push(...pushEvent(converter, {
    type: "response.output_item.added",
    item: {
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: "",
    },
  }));
  output.push(...pushEvent(converter, {
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    output_index: 0,
    delta: "{\"path\":" ,
  }));
  output.push(...pushEvent(converter, {
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    output_index: 0,
    arguments: "{\"path\":\"a.ts\"}",
  }));

  assert.deepEqual(output.filter((event) => event.toolUseEvent), [{
    toolUseEvent: {
      toolUseId: "call-1",
      name: "read_file",
      input: "{\"path\":\"a.ts\"}",
    },
  }]);
});

test("Responses 事件 failed 和 incomplete 都设置安全终态", () => {
  for (const type of ["response.failed", "response.incomplete"]) {
    const converter = new OpenAIResponsesStreamConverter("conversation-1", "gpt-test");
    pushEvent(converter, {
      type,
      response: { error: { code: "upstream_error", message: "cipher-secret" } },
    });
    assert.match(converter.terminalError ?? "", /OpenAI response/);
    assert.doesNotMatch(converter.terminalError ?? "", /cipher-secret/);
    assert.equal(converter.committed, false);
  }
});

test("Responses 事件 Provider 注册到原生 /responses", async () => {
  const request: CwRequest = {
    conversationState: {
      currentMessage: { userInputMessage: { content: "hello", modelId: "MODEL" } },
    },
  };
  const deps: ProviderDeps = {
    version: "1.8.0",
    getApiKey: () => "secret",
    getBaseUrl: () => "https://relay.example/v1",
    resolveModel: () => "gpt-test",
    getMaxTokens: () => 32000,
    getEffort: async () => "max",
    getReasoningMode: () => undefined,
  };

  const prepared = await providerFor("openai-responses", deps).prepare(request);
  const body = JSON.parse(prepared.body);
  assert.equal(prepared.url, "https://relay.example/v1/responses");
  assert.equal(prepared.headers.Authorization, "Bearer secret");
  assert.equal(prepared.headers["x-api-key"], undefined);
  assert.equal(prepared.headers["X-Client"], "api2kiro/1.8.0");
  assert.equal(body.model, "gpt-test");
  assert.deepEqual(body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.notEqual(
    prepared.createConverter("conversation-1"),
    prepared.createConverter("conversation-1"),
  );
});
