import assert from "node:assert/strict";
import test from "node:test";
import { SseParser } from "../src/sseParser";

test("SSE 支持 CRLF、跨 chunk 和无尾换行 flush", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: response.output_text.delta\r\nda"), []);
  const events = parser.push("ta: {\"delta\":\"你\"}\r\n\r\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "response.output_text.delta");
  assert.equal(events[0].data, "{\"delta\":\"你\"}");

  parser.push("data: {\"type\":\"response.completed\"}");
  assert.equal(parser.flush()[0].data, "{\"type\":\"response.completed\"}");
});

test("SSE 合并多行 data 并忽略注释", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": keepalive\ndata: first\ndata: second\n\n"), [{
    data: "first\nsecond",
  }]);
});
