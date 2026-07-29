import assert from "node:assert/strict";
import test from "node:test";
import type { CwEvent, CwRequest } from "../src/cwTypes";
import { runPreparedWithRetry } from "../src/providerRunner";
import { createOpenAIResponsesProvider } from "../src/providers/openaiResponsesProvider";
import type { ProviderDeps } from "../src/providers/types";
import { requestUpstream } from "../src/upstream";
import { cwToolResultRequest, initialCwRequest } from "./helpers/cwFixtures";
import { readRequestBody, startFakeProvider, writeSse } from "./helpers/fakeServers";

interface ProviderTurnResult {
  receivedBody: string;
  events: CwEvent[];
  reasoningSignature?: string;
}

async function executeProviderTurn(
  responseEvents: Array<Record<string, unknown>>,
  request: CwRequest,
): Promise<ProviderTurnResult> {
  let receivedBody = "";
  let authorization = "";
  const fake = await startFakeProvider({
    "POST /v1/responses": async (req, res) => {
      authorization = String(req.headers.authorization ?? "");
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
      resolveModel: () => "gpt-test",
      getMaxTokens: () => 32000,
      getEffort: async () => "high",
      getReasoningMode: () => undefined,
    };
    const prepared = await createOpenAIResponsesProvider(deps).prepare(request);
    await runPreparedWithRetry(
      prepared,
      {
        request: (item) => requestUpstream("POST", item.url, item.headers, item.body),
      },
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
  assert.deepEqual(failures, []);
  return {
    receivedBody,
    events,
    reasoningSignature: events.find((event) => event.reasoningContentEvent?.signature)
      ?.reasoningContentEvent?.signature,
  };
}

test("Responses 两轮工具回放 function output 和 encrypted reasoning", async () => {
  const firstResponseEvents = [
    { type: "response.reasoning_summary_text.delta", delta: "读取文件" },
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
      type: "response.function_call_arguments.done",
      item_id: "fc_1",
      output_index: 1,
      arguments: "{\"path\":\"a.ts\"}",
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] },
    },
  ];
  const first = await executeProviderTurn(firstResponseEvents, initialCwRequest());
  assert.ok(first.reasoningSignature);
  assert.equal(first.events.filter((event) => event.toolUseEvent).length, 1);

  const second = await executeProviderTurn(
    [{
      type: "response.completed",
      response: { usage: { input_tokens: 15, output_tokens: 2 }, output: [] },
    }],
    cwToolResultRequest("call-1", "file body", first.reasoningSignature),
  );
  const secondBody = JSON.parse(second.receivedBody) as {
    input: Array<Record<string, unknown>>;
  };
  const toolOutput = secondBody.input.find((item) => item.type === "function_call_output");
  const reasoning = secondBody.input.find((item) => item.type === "reasoning");
  assert.equal(toolOutput?.call_id, "call-1");
  assert.equal(toolOutput?.output, "file body");
  assert.equal(reasoning?.encrypted_content, "cipher");
});
