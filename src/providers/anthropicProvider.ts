import { AnthropicStreamConverter } from "../anthropicStream";
import { resolveProviderApiUrl } from "../providerProfile";
import {
  applyEffort,
  buildAnthropicRequest,
  type AnthropicRequest,
} from "../translate";
import type {
  PreparedProviderRequest,
  ProviderAdapter,
  ProviderDeps,
} from "./types";

export function createAnthropicProvider(
  id: "kiro" | "anthropic",
  deps: ProviderDeps,
): ProviderAdapter {
  return {
    id,
    async prepare(request) {
      const body = buildAnthropicRequest(request, {
        model: deps.resolveModel(request, id),
        maxTokens: deps.getMaxTokens(),
        thinking: deps.getThinkingConfig?.(),
        thinkingBudget: deps.getThinkingBudget?.(),
      });
      if (id === "anthropic") {
        delete body.thinking;
        delete body.output_config;
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
