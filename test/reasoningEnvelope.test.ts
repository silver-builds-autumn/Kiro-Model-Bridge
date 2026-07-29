import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeReasoningEnvelope,
  encodeReasoningEnvelope,
} from "../src/providers/reasoningEnvelope";

test("GPT reasoning 信封可往返且拒绝错误前缀和篡改", () => {
  const item = {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "cipher",
    summary: [],
  } as const;
  const signature = encodeReasoningEnvelope(item);

  assert.match(signature, /^api2kiro:oai-reasoning:v1:/);
  assert.deepEqual(decodeReasoningEnvelope(signature), item);
  assert.equal(decodeReasoningEnvelope("anthropic:signature"), undefined);
  assert.equal(decodeReasoningEnvelope(signature + "broken"), undefined);
});

test("GPT reasoning 信封拒绝缺少必填字段的载荷", () => {
  const prefix = "api2kiro:oai-reasoning:v1:";
  const invalidItems = [
    { type: "message", id: "rs_1", encrypted_content: "cipher", summary: [] },
    { type: "reasoning", id: "", encrypted_content: "cipher", summary: [] },
    { type: "reasoning", id: "rs_1", encrypted_content: "", summary: [] },
  ];

  for (const item of invalidItems) {
    const signature = prefix + Buffer.from(JSON.stringify(item), "utf8").toString("base64url");
    assert.equal(decodeReasoningEnvelope(signature), undefined);
  }
});
