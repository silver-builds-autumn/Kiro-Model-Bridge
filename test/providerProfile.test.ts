import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  normalizeProviderId,
  profileKeys,
  resolveProviderApiUrl,
} from "../src/providerProfile";

test("每种 Provider 使用独立配置键", () => {
  assert.deepEqual(profileKeys("kiro"), {
    baseUrl: "baseUrl",
    defaultModel: "defaultModel",
    modelMapping: "modelMapping",
  });
  assert.deepEqual(profileKeys("anthropic"), {
    baseUrl: "officialBaseUrl",
    defaultModel: "officialDefaultModel",
    modelMapping: "officialModelMapping",
  });
  assert.deepEqual(profileKeys("openai-responses"), {
    baseUrl: "openaiBaseUrl",
    defaultModel: "openaiDefaultModel",
    modelMapping: "openaiModelMapping",
  });
});

test("非法 Provider 回落到 Kiro", () => {
  assert.equal(normalizeProviderId("openai-responses"), "openai-responses");
  assert.equal(normalizeProviderId("openai-chat"), "kiro");
});

test("Provider API 地址只补一次版本路径", () => {
  assert.equal(
    resolveProviderApiUrl("https://relay.example", "/responses"),
    "https://relay.example/v1/responses",
  );
  assert.equal(
    resolveProviderApiUrl("https://relay.example/v1/", "models"),
    "https://relay.example/v1/models",
  );
  assert.equal(resolveProviderApiUrl("", "/models"), "");
});

test("扩展配置公开三种模式但不公开 OpenAI 明文 Key", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const properties = pkg.contributes.configuration.properties;

  assert.deepEqual(properties["api2kiro.mode"].enum, [
    "kiro",
    "anthropic",
    "openai-responses",
  ]);
  assert.equal(properties["api2kiro.openaiBaseUrl"].type, "string");
  assert.equal(properties["api2kiro.openaiDefaultModel"].type, "string");
  assert.equal(properties["api2kiro.openaiModelMapping"].type, "object");
  assert.equal(properties["api2kiro.openaiApiKey"], undefined);
});
