# API2Kiro Responses Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `silver-builds-autumn/Kiro-Model-Bridge` 中交付可本地原位升级的 `api2kiro-1.8.0.vsix`，支持 Kiro 深度兼容、Anthropic Messages 和 OpenAI Responses 三种单站点模式。

**Architecture:** 以只读的 API2Kiro `d9faffc` 源码为扩展基线，保留 KRS/CPS、Anthropic 转换、事件编码和安全重试。在 KRS 上游边界增加 Provider 接口，OpenAI Responses 使用独立请求构造器、reasoning 信封和 SSE 转换器；Key 统一迁移到 VS Code SecretStorage。

**Tech Stack:** TypeScript 5.5、VS Code Extension API、Node.js 18+、esbuild、Node test runner、tsx、AWS event-stream、Anthropic Messages SSE、OpenAI Responses SSE。

---

## 文件结构

实施完成后的主要文件职责如下：

- `src/providers/types.ts`：Provider ID、准备后的请求和流转换器契约。
- `src/providers/registry.ts`：按当前模式选择 Provider。
- `src/providers/anthropicProvider.ts`：包装现有 Kiro/Anthropic 两条成熟链路。
- `src/providers/openaiResponsesRequest.ts`：CodeWhisperer 历史到 Responses input 的纯转换。
- `src/providers/openaiResponsesStream.ts`：Responses SSE 到 `CwEvent` 的状态机。
- `src/providers/reasoningEnvelope.ts`：GPT encrypted reasoning 的版本化签名封装。
- `src/sseParser.ts`：支持任意分块和显式 flush 的通用 SSE 解析器。
- `src/credentialStore.ts`：SecretStorage 缓存、写入、清除和旧明文迁移。
- `src/config.ts`：三模式非敏感配置与当前 Profile 解析。
- `src/modelStore.ts`：按 Provider/Base URL 隔离的模型发现和缓存。
- `src/krsServer.ts`：调用当前 Provider，并保持未提交前重试边界。
- `src/sidebar.ts`：三模式选择、独立 Profile 保存和 Key 状态操作。
- `test/helpers/`：Fake SecretStorage、Fake 上游和 CodeWhisperer 固定请求。
- `test/*.test.ts`：转换、流、凭据、模型和端到端回归。
- `scripts/scan-secrets.ps1`：只报告文件与行号的高熵 Key 扫描。
- `NOTICE`：API2Kiro 上游归属与本仓库衍生说明。

## Task 1: 将目标仓库切换为 API2Kiro 扩展基线

**Files:**
- Replace: `package.json`, `package-lock.json`, `tsconfig.json`, `esbuild.js`, `README.md`
- Create: `README.zh-CN.md`, `LICENSE`, `NOTICE`, `assets/panel.png`, `src/*.ts`
- Modify: `.gitignore`
- Delete: `src/cert.mjs`, `src/config.mjs`, `src/eventstream.mjs`, `src/index.mjs`, `src/kiro.mjs`, `src/logger.mjs`, `src/providers.mjs`, `src/proxy.mjs`, `src/relay.mjs`, `test/e2e.mjs`, `test/proxy-e2e.mjs`, `config.example.json`
- Preserve ignored: `config.json`, `.data/`, `node_modules/`

- [ ] **Step 1: 核验仓库边界和未提交状态**

Run:

```powershell
git remote -v
git log -1 --oneline
git status --short
git -C ..\api2kiro-source log -1 --oneline
git -C ..\api2kiro-source status --short
```

Expected: 目标 `origin` 为 `silver-builds-autumn/Kiro-Model-Bridge.git`；目标 HEAD 至少包含 `ccd6ad3`；只读参考 HEAD 为 `d9faffc` 且状态为空。目标中既有 `README.md` 本地改动允许被已批准的扩展 README 替换，不得把 `config.json` 加入 Git。

- [ ] **Step 2: 从只读参考仓库复制已跟踪文件**

Run:

```powershell
$sourceRepo = (Resolve-Path '..\api2kiro-source').Path
$targetRepo = (Resolve-Path '.').Path
$trackedFiles = git -C $sourceRepo ls-files
foreach ($relativePath in $trackedFiles) {
  if ($relativePath -eq '.gitignore') { continue }
  $sourcePath = Join-Path $sourceRepo $relativePath
  $targetPath = Join-Path $targetRepo $relativePath
  New-Item -ItemType Directory -Path (Split-Path $targetPath) -Force | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
}
```

Expected: 参考仓库无写入；目标出现 API2Kiro TypeScript 源码，现有 `docs/` 保留。

- [ ] **Step 3: 删除已批准替换的旧 CLI 跟踪文件**

Run:

```powershell
$obsoleteFiles = @(
  'src/cert.mjs', 'src/config.mjs', 'src/eventstream.mjs', 'src/index.mjs',
  'src/kiro.mjs', 'src/logger.mjs', 'src/providers.mjs', 'src/proxy.mjs',
  'src/relay.mjs', 'test/e2e.mjs', 'test/proxy-e2e.mjs', 'config.example.json'
)
foreach ($relativePath in $obsoleteFiles) {
  if (Test-Path -LiteralPath $relativePath) { Remove-Item -LiteralPath $relativePath -Force }
}
```

Expected: 仅清除列表中的旧 CLI 跟踪文件；`config.json`、`.data/` 和 `docs/` 仍存在。

- [ ] **Step 4: 更新清单、忽略规则和归属说明**

Apply these exact metadata values in `package.json`:

```json
{
  "name": "api2kiro",
  "version": "1.8.0",
  "publisher": "api2kiro",
  "repository": {
    "type": "git",
    "url": "https://github.com/silver-builds-autumn/Kiro-Model-Bridge.git"
  }
}
```

Append to `.gitignore` without removing existing secret rules:

```gitignore
dist/
*.vsix
config.json
.data/
node_modules/
```

Create `NOTICE`:

```text
This repository contains a derivative build of API2Kiro.
Upstream: https://github.com/SunNorthGod/API2Kiro
Upstream license: MIT
Derivative maintenance: https://github.com/silver-builds-autumn/Kiro-Model-Bridge
The api2kiro publisher/name values are retained only for local VSIX upgrade compatibility.
This derivative is not an upstream Marketplace release.
```

- [ ] **Step 5: 安装依赖并验证未改功能可构建**

Run:

```powershell
npm ci
npm run compile
npm run bundle
```

Expected: `npm run compile` 退出码 0 且无 TypeScript diagnostics；bundle 输出 `[esbuild] build complete`。

- [ ] **Step 6: 提交基线导入**

Run:

```powershell
git add -A -- .gitignore LICENSE NOTICE README.md README.zh-CN.md assets esbuild.js package.json package-lock.json src tsconfig.json test config.example.json
git diff --cached --check
git commit -m "chore: adopt API2Kiro extension baseline"
git log -1 --oneline
```

Expected: 提交成功；`git status --short` 不显示 `config.json`、`.data/` 或 `node_modules/`。

## Task 2: 建立 TypeScript 测试框架和 Provider 契约

**Files:**
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`
- Create: `src/providers/types.ts`
- Create: `test/providerTypes.test.ts`

- [ ] **Step 1: 安装测试运行器并添加脚本**

Run:

```powershell
npm install --save-dev tsx
```

Add scripts:

```json
{
  "test": "tsx --test \"test/**/*.test.ts\"",
  "test:unit": "tsx --test \"test/*.test.ts\""
}
```

- [ ] **Step 2: 写 Provider 契约的失败测试**

Create `test/providerTypes.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isProviderId } from "../src/providers/types";

test("只接受三种 Provider ID", () => {
  assert.equal(isProviderId("kiro"), true);
  assert.equal(isProviderId("anthropic"), true);
  assert.equal(isProviderId("openai-responses"), true);
  assert.equal(isProviderId("openai-chat"), false);
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npx tsx --test --test-name-pattern 'Provider ID' test/providerTypes.test.ts`

Expected: FAIL，错误包含 `Cannot find module '../src/providers/types'`。

- [ ] **Step 4: 实现最小 Provider 契约**

Create `src/providers/types.ts`:

```ts
import type { CwEvent, CwRequest } from "../cwTypes";

export type ProviderId = "kiro" | "anthropic" | "openai-responses";
export type ProviderEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function isProviderId(value: unknown): value is ProviderId {
  return value === "kiro" || value === "anthropic" || value === "openai-responses";
}

export interface PreparedProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  modelId: string;
  createConverter(conversationId: string): ProviderStreamConverter;
}

export interface ProviderStreamConverter {
  processLine(line: string): CwEvent[];
  flush(): CwEvent[];
  readonly committed: boolean;
  readonly terminalError?: string;
}

export interface ProviderDeps {
  readonly version: string;
  getApiKey(provider: ProviderId): string;
  getBaseUrl(provider: ProviderId): string;
  resolveModel(request: CwRequest, provider: ProviderId): string;
  getMaxTokens(): number;
  getEffort(request: CwRequest): Promise<ProviderEffort | undefined>;
  getReasoningMode(request: CwRequest): string | undefined;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  prepare(request: CwRequest): Promise<PreparedProviderRequest>;
}
```

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern 'Provider ID' test/providerTypes.test.ts
npm run compile
git add package.json package-lock.json tsconfig.json src/providers/types.ts test/providerTypes.test.ts
git commit -m "test: add provider contract harness"
git log -1 --oneline
```

Expected: TAP 输出包含 `# fail 0`；类型检查退出码 0。

## Task 3: 将 API Key 迁移到 SecretStorage

**Files:**
- Create: `src/credentialStore.ts`
- Modify: `src/config.ts`, `src/extension.ts`, `src/sidebar.ts`
- Create: `test/credentialStore.test.ts`

- [ ] **Step 1: 写迁移成功与失败的测试**

The test must cover these concrete cases:

```ts
class FakeSecretStorage {
  private readonly values = new Map<string, string>();
  constructor(private readonly options: { dropWrites?: boolean } = {}) {}
  async get(key: string) { return this.values.get(key); }
  async store(key: string, value: string) {
    if (!this.options.dropWrites) this.values.set(key, value);
  }
  async delete(key: string) { this.values.delete(key); }
}

class FakeLegacyStore {
  private readonly values = new Map<string, string>(Object.entries(this.initial));
  constructor(private readonly initial: Record<string, string>) {}
  get(key: string) { return this.values.get(key); }
  async clear(key: string) { this.values.delete(key); }
}

test("写入并回读成功后清除旧明文", async () => {
  const legacy = new FakeLegacyStore({ apiKey: "legacy-secret" });
  const secrets = new FakeSecretStorage();
  const store = new CredentialStore(secrets, legacy);
  const report = await store.initialize();
  assert.equal(store.get("kiro"), "legacy-secret");
  assert.deepEqual(report.migrated, ["kiro"]);
  assert.equal(legacy.get("apiKey"), undefined);
});

test("SecretStorage 回读失败时保留旧明文", async () => {
  const legacy = new FakeLegacyStore({ officialApiKey: "legacy-secret" });
  const secrets = new FakeSecretStorage({ dropWrites: true });
  const store = new CredentialStore(secrets, legacy);
  const report = await store.initialize();
  assert.deepEqual(report.failed, ["anthropic"]);
  assert.equal(legacy.get("officialApiKey"), "legacy-secret");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test --test-name-pattern '旧明文|回读失败' test/credentialStore.test.ts`

Expected: FAIL，错误包含 `CredentialStore is not defined`。

- [ ] **Step 3: 实现凭据仓库**

Implement this public surface in `src/credentialStore.ts`:

```ts
export const SECRET_IDS = {
  kiro: "api2kiro.secret.kiro",
  anthropic: "api2kiro.secret.anthropic",
  "openai-responses": "api2kiro.secret.openai-responses",
} as const;

export interface LegacyCredentialStore {
  get(key: "apiKey" | "officialApiKey"): string | undefined;
  clear(key: "apiKey" | "officialApiKey"): Promise<void>;
}

export class CredentialStore {
  async initialize(): Promise<{ migrated: ProviderId[]; failed: ProviderId[] }>;
  get(provider: ProviderId): string;
  async set(provider: ProviderId, value: string): Promise<void>;
  async clear(provider: ProviderId): Promise<void>;
}
```

Use a memory cache only after verified `secrets.get(id)` results. Map legacy `apiKey` to `kiro` and `officialApiKey` to `anthropic`. Clear the legacy setting and `fallback.<key>` only after exact readback equality.

- [ ] **Step 4: 接入激活和面板**

Change activation order to:

```ts
initLog();
await initConfig(context);
info("activating, version", context.extension.packageJSON.version);
```

Replace all Key writes with `setApiKey(getRelayMode(), value)` and clear operations with `clearApiKey(getRelayMode())`. `postState()` sends only:

```ts
{
  type: "state",
  hasKey: !!getApiKey(),
  baseUrl: getBaseUrl()
}
```

Remove `maskedKey` from the Webview message contract.

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern '旧明文|回读失败' test/credentialStore.test.ts
npm run compile
git add src/credentialStore.ts src/config.ts src/extension.ts src/sidebar.ts test/credentialStore.test.ts
git commit -m "feat: store provider keys in SecretStorage"
git log -1 --oneline
```

Expected: TAP `# fail 0`；编译无 diagnostics。

## Task 4: 增加三模式 Profile 与面板切换

**Files:**
- Create: `src/providerProfile.ts`
- Modify: `src/config.ts`, `src/sidebar.ts`, `src/extension.ts`, `package.json`
- Create: `test/providerProfile.test.ts`

- [ ] **Step 1: 写 Profile 映射失败测试**

```ts
test("每种 Provider 使用独立配置键", () => {
  assert.deepEqual(profileKeys("kiro"), {
    baseUrl: "baseUrl", defaultModel: "defaultModel", modelMapping: "modelMapping"
  });
  assert.deepEqual(profileKeys("anthropic"), {
    baseUrl: "officialBaseUrl", defaultModel: "officialDefaultModel", modelMapping: "officialModelMapping"
  });
  assert.deepEqual(profileKeys("openai-responses"), {
    baseUrl: "openaiBaseUrl", defaultModel: "openaiDefaultModel", modelMapping: "openaiModelMapping"
  });
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npx tsx --test --test-name-pattern '独立配置键' test/providerProfile.test.ts`

Expected: FAIL，错误包含 `profileKeys is not a function`。

- [ ] **Step 3: 实现 Profile 键和模式规范化**

```ts
export function normalizeProviderId(value: unknown): ProviderId {
  return isProviderId(value) ? value : "kiro";
}

export function profileKeys(provider: ProviderId) {
  if (provider === "anthropic") {
    return { baseUrl: "officialBaseUrl", defaultModel: "officialDefaultModel", modelMapping: "officialModelMapping" } as const;
  }
  if (provider === "openai-responses") {
    return { baseUrl: "openaiBaseUrl", defaultModel: "openaiDefaultModel", modelMapping: "openaiModelMapping" } as const;
  }
  return { baseUrl: "baseUrl", defaultModel: "defaultModel", modelMapping: "modelMapping" } as const;
}

export function resolveProviderApiUrl(baseUrl: string, apiPath: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return "";
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return /\/v\d+$/i.test(normalized) ? normalized + path : normalized + "/v1" + path;
}
```

- [ ] **Step 4: 更新扩展配置和面板**

Set `api2kiro.mode.enum` to:

```json
["kiro", "anthropic", "openai-responses"]
```

Add `openaiBaseUrl`, `openaiDefaultModel`, and `openaiModelMapping`. Do not add an `openaiApiKey` setting. Add a three-way segmented control in `sidebar.ts`; mode messages must pass through `normalizeProviderId(msg.mode)`.

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern '独立配置键' test/providerProfile.test.ts
npm run compile
git add package.json src/providerProfile.ts src/config.ts src/sidebar.ts src/extension.ts test/providerProfile.test.ts
git commit -m "feat: add isolated provider profiles"
git log -1 --oneline
```

Expected: TAP `# fail 0`；模式配置包含三项。

## Task 5: 按 Provider 隔离模型发现

**Files:**
- Modify: `src/modelStore.ts`, `src/config.ts`, `src/sidebar.ts`
- Create: `test/modelStore.test.ts`

- [ ] **Step 1: 写认证、缓存和兜底测试**

```ts
test("Responses 模型请求只发送 Bearer 认证", async () => {
  const calls: unknown[] = [];
  const models = await fetchModelsForProfile(openaiProfile, fakeGetJson(calls));
  assert.equal(models[0].id, "gpt-test");
  assert.deepEqual(calls[0], {
    url: "https://relay.example/v1/models",
    headers: { Authorization: "Bearer secret" }
  });
});

test("不同 Provider 不共享模型缓存", async () => {
  const cache = new ModelCache();
  cache.set("openai-responses|https://relay.example", [{ id: "gpt-test", name: "gpt-test", contextWindow: 0 }]);
  assert.equal(cache.get("anthropic|https://relay.example"), undefined);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npx tsx --test --test-name-pattern '模型请求|模型缓存' test/modelStore.test.ts`

Expected: FAIL，缺少 `fetchModelsForProfile` 或 `ModelCache`。

- [ ] **Step 3: 实现 Profile 模型请求**

Use these exact auth rules:

```ts
export function modelHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === "openai-responses") return { Authorization: `Bearer ${apiKey}` };
  return {
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
  };
}
```

Cache key is `${provider}|${normalizedBaseUrl}`. Normalize `{data}`, `{models}`, and raw arrays. On error, return current profile mappings/default model and expose the real error to the sidebar.

- [ ] **Step 4: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern '模型请求|模型缓存' test/modelStore.test.ts
npm run compile
git add src/modelStore.ts src/config.ts src/sidebar.ts test/modelStore.test.ts
git commit -m "feat: isolate model discovery by provider"
git log -1 --oneline
```

Expected: TAP `# fail 0`；编译退出码 0。

## Task 6: 包装现有 Kiro 与 Anthropic Provider

**Files:**
- Create: `src/providers/anthropicProvider.ts`, `src/providers/registry.ts`
- Modify: `src/anthropicStream.ts`, `src/translate.ts`
- Create: `test/anthropicProvider.test.ts`

- [ ] **Step 1: 写两个成熟模式的请求测试**

```ts
function cwRequest(): CwRequest {
  return {
    conversationState: {
      currentMessage: {
        userInputMessage: { content: "hello", modelId: "MODEL" }
      }
    }
  };
}

function fakeProviderDeps(effort?: ProviderEffort): ProviderDeps {
  return {
    version: "1.8.0",
    getApiKey: () => "secret",
    getBaseUrl: () => "https://relay.example",
    resolveModel: () => "claude-test",
    getMaxTokens: () => 32000,
    getEffort: async () => effort,
    getReasoningMode: () => undefined,
  };
}

test("Anthropic 模式剥离 Kiro 私有字段并发送双认证", async () => {
  const prepared = await createAnthropicProvider("anthropic", fakeProviderDeps()).prepare(cwRequest());
  const body = JSON.parse(prepared.body);
  assert.equal(prepared.url, "https://relay.example/v1/messages");
  assert.equal(body.output_config, undefined);
  assert.equal(prepared.headers.Authorization, "Bearer secret");
  assert.equal(prepared.headers["x-api-key"], "secret");
});

test("Kiro 模式保留 output_config effort", async () => {
  const prepared = await createAnthropicProvider("kiro", fakeProviderDeps("high")).prepare(cwRequest());
  assert.deepEqual(JSON.parse(prepared.body).output_config, { effort: "high" });
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npx tsx --test --test-name-pattern 'Anthropic 模式|Kiro 模式' test/anthropicProvider.test.ts`

Expected: FAIL，缺少 `createAnthropicProvider`。

- [ ] **Step 3: 实现包装器而不重写转换器**

```ts
export function createAnthropicProvider(id: "kiro" | "anthropic", deps: ProviderDeps): ProviderAdapter {
  return {
    id,
    async prepare(request) {
      const body = buildAnthropicRequest(request);
      if (id === "anthropic") {
        delete body.thinking;
        delete body.output_config;
      } else {
        applyEffort(body, await deps.getEffort(request), deps.getReasoningMode(request));
      }
      return prepareAnthropicRequest(id, body, deps);
    },
  };
}

function prepareAnthropicRequest(
  id: "kiro" | "anthropic",
  body: AnthropicRequest,
  deps: ProviderDeps
): PreparedProviderRequest {
  const apiKey = deps.getApiKey(id);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "X-Client": `api2kiro/${deps.version}`,
  };
  if (id === "anthropic") headers.Authorization = `Bearer ${apiKey}`;
  return {
    url: resolveProviderApiUrl(deps.getBaseUrl(id), "/messages"),
    headers,
    body: JSON.stringify(body),
    modelId: body.model,
    createConverter: (conversationId) => new AnthropicStreamConverter(conversationId, body.model),
  };
}
```

Add read-only `committed` and `terminalError` fields to `AnthropicStreamConverter`; set `committed` after producing text, reasoning, or tool events. Do not change signed-thinking extraction.

- [ ] **Step 4: 建立 Provider registry**

```ts
export function providerFor(id: ProviderId, deps: ProviderDeps): ProviderAdapter {
  if (id === "openai-responses") {
    throw new Error("OpenAI Responses provider is not registered yet");
  }
  return createAnthropicProvider(id, deps);
}
```

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern 'Anthropic 模式|Kiro 模式' test/anthropicProvider.test.ts
npm run compile
git add src/providers src/anthropicStream.ts src/translate.ts test/anthropicProvider.test.ts
git commit -m "refactor: wrap existing anthropic providers"
git log -1 --oneline
```

Expected: 两个回归测试通过；原 Anthropic 请求快照不变。

## Task 7: 实现 OpenAI Responses 请求转换

**Files:**
- Create: `src/providers/openaiResponsesRequest.ts`
- Create: `test/openaiResponsesRequest.test.ts`

- [ ] **Step 1: 重启 Codex 后核对官方协议**

Use the installed `openaiDeveloperDocs` MCP to fetch the current `/v1/responses` request schema and streaming event reference. Confirm these contract points before editing: function tools are top-level tool objects; tool calls use `call_id`; tool outputs use `function_call_output`; reasoning uses `reasoning.effort`; stateless encrypted reasoning is requested through the documented include field. If the official schema differs, update the design document first and obtain approval before implementation.

- [ ] **Step 2: 写完整请求映射失败测试**

The fixture must contain user text, assistant text, one image, one function call, one function result, and a current user message. Assert this shape:

```ts
const request: CwRequest = {
  conversationState: {
    history: [
      { userInputMessage: { content: "inspect", modelId: "MODEL", images: [
        { format: "png", source: { bytes: "aW1hZ2U=" } }
      ] } },
      { assistantResponseMessage: { content: "calling tool", toolUses: [
        { toolUseId: "call-1", name: "read_file", input: { path: "a.ts" } }
      ] } },
      { userInputMessage: { content: "tool result", modelId: "MODEL", userInputMessageContext: {
        toolResults: [{ toolUseId: "call-1", content: [{ text: "file body" }] }]
      } } }
    ],
    currentMessage: { userInputMessage: { content: "continue", modelId: "MODEL", userInputMessageContext: {
      tools: [{ toolSpecification: {
        name: "read_file",
        description: "Read one file",
        inputSchema: { json: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
      } }]
    } } }
  }
};
const body = buildOpenAIResponsesRequest(request, {
  model: "gpt-test", maxOutputTokens: 32000, effort: "high"
});
assert.equal(body.model, "gpt-test");
assert.equal(body.stream, true);
assert.equal(body.store, false);
assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
assert.equal(body.tools[0].type, "function");
assert.equal(body.tools[0].name, "read_file");
assert.equal(body.input.find((item: any) => item.type === "function_call").call_id, "call-1");
assert.equal(body.input.find((item: any) => item.type === "function_call_output").call_id, "call-1");
assert.match(JSON.stringify(body.input), /data:image\/png;base64,/);
```

- [ ] **Step 3: 运行失败测试**

Run: `npx tsx --test --test-name-pattern '完整 Responses 请求' test/openaiResponsesRequest.test.ts`

Expected: FAIL，缺少 `buildOpenAIResponsesRequest`。

- [ ] **Step 4: 实现纯请求构造器**

Expose this signature:

```ts
export interface OpenAIResponsesBuildOptions {
  model: string;
  maxOutputTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh";
}

export interface OpenAIResponsesRequest {
  model: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  stream: true;
  store: false;
  max_output_tokens: number;
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh"; summary: "auto" };
  include?: string[];
}

export function normalizeOpenAIEffort(
  effort: ProviderEffort | undefined
): "low" | "medium" | "high" | "xhigh" | undefined {
  if (effort === "max") return "xhigh";
  return effort;
}

export function buildOpenAIResponsesRequest(
  request: CwRequest,
  options: OpenAIResponsesBuildOptions
): OpenAIResponsesRequest;
```

Map `max` to `xhigh`; preserve supported `low/medium/high/xhigh`. Set `include` to the official encrypted-reasoning include value verified in Step 1. Use Responses-native tool objects, not Chat Completions `{type,function:{...}}` wrappers.

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern '完整 Responses 请求' test/openaiResponsesRequest.test.ts
npm run compile
git add src/providers/openaiResponsesRequest.ts test/openaiResponsesRequest.test.ts
git commit -m "feat: build OpenAI Responses requests"
git log -1 --oneline
```

Expected: 请求映射测试通过；不存在 `/v1/chat/completions` 字符串。

## Task 8: 实现 encrypted reasoning 信封

**Files:**
- Create: `src/providers/reasoningEnvelope.ts`
- Modify: `src/providers/openaiResponsesRequest.ts`
- Create: `test/reasoningEnvelope.test.ts`

- [ ] **Step 1: 写往返、篡改和跨 Provider 测试**

```ts
test("GPT reasoning 信封可往返且拒绝错误前缀", () => {
  const item = { type: "reasoning", id: "rs_1", encrypted_content: "cipher", summary: [] } as const;
  const signature = encodeReasoningEnvelope(item);
  assert.match(signature, /^api2kiro:oai-reasoning:v1:/);
  assert.deepEqual(decodeReasoningEnvelope(signature), item);
  assert.equal(decodeReasoningEnvelope("anthropic:signature"), undefined);
  assert.equal(decodeReasoningEnvelope(signature + "broken"), undefined);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npx tsx --test --test-name-pattern 'reasoning 信封' test/reasoningEnvelope.test.ts`

Expected: FAIL，缺少 `encodeReasoningEnvelope`。

- [ ] **Step 3: 实现版本化信封**

```ts
const PREFIX = "api2kiro:oai-reasoning:v1:";

export interface OpenAIReasoningItem {
  type: "reasoning";
  id: string;
  encrypted_content: string;
  summary: Array<Record<string, unknown>>;
}

export function encodeReasoningEnvelope(item: OpenAIReasoningItem): string {
  const json = JSON.stringify({
    type: "reasoning",
    id: item.id,
    encrypted_content: item.encrypted_content,
    summary: item.summary ?? [],
  });
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}
```

`decodeReasoningEnvelope` must catch parse errors, require exact `type`, non-empty `id` and `encrypted_content`, and return `undefined` for all foreign prefixes. Never log the envelope body.

- [ ] **Step 4: 在请求历史中回放信封**

When an assistant history item has a matching Kiro reasoning signature, insert the decoded reasoning item immediately before its function-call items. Do not replay Claude signatures or unsigned reasoning text.

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern 'reasoning 信封' test/reasoningEnvelope.test.ts
npx tsx --test --test-name-pattern '完整 Responses 请求' test/openaiResponsesRequest.test.ts
npm run compile
git add src/providers/reasoningEnvelope.ts src/providers/openaiResponsesRequest.ts test/reasoningEnvelope.test.ts test/openaiResponsesRequest.test.ts
git commit -m "feat: preserve encrypted reasoning across tool turns"
git log -1 --oneline
```

Expected: 往返、拒绝和历史回放测试全部通过。

## Task 9: 实现可靠 SSE 与 Responses 流状态机

**Files:**
- Create: `src/sseParser.ts`, `src/providers/openaiResponsesStream.ts`, `src/providers/openaiResponsesProvider.ts`
- Modify: `src/providers/registry.ts`
- Create: `test/sseParser.test.ts`, `test/openaiResponsesStream.test.ts`

- [ ] **Step 1: 写任意分块和无尾换行测试**

```ts
test("SSE 支持 CRLF、跨 chunk 和无尾换行 flush", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: response.output_text.delta\r\nda"), []);
  const events = parser.push("ta: {\"delta\":\"你\"}\r\n\r\n");
  assert.equal(events[0].event, "response.output_text.delta");
  parser.push("data: {\"type\":\"response.completed\"}");
  assert.equal(parser.flush()[0].data, "{\"type\":\"response.completed\"}");
});
```

- [ ] **Step 2: 写 Responses 事件映射失败测试**

Feed these events in separate chunks and assert `CwEvent` output:

```ts
const events = [
  { type: "response.output_text.delta", delta: "你好" },
  { type: "response.reasoning_summary_text.delta", delta: "检查文件" },
  { type: "response.output_item.added", item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "{\"path\":" },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: "{\"path\":\"a.ts\"}" },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] } }
];
```

Expected assertions: text event contains `你好`; reasoning event contains `检查文件`; tool event has `call-1/read_file`; metadata is `10/5`; converter `committed === true`.

- [ ] **Step 3: 运行失败测试**

Run: `npx tsx --test --test-name-pattern 'SSE 支持|Responses 事件' test/sseParser.test.ts test/openaiResponsesStream.test.ts`

Expected: FAIL，缺少 `SseParser` 和 `OpenAIResponsesStreamConverter`。

- [ ] **Step 4: 实现解析器和状态机**

`SseParser.push()` returns only complete SSE records; `flush()` emits a final buffered record. `OpenAIResponsesStreamConverter` must:

```ts
class OpenAIResponsesStreamConverter implements ProviderStreamConverter {
  readonly usage = { inputTokens: 0, outputTokens: 0 };
  committed = false;
  terminalError?: string;
  processLine(line: string): CwEvent[];
  flush(): CwEvent[];
}
```

On completed output, encode the validated reasoning item into a signature event. On `response.failed`, `response.incomplete`, or `error`, set `terminalError` to a sanitized message. Never expose encrypted content in error text.

- [ ] **Step 5: 实现 Responses Provider 并注册**

```ts
export function createOpenAIResponsesProvider(deps: ProviderDeps): ProviderAdapter {
  return {
    id: "openai-responses",
    async prepare(request) {
      const apiKey = deps.getApiKey("openai-responses");
      const effort = await deps.getEffort(request);
      const body = buildOpenAIResponsesRequest(request, {
        model: deps.resolveModel(request, "openai-responses"),
        maxOutputTokens: deps.getMaxTokens(),
        effort: normalizeOpenAIEffort(effort),
      });
      return {
        url: resolveProviderApiUrl(deps.getBaseUrl("openai-responses"), "/responses"),
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
          "X-Client": `api2kiro/${deps.version}`,
        },
        body: JSON.stringify(body),
        modelId: body.model,
        createConverter: (conversationId) =>
          new OpenAIResponsesStreamConverter(conversationId, body.model),
      };
    },
  };
}
```

Replace the temporary registry error with `return createOpenAIResponsesProvider(deps)`.

- [ ] **Step 6: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern 'SSE 支持|Responses 事件' test/sseParser.test.ts test/openaiResponsesStream.test.ts
npm run compile
git add src/sseParser.ts src/providers/openaiResponsesStream.ts src/providers/openaiResponsesProvider.ts src/providers/registry.ts test/sseParser.test.ts test/openaiResponsesStream.test.ts
git commit -m "feat: convert OpenAI Responses streams"
git log -1 --oneline
```

Expected: 分块、工具、reasoning、usage 和错误测试通过。

## Task 10: 将 Provider 接入 KRS 并保持安全重试边界

**Files:**
- Create: `src/providerRunner.ts`
- Modify: `src/krsServer.ts`, `src/providers/registry.ts`, `src/cwEvents.ts`
- Create: `test/krsRetry.test.ts`

- [ ] **Step 1: 写提交前后重试测试**

```ts
test("未输出事件时 429 可重试", async () => {
  const upstream = sequenceTransport([httpError(429), responsesText("ok")]);
  const sink = recordingSink();
  await runPreparedWithRetry(fakePreparedRequest(), upstream, sink, { maxRetries: 1 });
  assert.equal(upstream.calls, 2);
  assert.match(sink.text(), /ok/);
});

test("输出工具事件后流失败不重试", async () => {
  const upstream = sequenceTransport([responsesToolThenError(), responsesText("duplicate")]);
  const sink = recordingSink();
  await runPreparedWithRetry(fakePreparedRequest(), upstream, sink, { maxRetries: 1 });
  assert.equal(upstream.calls, 1);
  assert.doesNotMatch(sink.text(), /duplicate/);
});
```

The same test file defines `sequenceTransport`, `recordingSink`, and `fakePreparedRequest` against these production interfaces:

```ts
export interface ProviderTransport {
  request(prepared: PreparedProviderRequest): Promise<UpstreamResponse>;
}

export interface ProviderSink {
  begin(): void;
  write(event: CwEvent): void;
  fail(message: string): void;
  end(): void;
}

export async function runPreparedWithRetry(
  prepared: PreparedProviderRequest,
  transport: ProviderTransport,
  sink: ProviderSink,
  options: { maxRetries: number }
): Promise<void>;
```

- [ ] **Step 2: 运行失败测试**

Run: `npx tsx --test --test-name-pattern '429 可重试|流失败不重试' test/krsRetry.test.ts`

Expected: FAIL，当前 KRS 只能构造 Anthropic 请求。

- [ ] **Step 3: 用 PreparedProviderRequest 替换硬编码 Anthropic 参数**

In request handling:

```ts
const provider = providerFor(getRelayMode(), providerDeps(this.context));
const prepared = await provider.prepare(parsed);
await this.streamWithRetry(res, prepared, convId);
```

Change retry signature to:

```ts
private async streamWithRetry(
  res: http.ServerResponse,
  prepared: PreparedProviderRequest,
  convId: string
): Promise<void> {
  const transport: ProviderTransport = {
    request: (item) => requestUpstream("POST", item.url, item.headers, item.body),
  };
  const sink: ProviderSink = {
    begin: () => this.beginEventStream(res),
    write: (event) => writeEvent(res, event),
    fail: (message) => writeEvent(res, {
      assistantResponseEvent: { content: `上游错误：${message}`, modelId: prepared.modelId }
    }),
    end: () => { if (!res.writableEnded) res.end(); },
  };
  return runPreparedWithRetry(prepared, transport, sink, {
    maxRetries: getAutoRetry() ? getMaxRetries() : 0,
  });
}
```

Create a fresh converter for every retry attempt. A terminal stream error is retryable only when `converter.committed === false`; once committed, write one sanitized terminal error and end without another upstream call.

- [ ] **Step 4: 保留 Kiro 事件语义**

`writeEvent()` continues to emit message metadata, assistant text, reasoning, tool, usage and context events. Tool calls must emit exactly one final `toolUseEvent` with accumulated JSON arguments. Do not change the existing AWS event-stream wire encoder.

- [ ] **Step 5: 验证并提交**

Run:

```powershell
npx tsx --test --test-name-pattern '429 可重试|流失败不重试' test/krsRetry.test.ts
npm test
npm run compile
git add src/providerRunner.ts src/krsServer.ts src/providers/registry.ts src/cwEvents.ts test/krsRetry.test.ts
git commit -m "feat: route KRS through provider adapters"
git log -1 --oneline
```

Expected: 全部测试 `# fail 0`；输出后重试次数为 1。

## Task 11: 增加三模式本地端到端回归

**Files:**
- Create: `test/helpers/fakeServers.ts`, `test/helpers/cwFixtures.ts`
- Create: `test/openaiResponses.e2e.test.ts`, `test/anthropicRegression.test.ts`, `test/modelDiscovery.e2e.test.ts`

- [ ] **Step 1: 建立只监听 127.0.0.1 的假上游**

```ts
type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
type RouteMap = Record<string, RouteHandler>;

async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse, routes: RouteMap) {
  const handler = routes[`${req.method} ${req.url}`];
  if (!handler) {
    res.writeHead(404).end();
    return;
  }
  await handler(req, res);
}

export async function startFakeProvider(routes: RouteMap) {
  const server = http.createServer((req, res) => routeRequest(req, res, routes));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
```

- [ ] **Step 2: 写 Responses 两轮工具测试**

Use this first response sequence and assert the second request:

```ts
const firstResponseEvents = [
  { type: "response.reasoning_summary_text.delta", delta: "读取文件" },
  { type: "response.output_item.added", output_index: 0, item: {
    id: "rs_1", type: "reasoning", encrypted_content: "cipher", summary: []
  } },
  { type: "response.output_item.added", output_index: 1, item: {
    id: "fc_1", type: "function_call", call_id: "call-1", name: "read_file", arguments: ""
  } },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1,
    arguments: "{\"path\":\"a.ts\"}" },
  { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 }, output: [] } }
];

const first = await executeProviderTurn(firstResponseEvents, initialCwRequest());
const second = await executeProviderTurn(
  [{ type: "response.completed", response: { usage: { input_tokens: 15, output_tokens: 2 }, output: [] } }],
  cwToolResultRequest("call-1", "file body", first.reasoningSignature)
);
const secondBody = JSON.parse(second.receivedBody);
assert.equal(secondBody.input.find((x: any) => x.type === "function_call_output").call_id, "call-1");
assert.equal(secondBody.input.find((x: any) => x.type === "reasoning").encrypted_content, "cipher");
```

`executeProviderTurn` starts `startFakeProvider`, prepares the Responses Provider, executes `runPreparedWithRetry`, captures `CwEvent` output and closes the server in `finally`. `cwToolResultRequest` builds a CodeWhisperer history item with matching `toolUseId` and nested `reasoningContent.reasoningText.signature`.

- [ ] **Step 3: 写 Anthropic 回归和模型发现测试**

Use this Anthropic stream fixture:

```ts
const anthropicEvents = [
  { type: "message_start", message: { usage: { input_tokens: 8 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "分析" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-thinking" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "read_file" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a.ts\"}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", usage: { output_tokens: 4 } },
  { type: "message_stop" }
];
```

Assert the Kiro reasoning signature equals `signed-thinking` and the next Anthropic request contains it unchanged. Model fixtures return `{data:[...]}`, `{models:[...]}`, and raw arrays in separate subtests; a fourth subtest returns HTTP 500 and asserts only the current Profile default model is returned.

- [ ] **Step 4: 运行端到端测试**

Run:

```powershell
npx tsx --test --test-name-pattern '两轮工具|Anthropic 回归|模型发现' test/openaiResponses.e2e.test.ts test/anthropicRegression.test.ts test/modelDiscovery.e2e.test.ts
```

Expected: TAP `# fail 0`；所有 fake server 在 `finally` 中关闭，无遗留监听端口。

- [ ] **Step 5: 提交端到端覆盖**

Run:

```powershell
git add test/helpers test/openaiResponses.e2e.test.ts test/anthropicRegression.test.ts test/modelDiscovery.e2e.test.ts
git commit -m "test: cover provider workflows end to end"
git log -1 --oneline
```

Expected: 提交仅包含测试与 helper。

## Task 12: 文档、安全扫描和 VSIX 交付验证

**Files:**
- Modify: `README.md`, `README.zh-CN.md`, `package.json`, `package-lock.json`
- Create: `scripts/scan-secrets.ps1`, `test/packageMetadata.test.ts`
- Generate ignored: `dist/extension.js`, `api2kiro-1.8.0.vsix`

- [ ] **Step 1: 写包元数据失败测试**

```ts
test("扩展身份和版本用于本地原位升级", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.publisher, "api2kiro");
  assert.equal(pkg.name, "api2kiro");
  assert.equal(pkg.version, "1.8.0");
  assert.deepEqual(pkg.contributes.configuration.properties["api2kiro.mode"].enum,
    ["kiro", "anthropic", "openai-responses"]);
});
```

- [ ] **Step 2: 实现只报告位置的敏感信息扫描**

Create `scripts/scan-secrets.ps1`:

```powershell
$secretPattern = [regex]'\bsk-[A-Za-z0-9_-]{32,}\b'
$findings = @()

$trackedFiles = git ls-files
foreach ($relativePath in $trackedFiles) {
  if (-not (Test-Path -LiteralPath $relativePath -PathType Leaf)) { continue }
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $relativePath -ErrorAction SilentlyContinue) {
    $lineNumber++
    if ($secretPattern.IsMatch($line)) { $findings += "${relativePath}:${lineNumber}" }
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$vsixFiles = Get-ChildItem -LiteralPath . -Filter 'api2kiro-1.8.0.vsix' -File
foreach ($vsixFile in $vsixFiles) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($vsixFile.FullName)
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -notmatch '\.(js|json|md|txt|xml|ts)$') { continue }
      $reader = [System.IO.StreamReader]::new($entry.Open())
      try {
        $lineNumber = 0
        while (($line = $reader.ReadLine()) -ne $null) {
          $lineNumber++
          if ($secretPattern.IsMatch($line)) { $findings += "$($entry.FullName):${lineNumber}" }
        }
      } finally { $reader.Dispose() }
    }
  } finally { $archive.Dispose() }
}

if ($findings.Count -gt 0) {
  $findings | ForEach-Object { Write-Error "potential API key at $_" }
  exit 1
}
Write-Output 'secret scan: 0 high-entropy API keys found'
```

Add script:

```json
"scan:secrets": "pwsh -NoProfile -File scripts/scan-secrets.ps1"
```

- [ ] **Step 3: 更新中英文 README**

Document exactly: three modes; `/v1/messages` and `/v1/responses`; separate profiles; `/v1/models` discovery and manual fallback; SecretStorage migration; encrypted reasoning downgrade; build/install/rollback; upstream API2Kiro attribution; Kiro-Model-Bridge derivative status; the warning that published chat Key values must be revoked.

- [ ] **Step 4: 运行完整验证**

Run:

```powershell
npm test
npm run compile
npm run bundle
npm run package
npm run scan:secrets
```

Expected real lines:

```text
# fail 0
[esbuild] build complete
secret scan: 0 high-entropy API keys found
DONE  Packaged: ...\api2kiro-1.8.0.vsix
```

- [ ] **Step 5: 核验 VSIX 包内身份和原文件不变**

Run:

```powershell
$newVsix = Resolve-Path '.\api2kiro-1.8.0.vsix'
$oldVsix = Resolve-Path '..\api2kiro-source\api2kiro-1.7.14.vsix'
Get-FileHash -Algorithm SHA256 -LiteralPath $oldVsix
Get-Item -LiteralPath $newVsix | Select-Object FullName, Length
npx tsx --test --test-name-pattern '扩展身份和版本' test/packageMetadata.test.ts
```

Expected: 新 VSIX 存在且非空；元数据测试通过；旧 VSIX 只读取哈希，未修改。

- [ ] **Step 6: 提交文档和交付脚本**

Run:

```powershell
git add README.md README.zh-CN.md package.json package-lock.json scripts/scan-secrets.ps1 test/packageMetadata.test.ts NOTICE LICENSE
git diff --cached --check
git commit -m "docs: document multi-provider VSIX release"
git log -1 --oneline
git status --short
```

Expected: 提交成功；工作区无跟踪文件改动；VSIX 与 `dist/` 保持 ignored。

- [ ] **Step 7: 停在安装和真实联调确认点**

Do not install the VSIX and do not use any API Key from chat. Report the artifact path, SHA256, exact test pass line, exact package line, and exact `git log -1 --oneline`. Ask for separate approval before installing into Kiro. After installation, the user must enter newly rotated keys only through the local sidebar before live testing.

## 最终验收清单

- [ ] `api2kiro-source` 状态为空，且其 HEAD 仍为 `d9faffc`。
- [ ] 所有源码和提交只存在于 `silver-builds-autumn/Kiro-Model-Bridge`。
- [ ] 三种模式分别保存配置，Key 仅在 SecretStorage。
- [ ] `/v1/models` 自动发现失败时使用当前模式兜底，不串缓存。
- [ ] Responses 文本、图片、工具两轮、reasoning summary 和 encrypted reasoning 均有测试。
- [ ] Anthropic thinking 签名和 Kiro 深度兼容模式通过回归。
- [ ] 未输出前可重试，输出后不重试。
- [ ] `npm test`、`npm run compile`、`npm run bundle`、`npm run scan:secrets`、`npm run package` 均有真实成功输出。
- [ ] 产物为 `api2kiro-1.8.0.vsix`，原 `1.7.14` 未修改。
- [ ] 安装、真实 Key 配置和推送远程均未在未授权情况下执行。
