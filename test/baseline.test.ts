const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const test = require("node:test");

test("目标仓库采用 API2Kiro 1.8.0 扩展基线", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

  assert.equal(pkg.name, "api2kiro");
  assert.equal(pkg.version, "1.8.0");
  assert.equal(pkg.publisher, "api2kiro");
  assert.equal(lock.version, "1.8.0");
  assert.equal(lock.packages?.[""]?.version, "1.8.0");
  assert.equal(
    pkg.repository?.url,
    "https://github.com/silver-builds-autumn/Kiro-Model-Bridge.git",
  );
  assert.equal(existsSync("src/extension.ts"), true);
  assert.equal(existsSync("NOTICE"), true);
});
