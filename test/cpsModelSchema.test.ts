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
  const [model] = buildCpsModels(
    [{ ...group, efforts: new Set(["low", "high"]) }],
    "anthropic",
    "modelVariant",
  );
  assert.deepEqual(outputEfforts(model), {
    type: "string",
    enum: ["low", "high"],
  });
});
