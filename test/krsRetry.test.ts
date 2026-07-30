import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { AnthropicStreamConverter } from "../src/anthropicStream";
import type { CwEvent } from "../src/cwTypes";
import { OpenAIResponsesStreamConverter } from "../src/providers/openaiResponsesStream";
import type { PreparedProviderRequest } from "../src/providers/types";
import {
  runPreparedWithRetry,
  type ProviderSink,
  type ProviderTransport,
} from "../src/providerRunner";
import type { UpstreamResponse } from "../src/upstream";

function sse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function response(
  statusCode: number,
  chunks: string[],
  streamError?: Error,
): UpstreamResponse {
  let sent = false;
  const body = new Readable({
    read() {
      if (sent) {
        return;
      }
      sent = true;
      for (const chunk of chunks) {
        this.push(chunk);
      }
      if (streamError) {
        this.destroy(streamError);
      } else {
        this.push(null);
      }
    },
  });
  return { statusCode, headers: {}, body: body as UpstreamResponse["body"] };
}

function httpError(statusCode: number): UpstreamResponse {
  return response(statusCode, ["temporary"]);
}

function responsesText(text: string): UpstreamResponse {
  return response(200, [sse([
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
    },
  ])]);
}

function anthropicTextWithDuplicate(text: string): UpstreamResponse {
  return response(200, [sse([
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", content_block: { type: "text" } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "content_block_delta", delta: { type: "text_delta", text } },
    { type: "content_block_stop" },
    { type: "message_stop" },
  ])]);
}

function anthropicToolWithDuplicateInput(input: string): UpstreamResponse {
  return response(200, [sse([
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    {
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tool-1", name: "read_file" },
    },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: input } },
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: input } },
    { type: "content_block_stop" },
    { type: "message_stop" },
  ])]);
}

function responsesToolThenError(): UpstreamResponse {
  return response(200, [sse([
    {
      type: "response.output_item.added",
      output_index: 0,
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
      output_index: 0,
      arguments: "{\"path\":\"a.ts\"}",
    },
  ])], new Error("socket contained cipher-secret"));
}

function responsesErrorBeforeOutput(): UpstreamResponse {
  return response(200, [sse([{
    type: "error",
    code: "server_error",
    message: "cipher-secret",
  }])]);
}

function sequenceTransport(responses: UpstreamResponse[]): ProviderTransport & { calls: number } {
  return {
    calls: 0,
    async request() {
      const index = this.calls++;
      const item = responses[index];
      if (!item) {
        throw new Error("unexpected upstream call");
      }
      return item;
    },
  };
}

function recordingSink(): ProviderSink & {
  events: CwEvent[];
  failures: string[];
  begins: number;
  ends: number;
  text(): string;
} {
  return {
    events: [],
    failures: [],
    begins: 0,
    ends: 0,
    begin() {
      this.begins++;
    },
    write(event) {
      this.events.push(event);
    },
    fail(message) {
      this.failures.push(message);
    },
    end() {
      this.ends++;
    },
    text() {
      return JSON.stringify({ events: this.events, failures: this.failures });
    },
  };
}

function fakePreparedRequest(): PreparedProviderRequest {
  return {
    url: "https://relay.example/v1/responses",
    headers: { Authorization: "Bearer test" },
    body: "{}",
    modelId: "gpt-test",
    createConverter: (conversationId) =>
      new OpenAIResponsesStreamConverter(conversationId, "gpt-test"),
  };
}

function fakeAnthropicPreparedRequest(): PreparedProviderRequest {
  return {
    url: "https://relay.example/v1/messages",
    headers: { "x-api-key": "test" },
    body: "{}",
    modelId: "claude-test",
    createConverter: (conversationId) =>
      new AnthropicStreamConverter(conversationId, "claude-test"),
  };
}

test("未输出事件时 429 可重试", async () => {
  const upstream = sequenceTransport([httpError(429), responsesText("ok")]);
  const sink = recordingSink();
  await runPreparedWithRetry(fakePreparedRequest(), upstream, sink, { maxRetries: 1 });

  assert.equal(upstream.calls, 2);
  assert.match(sink.text(), /ok/);
  assert.equal(sink.begins, 1);
  assert.equal(sink.ends, 1);
});

test("输出工具事件后流失败不重试", async () => {
  const upstream = sequenceTransport([
    responsesToolThenError(),
    responsesText("duplicate"),
  ]);
  const sink = recordingSink();
  await runPreparedWithRetry(fakePreparedRequest(), upstream, sink, { maxRetries: 1 });

  assert.equal(upstream.calls, 1);
  assert.equal(sink.events.filter((event) => event.toolUseEvent).length, 1);
  assert.doesNotMatch(sink.text(), /duplicate|cipher-secret/);
  assert.equal(sink.failures.length, 1);
  assert.equal(sink.ends, 1);
});

test("未输出事件时流终态错误可重试", async () => {
  const upstream = sequenceTransport([
    responsesErrorBeforeOutput(),
    responsesText("recovered"),
  ]);
  const sink = recordingSink();
  await runPreparedWithRetry(fakePreparedRequest(), upstream, sink, { maxRetries: 1 });

  assert.equal(upstream.calls, 2);
  assert.match(sink.text(), /recovered/);
  assert.doesNotMatch(sink.text(), /server_error|cipher-secret/);
});

test("流诊断只记录 SSE 摘要和转换计数", async () => {
  const upstream = sequenceTransport([responsesText("重复片段")]);
  const sink = recordingSink();
  const records: Array<{
    attempt: number;
    type?: string;
    payloadBytes: number;
    payloadHash: string;
    convertedEvents: number;
    assistantEvents: number;
  }> = [];

  await runPreparedWithRetry(fakePreparedRequest(), upstream, sink, {
    maxRetries: 0,
    onSseRecord: (record) => records.push(record),
  });

  assert.deepEqual(records.map((record) => ({
    attempt: record.attempt,
    type: record.type,
    payloadBytes: record.payloadBytes > 0,
    payloadHash: /^[a-f0-9]{64}$/.test(record.payloadHash),
    convertedEvents: record.convertedEvents,
    assistantEvents: record.assistantEvents,
  })), [
    {
      attempt: 1,
      type: "response.output_text.delta",
      payloadBytes: true,
      payloadHash: true,
      convertedEvents: 2,
      assistantEvents: 1,
    },
    {
      attempt: 1,
      type: "response.completed",
      payloadBytes: true,
      payloadHash: true,
      convertedEvents: 1,
      assistantEvents: 0,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(records), /重复片段/);
});

test("重复的 Anthropic 文本 delta 只展示一次", async () => {
  const upstream = sequenceTransport([anthropicTextWithDuplicate("重复片段")]);
  const sink = recordingSink();
  const records: Array<{ deduplicated?: boolean }> = [];

  await runPreparedWithRetry(fakeAnthropicPreparedRequest(), upstream, sink, {
    maxRetries: 0,
    onSseRecord: (record) => records.push(record),
  });

  assert.equal(
    sink.events.filter((event) => event.assistantResponseEvent).length,
    1,
  );
  assert.equal(records.filter((record) => record.deduplicated).length, 1);
});

test("重复的 Anthropic 工具 JSON delta 不去重", async () => {
  const upstream = sequenceTransport([anthropicToolWithDuplicateInput('{"path":"a.ts"}')]);
  const sink = recordingSink();
  const records: Array<{ deduplicated?: boolean }> = [];

  await runPreparedWithRetry(fakeAnthropicPreparedRequest(), upstream, sink, {
    maxRetries: 0,
    onSseRecord: (record) => records.push(record),
  });

  assert.equal(records.filter((record) => record.deduplicated).length, 0);
  assert.equal(
    sink.events.find((event) => event.toolUseEvent)?.toolUseEvent?.input,
    '{"path":"a.ts"}{"path":"a.ts"}',
  );
});
