import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchModelsForProfile,
  type RelayModel,
} from "../src/modelStore";
import type { ProviderId } from "../src/providers/types";
import { readBody, requestUpstream } from "../src/upstream";
import { startFakeProvider } from "./helpers/fakeServers";

async function discoverFromHttp(
  provider: ProviderId,
  responseBody: unknown,
  statusCode = 200,
  fallbackModels: RelayModel[] = [],
): Promise<{
  models: RelayModel[];
  authorization: string;
  apiKey: string;
  error?: Error;
}> {
  let authorization = "";
  let apiKey = "";
  const fake = await startFakeProvider({
    "GET /v1/models": (req, res) => {
      authorization = String(req.headers.authorization ?? "");
      apiKey = String(req.headers["x-api-key"] ?? "");
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    },
  });
  let error: Error | undefined;
  try {
    const models = await fetchModelsForProfile(
      { provider, baseUrl: fake.baseUrl, apiKey: "test-key", fallbackModels },
      async (url, headers) => {
        const response = await requestUpstream(
          "GET",
          url,
          { ...headers, Accept: "application/json" },
        );
        const body = await readBody(response.body);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`HTTP ${response.statusCode}`);
        }
        return JSON.parse(body) as unknown;
      },
      (value) => { error = value; },
    );
    return { models, authorization, apiKey, error };
  } finally {
    await fake.close();
  }
}

test("模型发现通过 HTTP 规范化 data 响应并只发送 OpenAI Bearer", async () => {
  const result = await discoverFromHttp("openai-responses", {
    data: [{ id: "gpt-test", name: "GPT Test", context_window: 128000 }],
  });

  assert.deepEqual(result.models, [{
    id: "gpt-test",
    name: "GPT Test",
    contextWindow: 128000,
    description: undefined,
    effortLevels: undefined,
    effortSchemaPath: undefined,
    defaultEffortLevel: undefined,
    reasoningModes: undefined,
    defaultReasoningMode: undefined,
    maxOutputTokens: undefined,
  }]);
  assert.equal(result.authorization, "Bearer test-key");
  assert.equal(result.apiKey, "");
});

test("模型发现通过 HTTP 规范化 models 响应", async () => {
  const result = await discoverFromHttp("anthropic", {
    models: [{ modelId: "claude-test", display_name: "Claude Test" }],
  });

  assert.deepEqual(result.models.map((model) => model.id), ["claude-test"]);
  assert.equal(result.authorization, "Bearer test-key");
  assert.equal(result.apiKey, "test-key");
});

test("模型发现通过 HTTP 规范化原始数组响应", async () => {
  const result = await discoverFromHttp("kiro", [
    { id: "kiro-test", name: "Kiro Test" },
  ]);

  assert.deepEqual(result.models.map((model) => model.id), ["kiro-test"]);
});

test("模型发现 HTTP 500 只返回当前 Profile 默认模型", async () => {
  const fallback = [{ id: "current-default", name: "current-default" }];
  const result = await discoverFromHttp(
    "openai-responses",
    { error: "failure" },
    500,
    fallback,
  );

  assert.deepEqual(result.models, fallback);
  assert.match(result.error?.message ?? "", /HTTP 500/);
});
