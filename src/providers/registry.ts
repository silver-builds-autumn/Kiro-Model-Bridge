import { createAnthropicProvider } from "./anthropicProvider";
import type { ProviderAdapter, ProviderDeps, ProviderId } from "./types";

export function providerFor(id: ProviderId, deps: ProviderDeps): ProviderAdapter {
  if (id === "openai-responses") {
    throw new Error("OpenAI Responses provider is not registered yet");
  }
  return createAnthropicProvider(id, deps);
}
