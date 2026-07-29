import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("扩展身份和版本用于本地原位升级", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    publisher: string;
    name: string;
    version: string;
    contributes: {
      configuration: {
        properties: Record<string, { enum?: string[] }>;
      };
    };
  };
  assert.equal(pkg.publisher, "api2kiro");
  assert.equal(pkg.name, "api2kiro");
  assert.equal(pkg.version, "1.8.0");
  assert.deepEqual(
    pkg.contributes.configuration.properties["api2kiro.mode"].enum,
    ["kiro", "anthropic", "openai-responses"],
  );
});

test("VSIX 发布规则排除本地密钥和构建期文件", () => {
  const vscodeIgnore = readFileSync(".vscodeignore", "utf8");
  const rules = new Set(vscodeIgnore.split(/\r?\n/).filter(Boolean));
  for (const rule of [".data/**", "config.json", "docs/**", "scripts/**"]) {
    assert.equal(rules.has(rule), true, rule);
  }
});

test("已生成 VSIX 不包含本地密钥和构建期文件", {
  skip: !existsSync("api2kiro-1.8.0.vsix"),
}, () => {
  const archive = readFileSync("api2kiro-1.8.0.vsix");
  for (const entryPrefix of [
    "extension/.data/",
    "extension/config.json",
    "extension/docs/",
    "extension/scripts/",
  ]) {
    assert.equal(archive.includes(Buffer.from(entryPrefix)), false, entryPrefix);
  }
});
