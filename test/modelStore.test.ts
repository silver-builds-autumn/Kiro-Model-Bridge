import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchModelsForProfile,
  ModelCache,
  type ModelDiscoveryProfile,
} from "../src/modelStore";

const openaiProfile: ModelDiscoveryProfile = {
  provider: "openai-responses",
  baseUrl: "https://relay.example",
  apiKey: "secret",
  fallbackModels: [],
};

function fakeGetJson(calls: unknown[]) {
  return async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    return { data: [{ id: "gpt-test" }] };
  };
}

test("Responses 模型请求只发送 Bearer 认证", async () => {
  const calls: unknown[] = [];
  const models = await fetchModelsForProfile(openaiProfile, fakeGetJson(calls));

  assert.equal(models[0].id, "gpt-test");
  assert.deepEqual(calls[0], {
    url: "https://relay.example/v1/models",
    headers: { Authorization: "Bearer secret" },
  });
});

test("不同 Provider 不共享模型缓存", () => {
  const cache = new ModelCache();
  cache.set("openai-responses|https://relay.example", [
    { id: "gpt-test", name: "gpt-test", contextWindow: 0 },
  ]);

  assert.equal(cache.get("anthropic|https://relay.example"), undefined);
});

test("模型发现规范化 models 与数组响应", async () => {
  const fromModels = await fetchModelsForProfile(openaiProfile, async () => ({
    models: [{ modelId: "gpt-models" }],
  }));
  const fromArray = await fetchModelsForProfile(openaiProfile, async () => [
    { id: "gpt-array" },
  ]);

  assert.equal(fromModels[0].id, "gpt-models");
  assert.equal(fromArray[0].id, "gpt-array");
});

test("模型发现失败只返回当前 Profile 兜底并暴露错误", async () => {
  const errors: Error[] = [];
  const fallback = [{ id: "manual-gpt", name: "manual-gpt", contextWindow: 0 }];
  const models = await fetchModelsForProfile(
    { ...openaiProfile, fallbackModels: fallback },
    async () => { throw new Error("upstream unavailable"); },
    (error) => errors.push(error),
  );

  assert.deepEqual(models, fallback);
  assert.equal(errors[0].message, "upstream unavailable");
});
