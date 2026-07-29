import type { CwEvent } from "../cwTypes";
import { SseParser, type ParsedSseEvent } from "../sseParser";
import {
  encodeReasoningEnvelope,
  type OpenAIReasoningItem,
} from "./reasoningEnvelope";
import type { ProviderStreamConverter } from "./types";

interface ToolCallState {
  itemId?: string;
  outputIndex?: number;
  callId: string;
  name: string;
  arguments: string;
  emitted: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function reasoningItem(value: unknown): OpenAIReasoningItem | undefined {
  const item = record(value);
  if (
    item?.type !== "reasoning"
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
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? value
    : undefined;
}

/** 将 OpenAI Responses SSE 转换为 Kiro 内部事件，并维护安全重试状态。 */
export class OpenAIResponsesStreamConverter implements ProviderStreamConverter {
  public readonly usage = { inputTokens: 0, outputTokens: 0 };
  public committed = false;
  public terminalError?: string;

  private readonly parser = new SseParser();
  private readonly conversationId: string;
  private readonly modelId: string;
  private readonly toolsByIndex = new Map<number, ToolCallState>();
  private readonly toolsByItemId = new Map<string, ToolCallState>();
  private readonly unboundTools: ToolCallState[] = [];
  private metadataSent = false;
  private completed = false;
  private reasoning?: OpenAIReasoningItem;
  private reasoningSignatureSent = false;

  constructor(conversationId: string, modelId: string) {
    this.conversationId = conversationId;
    this.modelId = modelId;
  }

  processLine(chunk: string): CwEvent[] {
    return this.processRecords(this.parser.push(chunk));
  }

  flush(): CwEvent[] {
    const out = this.processRecords(this.parser.flush());
    if (!this.completed && !this.terminalError) {
      this.terminalError = "OpenAI stream ended before response.completed";
    }
    return out;
  }

  private processRecords(records: ParsedSseEvent[]): CwEvent[] {
    const out: CwEvent[] = [];
    for (const sse of records) {
      if (!sse.data || sse.data === "[DONE]") {
        continue;
      }
      try {
        const event = JSON.parse(sse.data) as unknown;
        const value = record(event);
        if (!value) {
          continue;
        }
        if (typeof value.type !== "string" && sse.event) {
          value.type = sse.event;
        }
        out.push(...this.handleEvent(value));
      } catch {
        // Invalid upstream records are ignored; an unterminated stream becomes terminal on flush.
      }
    }
    if (out.some((event) =>
      event.assistantResponseEvent
      || event.reasoningContentEvent
      || event.toolUseEvent
    )) {
      this.committed = true;
    }
    return out;
  }

  private handleEvent(event: Record<string, unknown>): CwEvent[] {
    const type = stringValue(event.type) ?? "";
    if (type === "response.failed") {
      this.setTerminalError("OpenAI response failed", event);
      return [];
    }
    if (type === "response.incomplete") {
      this.setTerminalError("OpenAI response incomplete", event);
      return [];
    }
    if (type === "error") {
      this.setTerminalError("OpenAI stream error", event);
      return [];
    }

    if (type === "response.output_text.delta") {
      const delta = stringValue(event.delta);
      if (!delta) {
        return [];
      }
      return [
        ...this.metadataEvent(),
        { assistantResponseEvent: { content: delta, modelId: this.modelId } },
      ];
    }

    if (type === "response.reasoning_summary_text.delta") {
      const delta = stringValue(event.delta);
      if (!delta) {
        return [];
      }
      return [
        ...this.metadataEvent(),
        { reasoningContentEvent: { text: delta } },
      ];
    }

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = record(event.item);
      if (!item) {
        return [];
      }
      const reasoning = reasoningItem(item);
      if (reasoning) {
        this.reasoning = reasoning;
        return [];
      }
      if (item.type === "function_call") {
        const state = this.captureTool(item, numberValue(event.output_index));
        return type === "response.output_item.done" ? this.emitTool(state) : [];
      }
      return [];
    }

    if (
      type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done"
    ) {
      const state = this.toolForEvent(event);
      if (!state) {
        return [];
      }
      if (type.endsWith(".delta")) {
        state.arguments += stringValue(event.delta) ?? "";
        return [];
      }
      state.arguments = stringValue(event.arguments) ?? state.arguments;
      return this.emitTool(state);
    }

    if (type === "response.completed") {
      this.completed = true;
      const response = record(event.response);
      const output = Array.isArray(response?.output) ? response.output : [];
      const out: CwEvent[] = [];
      for (const rawItem of output) {
        const item = record(rawItem);
        if (!item) {
          continue;
        }
        const reasoning = reasoningItem(item);
        if (reasoning) {
          this.reasoning = reasoning;
        } else if (item.type === "function_call") {
          out.push(...this.emitTool(this.captureTool(item, undefined)));
        }
      }
      out.push(...this.emitReasoningSignature());
      const usage = record(response?.usage);
      this.usage.inputTokens = numberValue(usage?.input_tokens) ?? 0;
      this.usage.outputTokens = numberValue(usage?.output_tokens) ?? 0;
      out.push(...this.metadataEvent(), {
        metadataEvent: {
          type: "token_usage",
          inputTokens: this.usage.inputTokens,
          outputTokens: this.usage.outputTokens,
        },
      });
      return out;
    }

    return [];
  }

  private captureTool(
    item: Record<string, unknown>,
    outputIndex: number | undefined,
  ): ToolCallState {
    const itemId = stringValue(item.id);
    let state = itemId ? this.toolsByItemId.get(itemId) : undefined;
    state ??= outputIndex !== undefined ? this.toolsByIndex.get(outputIndex) : undefined;
    state ??= {
      itemId,
      outputIndex,
      callId: "",
      name: "",
      arguments: "",
      emitted: false,
    };
    state.itemId = itemId ?? state.itemId;
    state.outputIndex = outputIndex ?? state.outputIndex;
    state.callId = stringValue(item.call_id) ?? state.callId;
    state.name = stringValue(item.name) ?? state.name;
    state.arguments = stringValue(item.arguments) ?? state.arguments;
    if (state.itemId) {
      this.toolsByItemId.set(state.itemId, state);
    }
    if (state.outputIndex !== undefined) {
      this.toolsByIndex.set(state.outputIndex, state);
    }
    if (
      state.itemId === undefined
      && state.outputIndex === undefined
      && !this.unboundTools.includes(state)
    ) {
      this.unboundTools.push(state);
    }
    return state;
  }

  private toolForEvent(event: Record<string, unknown>): ToolCallState | undefined {
    const itemId = stringValue(event.item_id);
    const outputIndex = numberValue(event.output_index);
    const mapped = (itemId ? this.toolsByItemId.get(itemId) : undefined)
      ?? (outputIndex !== undefined ? this.toolsByIndex.get(outputIndex) : undefined);
    if (mapped) {
      return mapped;
    }
    const state = this.unboundTools.shift();
    if (!state) {
      return undefined;
    }
    state.itemId = itemId;
    state.outputIndex = outputIndex;
    if (itemId) {
      this.toolsByItemId.set(itemId, state);
    }
    if (outputIndex !== undefined) {
      this.toolsByIndex.set(outputIndex, state);
    }
    return state;
  }

  private emitTool(state: ToolCallState): CwEvent[] {
    if (state.emitted || !state.callId || !state.name) {
      return [];
    }
    state.emitted = true;
    return [
      ...this.metadataEvent(),
      {
        toolUseEvent: {
          toolUseId: state.callId,
          name: state.name,
          input: state.arguments || "{}",
        },
      },
    ];
  }

  private emitReasoningSignature(): CwEvent[] {
    if (!this.reasoning || this.reasoningSignatureSent) {
      return [];
    }
    this.reasoningSignatureSent = true;
    return [
      ...this.metadataEvent(),
      { reasoningContentEvent: { signature: encodeReasoningEnvelope(this.reasoning) } },
    ];
  }

  private metadataEvent(): CwEvent[] {
    if (this.metadataSent) {
      return [];
    }
    this.metadataSent = true;
    return [{ messageMetadataEvent: { conversationId: this.conversationId } }];
  }

  private setTerminalError(label: string, event: Record<string, unknown>): void {
    if (this.terminalError) {
      return;
    }
    const nested = record(event.error) ?? record(record(event.response)?.error);
    const code = safeErrorCode(event.code) ?? safeErrorCode(nested?.code);
    this.terminalError = code ? `${label} (${code})` : label;
  }
}
