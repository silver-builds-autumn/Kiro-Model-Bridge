import assert from "node:assert/strict";
import test from "node:test";
import { CredentialStore } from "../src/credentialStore";

class FakeSecretStorage {
  private readonly values = new Map<string, string>();

  constructor(private readonly options: { dropWrites?: boolean } = {}) {}

  async get(key: string) {
    return this.values.get(key);
  }

  async store(key: string, value: string) {
    if (!this.options.dropWrites) {
      this.values.set(key, value);
    }
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

class FakeLegacyStore {
  private readonly values: Map<string, string>;

  constructor(initial: Record<string, string>) {
    this.values = new Map(Object.entries(initial));
  }

  get(key: "apiKey" | "officialApiKey") {
    return this.values.get(key);
  }

  async clear(key: "apiKey" | "officialApiKey") {
    this.values.delete(key);
  }
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

test("直接写入只有精确回读后才进入内存缓存", async () => {
  const store = new CredentialStore(
    new FakeSecretStorage({ dropWrites: true }),
    new FakeLegacyStore({}),
  );

  await assert.rejects(store.set("openai-responses", "new-secret"));
  assert.equal(store.get("openai-responses"), "");
});
