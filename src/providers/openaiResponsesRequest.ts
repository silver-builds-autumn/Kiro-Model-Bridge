import type {
  AnthropicJsonSchema,
  CwAssistantResponseMessage,
  CwRequest,
  CwToolResult,
  CwToolSpec,
  CwUserInputMessage,
} from "../cwTypes";
import type { ProviderEffort } from "./types";
import { decodeReasoningEnvelope } from "./reasoningEnvelope";

export interface OpenAIResponsesBuildOptions {
  model: string;
  maxOutputTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh";
}

export interface OpenAIResponsesRequest {
  model: string;
  input: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  stream: true;
  store: false;
  max_output_tokens: number;
  reasoning?: {
    effort: "low" | "medium" | "high" | "xhigh";
    summary: "auto";
  };
  include?: string[];
}

export function normalizeOpenAIEffort(
  effort: ProviderEffort | undefined,
): "low" | "medium" | "high" | "xhigh" | undefined {
  return effort === "max" ? "xhigh" : effort;
}

function serializeToolResultContent(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(serializeToolResultContent).join("\n");
  }
  if (typeof content === "object") {
    const value = content as Record<string, unknown>;
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.text === "string") {
      return value.text;
    }
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(value, "json")) {
      return typeof value.json === "string" ? value.json : JSON.stringify(value.json);
    }
    return JSON.stringify(value);
  }
  return String(content);
}

function toolResultItem(result: CwToolResult): Record<string, unknown> {
  return {
    type: "function_call_output",
    call_id: result.toolUseId,
    output: serializeToolResultContent(result.content),
  };
}

function userMessageItems(message: CwUserInputMessage): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const result of message.userInputMessageContext?.toolResults ?? []) {
    items.push(toolResultItem(result));
  }

  const content: Array<Record<string, unknown>> = [];
  if (message.content) {
    content.push({ type: "input_text", text: message.content });
  }
  for (const image of message.images ?? []) {
    content.push({
      type: "input_image",
      image_url: `data:image/${image.format.toLowerCase()};base64,${image.source.bytes}`,
      detail: "auto",
    });
  }
  if (content.length > 0) {
    items.push({ type: "message", role: "user", content });
  }
  return items;
}

function toolParameters(spec: CwToolSpec): AnthropicJsonSchema {
  const tool = spec.toolSpecification ?? spec;
  const inputSchema = tool.inputSchema;
  if (inputSchema && typeof inputSchema === "object") {
    const json = "json" in inputSchema ? inputSchema.json : undefined;
    return json && typeof json === "object"
      ? json as AnthropicJsonSchema
      : inputSchema as AnthropicJsonSchema;
  }
  return { type: "object", properties: {} };
}

function responseTools(specs: CwToolSpec[]): Array<Record<string, unknown>> {
  return specs.flatMap((spec) => {
    const tool = spec.toolSpecification ?? spec;
    if (!tool?.name) {
      return [];
    }
    const mapped: Record<string, unknown> = {
      type: "function",
      name: tool.name,
      parameters: toolParameters(spec),
      strict: false,
    };
    if (tool.description !== undefined) {
      mapped.description = tool.description;
    }
    return [mapped];
  });
}

function serializeToolArguments(input: unknown): string {
  if (typeof input !== "string") {
    return JSON.stringify(input ?? {});
  }
  try {
    JSON.parse(input);
    return input;
  } catch {
    return "{}";
  }
}

function reasoningSignature(message: CwAssistantResponseMessage): string | undefined {
  const content = message.reasoningContent;
  if (content && typeof content === "object") {
    return content.reasoningText?.signature ?? message.reasoningSignature;
  }
  return message.reasoningSignature;
}

/** 将 Kiro 会话历史转换为 OpenAI Responses 的原生 input items。 */
export function buildOpenAIResponsesRequest(
  request: CwRequest,
  options: OpenAIResponsesBuildOptions,
): OpenAIResponsesRequest {
  const state = request.conversationState;
  const history = [...(state.history ?? [])];
  if (state.currentMessage) {
    history.push(state.currentMessage);
  }

  const input: Array<Record<string, unknown>> = [];
  let tools: Array<Record<string, unknown>> | undefined;

  for (const item of history) {
    const user = item.userInputMessage;
    if (user) {
      input.push(...userMessageItems(user));
      const specs = user.userInputMessageContext?.tools;
      if (specs) {
        tools = responseTools(specs);
      }
    }

    const assistant = item.assistantResponseMessage;
    if (assistant?.content) {
      input.push({
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: assistant.content,
          annotations: [],
        }],
      });
    }
    const toolUses = assistant?.toolUses ?? [];
    if (assistant && toolUses.length > 0) {
      const signature = reasoningSignature(assistant);
      const reasoning = signature ? decodeReasoningEnvelope(signature) : undefined;
      if (reasoning) {
        input.push(reasoning);
      }
    }
    for (const call of toolUses) {
      input.push({
        type: "function_call",
        call_id: call.toolUseId,
        name: call.name,
        arguments: serializeToolArguments(call.input),
      });
    }
  }

  const body: OpenAIResponsesRequest = {
    model: options.model,
    input,
    stream: true,
    store: false,
    max_output_tokens: options.maxOutputTokens,
    include: ["reasoning.encrypted_content"],
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  if (options.effort) {
    body.reasoning = { effort: options.effort, summary: "auto" };
  }
  return body;
}
