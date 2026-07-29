const PREFIX = "api2kiro:oai-reasoning:v1:";

export interface OpenAIReasoningItem extends Record<string, unknown> {
  type: "reasoning";
  id: string;
  encrypted_content: string;
  summary: Array<Record<string, unknown>>;
}

/** 将 OpenAI 加密 reasoning item 封装进 Kiro 可回传的签名字段。 */
export function encodeReasoningEnvelope(item: OpenAIReasoningItem): string {
  const json = JSON.stringify({
    type: "reasoning",
    id: item.id,
    encrypted_content: item.encrypted_content,
    summary: item.summary ?? [],
  });
  return PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

/** 仅解码本项目生成且字段完整的 v1 reasoning 信封。 */
export function decodeReasoningEnvelope(signature: string): OpenAIReasoningItem | undefined {
  if (!signature.startsWith(PREFIX)) {
    return undefined;
  }

  try {
    const encoded = signature.slice(PREFIX.length);
    if (!encoded) {
      return undefined;
    }
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const item = value as Record<string, unknown>;
    if (
      item.type !== "reasoning"
      || typeof item.id !== "string"
      || item.id.length === 0
      || typeof item.encrypted_content !== "string"
      || item.encrypted_content.length === 0
      || !Array.isArray(item.summary)
    ) {
      return undefined;
    }
    return {
      type: "reasoning",
      id: item.id,
      encrypted_content: item.encrypted_content,
      summary: item.summary as Array<Record<string, unknown>>,
    };
  } catch {
    return undefined;
  }
}
