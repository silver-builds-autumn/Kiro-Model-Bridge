import { createAnthropicProvider } from "./anthropicProvider";
import { createOpenAIResponsesProvider } from "./openaiResponsesProvider";
import type { ProviderAdapter, ProviderDeps, ProviderId } from "./types";

export function providerFor(id: ProviderId, deps: ProviderDeps): ProviderAdapter {
  if (id === "openai-responses") {
    return createOpenAIResponsesProvider(deps);
  }
  return createAnthropicProvider(id, deps);
}
