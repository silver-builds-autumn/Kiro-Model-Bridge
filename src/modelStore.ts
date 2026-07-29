import { resolveProviderApiUrl } from "./providerProfile";
import type { ProviderId } from "./providers/types";

export interface RelayModel {
  id: string;
  name: string;
  contextWindow?: number;
  description?: string;
  /** 该模型支持的 effort 档位（中转站从 Kiro ListAvailableModels 透出，各模型不一致）。 */
  effortLevels?: string[];
  /** effort schema 路径：output_config 或 reasoning。 */
  effortSchemaPath?: string;
  /** 默认 effort 档位。 */
  defaultEffortLevel?: string;
  /** 该模型支持的 reasoning.mode 档位（GPT 5.6：[standard, pro]）。仅 reasoning schema 模型有。 */
  reasoningModes?: string[];
  /** 默认 reasoning.mode（如 standard）。 */
  defaultReasoningMode?: string;
  /** 最大输出 token（中转站透出，用于 CPS 模型列表 tokenLimits）。 */
  maxOutputTokens?: number;
}

export interface ModelDiscoveryProfile {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  fallbackModels: RelayModel[];
}

export type GetJson = (
  url: string,
  headers: Record<string, string>,
) => Promise<unknown>;

export interface EffortGroup {
  baseId: string;
  name: string;
  efforts: Set<string>;
  maxInputTokens?: number;
  description?: string;
  /** 中转站透出的官方 effort 档位（优先于 -variant 后缀推断）。 */
  nativeEffortLevels?: string[];
  /** 官方 effort schema 路径：output_config 或 reasoning。 */
  effortSchemaPath?: string;
  /** 官方默认 effort 档位。 */
  defaultEffortLevel?: string;
  /** 官方 reasoning.mode 档位（GPT 5.6：[standard, pro]）。 */
  reasoningModes?: string[];
  /** 官方默认 reasoning.mode。 */
  defaultReasoningMode?: string;
  /** 最大输出 token（中转站透出）。 */
  maxOutputTokens?: number;
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT_LEVEL: EffortLevel = "high";
export const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;

const MODEL_TTL_MS = 60000;

export class ModelCache {
  private readonly entries = new Map<string, { models: RelayModel[]; savedAt: number }>();

  constructor(private readonly ttlMs = MODEL_TTL_MS) {}

  set(key: string, models: RelayModel[]): void {
    this.entries.set(key, { models, savedAt: Date.now() });
  }

  get(key: string): RelayModel[] | undefined {
    const entry = this.entries.get(key);
    if (!entry || Date.now() - entry.savedAt >= this.ttlMs) {
      return undefined;
    }
    return entry.models;
  }
}

const modelCache = new ModelCache();
const modelErrors = new Map<ProviderId, string>();
let activeModels: RelayModel[] = [];

export function modelHeaders(provider: ProviderId, apiKey: string): Record<string, string> {
  if (provider === "openai-responses") {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
  };
}

export function modelCacheKey(provider: ProviderId, baseUrl: string): string {
  return `${provider}|${baseUrl.trim().replace(/\/+$/, "")}`;
}

function parseContextWindow(m: Record<string, unknown>): number {
  const raw =
    (m.context_window as number) ??
    (m.context_length as number) ??
    (m.max_input_tokens as number) ??
    (m.max_context_tokens as number) ??
    (m.maxInputTokens as number) ??
    (m.contextWindow as number);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeRelayModels(raw: unknown): RelayModel[] {
  const record = raw && typeof raw === "object" ? raw as { data?: unknown[]; models?: unknown[] } : {};
  const arr: unknown[] = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : Array.isArray(raw)
        ? raw
        : [];

  return arr
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => x.id || x.modelId)
    .map((x) => {
      const id = String(x.id || x.modelId);
      const effortLevels = Array.isArray(x.effort_levels)
        ? x.effort_levels.filter((e): e is string => typeof e === "string")
        : Array.isArray(x.effortLevels)
          ? x.effortLevels.filter((e): e is string => typeof e === "string")
          : undefined;
      const reasoningModes = Array.isArray(x.reasoning_modes)
        ? x.reasoning_modes.filter((e): e is string => typeof e === "string")
        : Array.isArray(x.reasoningModes)
          ? x.reasoningModes.filter((e): e is string => typeof e === "string")
          : undefined;
      const maxOutRaw = x.max_tokens ?? x.max_output_tokens ?? x.maxOutputTokens;
      const maxOutputTokens = Number.isFinite(Number(maxOutRaw)) && Number(maxOutRaw) > 0
        ? Number(maxOutRaw)
        : undefined;
      return {
        id,
        name: String(x.display_name || x.name || x.modelName || id),
        contextWindow: parseContextWindow(x),
        description: typeof x.description === "string" ? x.description : undefined,
        effortLevels: effortLevels && effortLevels.length > 0 ? effortLevels : undefined,
        effortSchemaPath: typeof x.effort_schema_path === "string"
          ? x.effort_schema_path
          : typeof x.effortSchemaPath === "string" ? x.effortSchemaPath : undefined,
        defaultEffortLevel: typeof x.default_effort_level === "string"
          ? x.default_effort_level
          : typeof x.defaultEffortLevel === "string" ? x.defaultEffortLevel : undefined,
        reasoningModes: reasoningModes && reasoningModes.length > 0 ? reasoningModes : undefined,
        defaultReasoningMode: typeof x.default_reasoning_mode === "string"
          ? x.default_reasoning_mode
          : typeof x.defaultReasoningMode === "string" ? x.defaultReasoningMode : undefined,
        maxOutputTokens,
      };
    });
}

export async function fetchModelsForProfile(
  profile: ModelDiscoveryProfile,
  getJson: GetJson,
  onError?: (error: Error) => void,
): Promise<RelayModel[]> {
  const url = resolveProviderApiUrl(profile.baseUrl, "/models");
  if (!url || !profile.apiKey) {
    return profile.fallbackModels;
  }
  try {
    const raw = await getJson(url, modelHeaders(profile.provider, profile.apiKey));
    const models = normalizeRelayModels(raw);
    return models.length > 0 ? models : profile.fallbackModels;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    onError?.(error);
    return profile.fallbackModels;
  }
}

function fallbackModels(defaultModel: string, mapping: Record<string, string>): RelayModel[] {
  const ids = [...Object.values(mapping), defaultModel]
    .map((id) => String(id || "").trim())
    .filter((id, index, all) => !!id && all.indexOf(id) === index);
  return ids.map((id) => ({ id, name: id, contextWindow: 0 }));
}

/** Fetch and normalize the relay's model list (cached for 60s). */
export async function fetchRelayModels(force = false): Promise<RelayModel[]> {
  const config = require("./config") as typeof import("./config");
  const provider = config.getRelayMode();
  const baseUrl = config.getBaseUrl(provider);
  const key = modelCacheKey(provider, baseUrl);
  const cached = !force ? modelCache.get(key) : undefined;
  if (cached) {
    activeModels = cached;
    return cached;
  }
  const fallback = fallbackModels(
    config.getDefaultModel(provider),
    config.getModelMapping(provider),
  );
  const apiKey = config.getApiKey(provider);
  if (!apiKey || !baseUrl) {
    activeModels = fallback;
    return fallback;
  }
  try {
    const upstream = require("./upstream") as typeof import("./upstream");
    let discoveryError: Error | undefined;
    const models = await fetchModelsForProfile(
      { provider, baseUrl, apiKey, fallbackModels: fallback },
      async (url, headers) => {
        const res = await upstream.requestUpstream(
          "GET",
          url,
          { ...headers, Accept: "application/json" },
          undefined,
          15000,
        );
        const text = await upstream.readBody(res.body);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
        }
        return JSON.parse(text) as unknown;
      },
      (error) => { discoveryError = error; },
    );
    if (discoveryError) {
      const message = discoveryError.message;
      modelErrors.set(provider, message);
      activeModels = fallback;
      const log = require("./log") as typeof import("./log");
      log.error("/models fetch failed:", message);
      return fallback;
    }
    if (models.length > 0) {
      modelCache.set(key, models);
    }
    activeModels = models;
    modelErrors.delete(provider);
    const log = require("./log") as typeof import("./log");
    log.debug("relay models fetched", { count: models.length, provider });
    return models;
  } catch (e) {
    const message = (e as Error).message || String(e);
    modelErrors.set(provider, message);
    activeModels = fallback;
    const log = require("./log") as typeof import("./log");
    log.error("/models fetch failed:", message);
    return fallback;
  }
}

export function getCachedModels(): RelayModel[] {
  return activeModels;
}

export function getLastModelError(provider: ProviderId): string | undefined {
  return modelErrors.get(provider);
}

/** True if the relay exposes an effort-suffixed variant of `base` (e.g. base-high). */
export function hasEffortVariant(base: string, effort: string): boolean {
  const b = String(base || "");
  const e = String(effort || "").toLowerCase();
  if (!b || !e) {
    return false;
  }
  const target = (b + "-" + e).toLowerCase();
  return activeModels.some((m) => m.id.toLowerCase() === target);
}

export function contextWindowForModel(id: string): number | undefined {
  return activeModels.find((m) => m.id === id)?.contextWindow;
}

/**
 * If the relay exposes a dedicated "thinking" variant of `base` (e.g.
 * `claude-opus-4-8-thinking`), return its id; otherwise undefined. Several
 * Kiro-style relays gate extended reasoning behind such a variant rather than
 * honoring a thinking budget on the base model.
 */
export function thinkingVariantOf(base: string): string | undefined {
  const b = String(base || "").toLowerCase();
  if (!b || b.endsWith("-thinking")) {
    return undefined;
  }
  const target = b + "-thinking";
  const hit = activeModels.find((m) => m.id.toLowerCase() === target);
  return hit?.id;
}

/** Group flat relay models into base models with their available effort suffixes. */
export function groupModelsByEffort(models: RelayModel[]): EffortGroup[] {
  const map = new Map<string, EffortGroup>();
  const order: string[] = [];

  const ensure = (baseId: string, src: RelayModel): EffortGroup => {
    let g = map.get(baseId);
    if (!g) {
      g = { baseId, name: baseId, efforts: new Set<string>() };
      map.set(baseId, g);
      order.push(baseId);
    }
    if (src.contextWindow && !g.maxInputTokens) {
      g.maxInputTokens = src.contextWindow;
    }
    return g;
  };

  for (const m of models) {
    if (!m || !m.id) {
      continue;
    }
    const match = m.id.match(EFFORT_SUFFIX_RE);
    if (match) {
      const baseId = m.id.slice(0, m.id.length - match[0].length);
      const effort = match[1].toLowerCase();
      ensure(baseId, m).efforts.add(effort);
    } else {
      const g = ensure(m.id, m);
      if (m.name) {
        g.name = m.name;
      }
      if (m.description) {
        g.description = m.description;
      }
      // 官方 effort 信息（来自中转站 /v1/models，透传自 Kiro ListAvailableModels）
      if (m.effortLevels && m.effortLevels.length > 0) {
        g.nativeEffortLevels = m.effortLevels;
      }
      if (m.effortSchemaPath) {
        g.effortSchemaPath = m.effortSchemaPath;
      }
      if (m.defaultEffortLevel) {
        g.defaultEffortLevel = m.defaultEffortLevel;
      }
      // 官方 reasoning.mode 信息（GPT 5.6：standard/pro），供 CPS 广播 schema + effort.ts 校验
      if (m.reasoningModes && m.reasoningModes.length > 0) {
        g.reasoningModes = m.reasoningModes;
      }
      if (m.defaultReasoningMode) {
        g.defaultReasoningMode = m.defaultReasoningMode;
      }
      if (m.maxOutputTokens && !g.maxOutputTokens) {
        g.maxOutputTokens = m.maxOutputTokens;
      }
    }
  }

  return order.map((id) => map.get(id)!);
}
