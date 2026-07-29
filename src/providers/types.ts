import type { CwEvent, CwRequest } from "../cwTypes";

export type ProviderId = "kiro" | "anthropic" | "openai-responses";
export type ProviderEffort = "low" | "medium" | "high" | "xhigh" | "max";

export function isProviderId(value: unknown): value is ProviderId {
  return value === "kiro" || value === "anthropic" || value === "openai-responses";
}

/** Provider 完成配置解析后交给 KRS 执行的稳定请求契约。 */
export interface PreparedProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  modelId: string;
  createConverter(conversationId: string): ProviderStreamConverter;
}

/** 将上游流逐行转换成 Kiro 内部事件，并暴露安全重试所需状态。 */
export interface ProviderStreamConverter {
  processLine(line: string): CwEvent[];
  flush(): CwEvent[];
  readonly committed: boolean;
  readonly terminalError?: string;
}

/** Provider 只通过该接口读取配置，避免直接依赖 VS Code 全局状态。 */
export interface ProviderDeps {
  readonly version: string;
  getApiKey(provider: ProviderId): string;
  getBaseUrl(provider: ProviderId): string;
  resolveModel(request: CwRequest, provider: ProviderId): string;
  getMaxTokens(): number;
  getEffort(request: CwRequest): Promise<ProviderEffort | undefined>;
  getEffortBudget(effort: ProviderEffort): number;
  getReasoningMode(request: CwRequest): string | undefined;
  getThinkingConfig?(): {
    type: "enabled" | "disabled";
    budget_tokens?: number;
  } | undefined;
  getThinkingBudget?(): number;
  getEffortMode?(): "off" | "modelVariant" | "thinkingBudget" | "auto";
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  prepare(request: CwRequest): Promise<PreparedProviderRequest>;
}
