import assert from "node:assert/strict";
import test from "node:test";
import type { CwEvent, CwRequest } from "../src/cwTypes";
import { runPreparedWithRetry } from "../src/providerRunner";
import { createAnthropicProvider } from "../src/providers/anthropicProvider";
import type { ProviderDeps } from "../src/providers/types";
import { requestUpstream } from "../src/upstream";
import { cwToolResultRequest, initialCwRequest } from "./helpers/cwFixtures";
import { readRequestBody, startFakeProvider, writeSse } from "./helpers/fakeServers";

async function executeAnthropicTurn(
  responseEvents: Array<Record<string, unknown>>,
  request: CwRequest,
): Promise<{ receivedBody: string; events: CwEvent[] }> {
  let receivedBody = "";
  let authorization = "";
  let apiKey = "";
  const fake = await startFakeProvider({
    "POST /v1/messages": async (req, res) => {
      authorization = String(req.headers.authorization ?? "");
      apiKey = String(req.headers["x-api-key"] ?? "");
      receivedBody = await readRequestBody(req);
      writeSse(res, responseEvents);
    },
  });
  const events: CwEvent[] = [];
  const failures: string[] = [];
  try {
    const deps: ProviderDeps = {
      version: "1.8.0",
      getApiKey: () => "test-key",
      getBaseUrl: () => fake.baseUrl,
      resolveModel: () => "claude-test",
      getMaxTokens: () => 32000,
      getEffort: async () => undefined,
      getEffortBudget: () => 0,
      getReasoningMode: () => undefined,
    };
    const prepared = await createAnthropicProvider("anthropic", deps).prepare(request);
    await runPreparedWithRetry(
      prepared,
      { request: (item) => requestUpstream("POST", item.url, item.headers, item.body) },
      {
        begin: () => undefined,
        write: (event) => { events.push(event); },
        fail: (message) => { failures.push(message); },
        end: () => undefined,
      },
      { maxRetries: 0, conversationId: "conversation-1" },
    );
  } finally {
    await fake.close();
  }

  assert.equal(authorization, "Bearer test-key");
  assert.equal(apiKey, "test-key");
  assert.deepEqual(failures, []);
  return { receivedBody, events };
}

test("Anthropic 回归保留 thinking 签名和工具参数", async () => {
  const anthropicEvents = [
    { type: "message_start", message: { usage: { input_tokens: 8 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "分析" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signed-thinking" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tool-1", name: "read_file" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
  const first = await executeAnthropicTurn(anthropicEvents, initialCwRequest());
  const signature = first.events.find((event) => event.reasoningContentEvent?.signature)
    ?.reasoningContentEvent?.signature;
  assert.equal(signature, "signed-thinking");
  assert.deepEqual(first.events.find((event) => event.toolUseEvent)?.toolUseEvent, {
    toolUseId: "tool-1",
    name: "read_file",
    input: "{\"path\":\"a.ts\"}",
  });

  const second = await executeAnthropicTurn(
    [
      { type: "message_start", message: { usage: { input_tokens: 12 } } },
      { type: "message_stop" },
    ],
    cwToolResultRequest("tool-1", "file body", signature),
  );
  const secondBody = JSON.parse(second.receivedBody) as {
    messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  };
  const thinking = secondBody.messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((content) => content.type === "thinking");
  assert.deepEqual(thinking, {
    type: "thinking",
    thinking: "读取文件",
    signature: "signed-thinking",
  });
});
