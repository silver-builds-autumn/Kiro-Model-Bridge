import { isProviderId, type ProviderId } from "./providers/types";

export function normalizeProviderId(value: unknown): ProviderId {
  return isProviderId(value) ? value : "kiro";
}

export function profileKeys(provider: ProviderId) {
  if (provider === "anthropic") {
    return {
      baseUrl: "officialBaseUrl",
      defaultModel: "officialDefaultModel",
      modelMapping: "officialModelMapping",
    } as const;
  }
  if (provider === "openai-responses") {
    return {
      baseUrl: "openaiBaseUrl",
      defaultModel: "openaiDefaultModel",
      modelMapping: "openaiModelMapping",
    } as const;
  }
  return {
    baseUrl: "baseUrl",
    defaultModel: "defaultModel",
    modelMapping: "modelMapping",
  } as const;
}

export function resolveProviderApiUrl(baseUrl: string, apiPath: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  return /\/v\d+$/i.test(normalized)
    ? normalized + path
    : normalized + "/v1" + path;
}
