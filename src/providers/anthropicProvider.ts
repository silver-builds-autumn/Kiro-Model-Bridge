import { AnthropicStreamConverter } from "../anthropicStream";
import { resolveProviderApiUrl } from "../providerProfile";
import {
  applyEffort,
  buildAnthropicRequest,
  setThinkingBudget,
  type AnthropicRequest,
} from "../translate";
import type { EffortMode } from "../effort";
import type { ThinkingConfig } from "../config";
import type {
  PreparedProviderRequest,
  ProviderAdapter,
  ProviderDeps,
  ProviderEffort,
} from "./types";

function applyNativeClaudeEffort(
  body: AnthropicRequest,
  effort: ProviderEffort | undefined,
  mode: EffortMode,
  thinking: ThinkingConfig | undefined,
  getEffortBudget: (effort: ProviderEffort) => number,
): void {
  delete body.output_config;
  if (mode === "off" || thinking?.type === "disabled") {
    delete body.thinking;
    return;
  }
  if (effort) {
    setThinkingBudget(body, getEffortBudget(effort));
  }
}

export function createAnthropicProvider(
  id: "kiro" | "anthropic",
  deps: ProviderDeps,
): ProviderAdapter {
  return {
    id,
    async prepare(request) {
      const thinking = deps.getThinkingConfig?.();
      const body = buildAnthropicRequest(request, {
        model: deps.resolveModel(request, id),
        maxTokens: deps.getMaxTokens(),
        thinking,
        thinkingBudget: deps.getThinkingBudget?.(),
      });
      if (id === "anthropic") {
        applyNativeClaudeEffort(
          body,
          await deps.getEffort(request),
          deps.getEffortMode?.() ?? "auto",
          thinking,
          deps.getEffortBudget,
        );
      } else {
        applyEffort(
          body,
          await deps.getEffort(request),
          deps.getReasoningMode(request),
          deps.getEffortMode?.() ?? "auto",
        );
      }
      return prepareAnthropicRequest(id, body, deps);
    },
  };
}

function prepareAnthropicRequest(
  id: "kiro" | "anthropic",
  body: AnthropicRequest,
  deps: ProviderDeps,
): PreparedProviderRequest {
  const apiKey = deps.getApiKey(id);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "X-Client": `api2kiro/${deps.version}`,
  };
  if (id === "anthropic") {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return {
    url: resolveProviderApiUrl(deps.getBaseUrl(id), "/messages"),
    headers,
    body: JSON.stringify(body),
    modelId: body.model,
    createConverter: (conversationId) =>
      new AnthropicStreamConverter(conversationId, body.model),
  };
}
