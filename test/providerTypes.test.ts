import assert from "node:assert/strict";
import test from "node:test";
import { isProviderId } from "../src/providers/types";

test("只接受三种 Provider ID", () => {
  assert.equal(isProviderId("kiro"), true);
  assert.equal(isProviderId("anthropic"), true);
  assert.equal(isProviderId("openai-responses"), true);
  assert.equal(isProviderId("openai-chat"), false);
});
