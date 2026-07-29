import type { ProviderId } from "./providers/types";

export const SECRET_IDS = {
  kiro: "api2kiro.secret.kiro",
  anthropic: "api2kiro.secret.anthropic",
  "openai-responses": "api2kiro.secret.openai-responses",
} as const;

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface LegacyCredentialStore {
  get(key: "apiKey" | "officialApiKey"): string | undefined;
  clear(key: "apiKey" | "officialApiKey"): Promise<void>;
}

const LEGACY_IDS: ReadonlyArray<{
  provider: ProviderId;
  key: "apiKey" | "officialApiKey";
}> = [
  { provider: "kiro", key: "apiKey" },
  { provider: "anthropic", key: "officialApiKey" },
];

/** 统一管理三种 Provider 的 SecretStorage 凭据及旧明文迁移。 */
export class CredentialStore {
  private readonly cache = new Map<ProviderId, string>();

  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly legacy: LegacyCredentialStore,
  ) {}

  async initialize(): Promise<{ migrated: ProviderId[]; failed: ProviderId[] }> {
    const migrated: ProviderId[] = [];
    const failed: ProviderId[] = [];

    for (const { provider, key } of LEGACY_IDS) {
      try {
        const stored = await this.secrets.get(SECRET_IDS[provider]);
        if (stored !== undefined) {
          this.cache.set(provider, stored);
          if (stored && stored === this.legacy.get(key)) {
            await this.legacy.clear(key);
            migrated.push(provider);
          }
          continue;
        }

        const legacyValue = this.legacy.get(key);
        if (!legacyValue) {
          continue;
        }

        await this.secrets.store(SECRET_IDS[provider], legacyValue);
        const readback = await this.secrets.get(SECRET_IDS[provider]);
        if (readback !== legacyValue) {
          failed.push(provider);
          continue;
        }

        this.cache.set(provider, readback);
        await this.legacy.clear(key);
        migrated.push(provider);
      } catch {
        failed.push(provider);
      }
    }

    const openAIKey = await this.secrets.get(SECRET_IDS["openai-responses"]);
    if (openAIKey !== undefined) {
      this.cache.set("openai-responses", openAIKey);
    }

    return { migrated, failed };
  }

  get(provider: ProviderId): string {
    return this.cache.get(provider) ?? "";
  }

  async set(provider: ProviderId, value: string): Promise<void> {
    const secretId = SECRET_IDS[provider];
    await this.secrets.store(secretId, value);
    const readback = await this.secrets.get(secretId);
    if (readback !== value) {
      throw new Error("SecretStorage 写入后回读不一致");
    }
    this.cache.set(provider, readback);
  }

  async clear(provider: ProviderId): Promise<void> {
    const secretId = SECRET_IDS[provider];
    await this.secrets.delete(secretId);
    if ((await this.secrets.get(secretId)) !== undefined) {
      throw new Error("SecretStorage 删除后仍可回读凭据");
    }
    this.cache.delete(provider);
  }
}
