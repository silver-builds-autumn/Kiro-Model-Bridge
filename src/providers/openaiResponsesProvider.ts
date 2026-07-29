import { resolveProviderApiUrl } from "../providerProfile";
import {
  buildOpenAIResponsesRequest,
  normalizeOpenAIEffort,
} from "./openaiResponsesRequest";
import { OpenAIResponsesStreamConverter } from "./openaiResponsesStream";
import type { ProviderAdapter, ProviderDeps } from "./types";

export function createOpenAIResponsesProvider(deps: ProviderDeps): ProviderAdapter {
  return {
    id: "openai-responses",
    async prepare(request) {
      const apiKey = deps.getApiKey("openai-responses");
      const effort = await deps.getEffort(request);
      const body = buildOpenAIResponsesRequest(request, {
        model: deps.resolveModel(request, "openai-responses"),
        maxOutputTokens: deps.getMaxTokens(),
        effort: normalizeOpenAIEffort(effort),
      });
      return {
        url: resolveProviderApiUrl(deps.getBaseUrl("openai-responses"), "/responses"),
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
          "X-Client": `api2kiro/${deps.version}`,
        },
        body: JSON.stringify(body),
        modelId: body.model,
        createConverter: (conversationId) =>
          new OpenAIResponsesStreamConverter(conversationId, body.model),
      };
    },
  };
}
