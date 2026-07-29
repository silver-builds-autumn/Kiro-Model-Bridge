import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "api2kiro-secret-scan-"));
  mkdirSync(join(directory, "scripts"));
  copyFileSync("scripts/scan-secrets.ps1", join(directory, "scripts", "scan-secrets.ps1"));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "api2kiro", version: "1.8.0" }),
  );
  return directory;
}

function runScan(directory: string) {
  return spawnSync(
    "pwsh",
    ["-NoProfile", "-File", join(directory, "scripts", "scan-secrets.ps1")],
    { cwd: directory, encoding: "utf8" },
  );
}

function createSafeVsix(directory: string): void {
  writeFileSync(join(directory, "safe.txt"), "safe release fixture\n");
  const compressed = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      "Compress-Archive -LiteralPath 'safe.txt' -DestinationPath 'api2kiro-1.8.0.zip'",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(compressed.status, 0, compressed.stderr);
  renameSync(
    join(directory, "api2kiro-1.8.0.zip"),
    join(directory, "api2kiro-1.8.0.vsix"),
  );
}

test("密钥扫描器在预期 VSIX 缺失时失败", () => {
  const directory = createFixture();
  try {
    const result = runScan(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /expected VSIX not found/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("密钥扫描器识别跟踪文件中的 PEM 私钥", () => {
  const directory = createFixture();
  try {
    createSafeVsix(directory);
    const privateKeyHeader = "-----BEGIN " + "PRIVATE KEY-----";
    writeFileSync(join(directory, "leak.txt"), `${privateKeyHeader}\nfixture\n`);
    assert.equal(spawnSync("git", ["init"], { cwd: directory }).status, 0);
    assert.equal(
      spawnSync("git", ["add", "package.json", "leak.txt"], { cwd: directory }).status,
      0,
    );

    const result = runScan(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /leak\.txt:1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
