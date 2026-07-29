# Claude Thinking Effort Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Kiro's five thinking-effort choices for Claude Messages mode and translate the chosen tier into native Anthropic extended-thinking budgets.

**Architecture:** CPS will expose an `output_config.effort` schema for Claude only when the existing effort mode permits it. The Claude provider will consume that local Kiro field, map it through the existing budget table, and send only standard Anthropic `thinking` to `/v1/messages`; GPT and Kiro-compatible provider behavior stays unchanged.

**Tech Stack:** TypeScript, VS Code extension APIs, Node test runner via `tsx`, Anthropic Messages SSE, VSIX via `@vscode/vsce`.

---

## File Structure

- Create: `src/cpsModelSchema.ts` - own the pure CPS model-schema builder without importing the VS Code runtime.
- Modify: `src/cpsServer.ts` - delegate CPS schema construction to the pure builder.
- Modify: `src/providers/anthropicProvider.ts` - consume selected Claude effort and create native `thinking.budget_tokens` without leaking `output_config` upstream.
- Modify: `test/anthropicProvider.test.ts` - test every selected Claude tier, disabled thinking, and existing Kiro behavior.
- Create: `test/cpsModelSchema.test.ts` - test CPS schema visibility for Claude `auto`, `thinkingBudget`, `modelVariant`, and `off` modes.
- Modify: `README.md`, `README.zh-CN.md`, `package.json` - document the visible Claude selector, the native mapping, and safe fallback for relays without extended thinking.

### Task 1: Make Claude CPS Schema Testable

**Files:**
- Create: `src/cpsModelSchema.ts`
- Modify: `src/cpsServer.ts:1-154`
- Create: `test/cpsModelSchema.test.ts`

- [ ] **Step 1: Write failing CPS schema tests**

Create `test/cpsModelSchema.test.ts` using a minimal `EffortGroup` without native effort metadata. Assert that the exported helper gives an Anthropic model the full Kiro selector only for `auto` and `thinkingBudget`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildCpsModels } from "../src/cpsModelSchema";
import type { EffortGroup } from "../src/modelStore";

const group: EffortGroup = {
  baseId: "claude-opus-5",
  name: "Claude Opus 5",
  efforts: new Set(),
};

function outputEfforts(model: ReturnType<typeof buildCpsModels>[number]): unknown {
  const schema = model.additionalModelRequestFieldsSchema as {
    properties?: { output_config?: { properties?: { effort?: unknown } } };
  };
  return schema.properties?.output_config?.properties?.effort;
}

test("Claude auto 模式公开五档思考选择器", () => {
  const [model] = buildCpsModels([group], "anthropic", "auto");
  assert.deepEqual(outputEfforts(model), {
    type: "string",
    enum: ["low", "medium", "high", "xhigh", "max"],
  });
  assert.equal(model.defaultEffortLevel, "high");
});

test("Claude off 模式不公开思考选择器", () => {
  const [model] = buildCpsModels([group], "anthropic", "off");
  assert.equal(model.additionalModelRequestFieldsSchema, undefined);
});

test("Claude thinkingBudget 模式公开五档思考选择器", () => {
  const [model] = buildCpsModels([group], "anthropic", "thinkingBudget");
  assert.deepEqual(outputEfforts(model), {
    type: "string",
    enum: ["low", "medium", "high", "xhigh", "max"],
  });
});

test("Claude modelVariant 模式只公开实际发现的变体", () => {
  const [model] = buildCpsModels([{ ...group, efforts: new Set(["low", "high"]) }], "anthropic", "modelVariant");
  assert.deepEqual(outputEfforts(model), {
    type: "string",
    enum: ["low", "high"],
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
npx tsx --test test/cpsModelSchema.test.ts
```

Expected: FAIL because `buildCpsModels` is not exported yet.

- [ ] **Step 3: Create the pure CPS model builder and delegate from CPS**

Create `src/cpsModelSchema.ts` and move the body of `groups.map(...)` from `buildModelList` into:

```ts
export function buildCpsModels(
  groups: EffortGroup[],
  relayMode: ProviderId,
  mode: EffortMode,
): CpsModel[] {
  return groups.map((g) => {
    // Preserve existing model metadata and schema construction.
    let efforts: string[] = [];
    let schemaPath = "output_config";
    if (relayMode === "anthropic") {
      if (mode === "modelVariant") {
        efforts = EFFORT_LEVELS.filter((effort) => g.efforts.has(effort));
      } else if (mode === "auto" || mode === "thinkingBudget") {
        efforts = [...EFFORT_LEVELS];
      }
    } else if (g.nativeEffortLevels?.length) {
      efforts = g.nativeEffortLevels;
      schemaPath = g.effortSchemaPath || schemaPath;
    } else if (mode === "modelVariant") {
      efforts = EFFORT_LEVELS.filter((effort) => g.efforts.has(effort));
    } else if (mode === "auto" || mode === "thinkingBudget") {
      efforts = [...EFFORT_LEVELS];
    }
    // Keep the existing output_config/reasoning schema creation and defaults.
  });
}
```

Import `EffortGroup` and `EffortMode` as types in the new module. In `src/cpsServer.ts`, import `buildCpsModels` and replace the old inline `groups.map(...)` call with:

```ts
const models = buildCpsModels(groups, getRelayMode(), getEffortMode());
```

Do not change the `reasoning` schema used by GPT Responses models.

- [ ] **Step 4: Run CPS tests and full type check**

Run:

```powershell
npx tsx --test test/cpsModelSchema.test.ts
npm run compile
```

Expected: CPS tests report `pass 4 / fail 0`; TypeScript exits `0`.

- [ ] **Step 5: Commit the CPS schema work**

```powershell
git add src/cpsModelSchema.ts src/cpsServer.ts test/cpsModelSchema.test.ts docs/superpowers/plans/2026-07-29-claude-thinking-effort.md
git commit -m "feat: expose Claude thinking effort schema"
```

### Task 2: Translate Claude Tiers to Native Thinking

**Files:**
- Modify: `src/providers/anthropicProvider.ts:1-38`
- Modify: `test/anthropicProvider.test.ts:14-62`

- [ ] **Step 1: Extend test dependencies and write failing native-thinking tests**

Extend `fakeProviderDeps` to accept an effort mode and optional thinking configuration. Add the following test table:

```ts
test("Claude 档位映射为原生 thinking 预算且不泄漏 output_config", async () => {
  for (const [effort, budget] of [
    ["low", 2048], ["medium", 4096], ["high", 8192],
    ["xhigh", 16384], ["max", 24576],
  ] as const) {
    const prepared = await createAnthropicProvider(
      "anthropic",
      fakeProviderDeps(effort, "auto"),
    ).prepare(cwRequest());
    const body = JSON.parse(prepared.body);
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: budget });
    assert.equal(body.output_config, undefined);
  }
});

test("Claude 禁用思考时不发送 thinking", async () => {
  const prepared = await createAnthropicProvider(
    "anthropic",
    fakeProviderDeps("high", "auto", { type: "disabled" }),
  ).prepare(cwRequest());
  const body = JSON.parse(prepared.body);
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
});
```

Retain the Kiro provider test asserting `output_config: { effort: "high" }` and retain the dual Anthropic authentication assertion.

- [ ] **Step 2: Run the focused Provider test and verify RED**

Run:

```powershell
npx tsx --test test/anthropicProvider.test.ts
```

Expected: the new Claude tests fail because the provider currently deletes `thinking` for `id === "anthropic"`.

- [ ] **Step 3: Implement the native Claude mapper**

In `src/providers/anthropicProvider.ts`, import `budgetForEffort` and `EffortMode` from `../effort`, plus `setThinkingBudget` and `ThinkingConfig` types as required. Add a focused helper:

```ts
function applyNativeClaudeEffort(
  body: AnthropicRequest,
  effort: ProviderEffort | undefined,
  mode: EffortMode,
  thinking: ThinkingConfig | undefined,
): void {
  delete body.output_config;
  if (mode === "off" || thinking?.type === "disabled") {
    delete body.thinking;
    return;
  }
  if (effort) {
    setThinkingBudget(body, budgetForEffort(effort));
  }
}
```

In the `id === "anthropic"` branch, resolve the selected effort once with `await deps.getEffort(request)`, call this helper, and never call `applyEffort`. Preserve `body.thinking` created by explicit `api2kiro.thinking=enabled` only when no selected effort replaces it. Keep the Kiro branch unchanged.

- [ ] **Step 4: Run focused regressions and compile**

Run:

```powershell
npx tsx --test test/anthropicProvider.test.ts test/openaiResponses.e2e.test.ts
npm run compile
```

Expected: all selected tests pass; GPT Responses still includes `reasoning.effort` and TypeScript exits `0`.

- [ ] **Step 5: Commit native Claude mapping**

```powershell
git add src/providers/anthropicProvider.ts test/anthropicProvider.test.ts
git commit -m "feat: map Claude effort to native thinking"
```

### Task 3: Document the Selector and Deliver a VSIX

**Files:**
- Modify: `package.json:118-148`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Write failing configuration documentation tests**

Extend `test/providerProfile.test.ts` to assert `api2kiro.effortMode` still permits `auto`, `thinkingBudget`, and `off`, and that `api2kiro.effortBudgets` remains an object. This protects the documented configuration contract:

```ts
assert.deepEqual(properties["api2kiro.effortMode"].enum, [
  "auto", "modelVariant", "thinkingBudget", "off",
]);
assert.equal(properties["api2kiro.effortBudgets"].type, "object");
```

- [ ] **Step 2: Run the configuration test and verify its current expectation**

Run:

```powershell
npx tsx --test test/providerProfile.test.ts
```

Expected: PASS before documentation wording changes because the public configuration shape is intentionally preserved.

- [ ] **Step 3: Update public descriptions and both READMEs**

Update the `api2kiro.effortMode` description in `package.json` to state that Claude mode maps Kiro's selected tier to native Anthropic `thinking.budget_tokens`, while `off` hides the selector. In both READMEs add a short Claude section:

```markdown
Claude Messages mode displays Kiro's Low/Medium/High/XHigh/Max selector when
`api2kiro.effortMode` is not `off`. The selected tier is translated to native
Anthropic extended thinking. A relay that rejects extended thinking should use
`api2kiro.effortMode: "off"`; API2Kiro will not silently retry without the
selected tier.
```

Use equivalent Chinese wording in `README.zh-CN.md`. Do not add API keys or relay-specific credentials to documentation.

- [ ] **Step 4: Run complete verification and build the artifact**

Run:

```powershell
npm test
npm run compile
npm run bundle
npm run package
npm run scan:secrets
npx tsx --test test/packageMetadata.test.ts
```

Expected real lines include `pass ... / fail 0`, `[esbuild] build complete`, `DONE  Packaged: ...\api2kiro-1.8.0.vsix`, and both credential-scan zero-hit lines.

- [ ] **Step 5: Commit documentation and delivery tests**

```powershell
git add package.json README.md README.zh-CN.md test/providerProfile.test.ts
git diff --cached --check
git commit -m "docs: explain Claude thinking effort"
git log -1 --oneline
git status --short
```

Expected: the commit succeeds and `git status --short` has no tracked-file output. Do not install the VSIX or push the branch without separate approval.
