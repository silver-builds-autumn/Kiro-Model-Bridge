import { StringDecoder } from "string_decoder";
import type { CwEvent } from "./cwTypes";
import type { PreparedProviderRequest, ProviderStreamConverter } from "./providers/types";
import { SseParser, type ParsedSseEvent } from "./sseParser";
import { readBody, type UpstreamResponse } from "./upstream";

export interface ProviderTransport {
  request(prepared: PreparedProviderRequest): Promise<UpstreamResponse>;
}

export interface ProviderSink {
  begin(): void;
  write(event: CwEvent): void;
  fail(message: string): void;
  end(): void;
}

export interface ProviderRetryOptions {
  maxRetries: number;
  conversationId?: string;
}

interface PumpResult {
  streamError?: string;
}

function retryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function feedRecord(
  converter: ProviderStreamConverter,
  event: ParsedSseEvent,
): CwEvent[] {
  const out: CwEvent[] = [];
  if (event.event) {
    out.push(...converter.processLine(`event: ${event.event}\n`));
  }
  for (const line of event.data.split("\n")) {
    out.push(...converter.processLine(`data: ${line}\n`));
  }
  out.push(...converter.processLine("\n"));
  return out;
}

function pumpUpstream(
  response: UpstreamResponse,
  converter: ProviderStreamConverter,
  onEvents: (events: CwEvent[]) => void,
): Promise<PumpResult> {
  return new Promise((resolve) => {
    const parser = new SseParser();
    const decoder = new StringDecoder("utf8");
    const body = response.body;
    let settled = false;
    let ended = false;

    const consume = (text: string) => {
      for (const event of parser.push(text)) {
        onEvents(feedRecord(converter, event));
      }
    };

    const finish = (result: PumpResult) => {
      if (settled) {
        return;
      }
      settled = true;
      body.removeListener("data", onData);
      body.removeListener("end", onEnd);
      body.removeListener("error", onError);
      body.removeListener("close", onClose);
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      try {
        consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
      } catch {
        finish({ streamError: "Upstream stream conversion failed" });
      }
    };
    const onEnd = () => {
      ended = true;
      try {
        consume(decoder.end());
        for (const event of parser.flush()) {
          onEvents(feedRecord(converter, event));
        }
        onEvents(converter.flush());
        finish({});
      } catch {
        finish({ streamError: "Upstream stream conversion failed" });
      }
    };
    const onError = () => finish({ streamError: "Upstream stream error" });
    const onClose = () => {
      if (!ended) {
        finish({ streamError: "Upstream stream closed unexpectedly" });
      }
    };

    body.on("data", onData);
    body.once("end", onEnd);
    body.once("error", onError);
    body.once("close", onClose);
  });
}

/** 以 Provider 契约执行上游流，并严格限制为提交前重试。 */
export async function runPreparedWithRetry(
  prepared: PreparedProviderRequest,
  transport: ProviderTransport,
  sink: ProviderSink,
  options: ProviderRetryOptions,
): Promise<void> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries));
  const maxAttempts = maxRetries + 1;
  let sinkStarted = false;
  let sinkEnded = false;

  const begin = () => {
    if (!sinkStarted) {
      sink.begin();
      sinkStarted = true;
    }
  };
  const end = () => {
    if (!sinkEnded) {
      sink.end();
      sinkEnded = true;
    }
  };
  const fail = (message: string) => {
    begin();
    sink.fail(message);
    end();
  };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let upstream: UpstreamResponse;
    try {
      upstream = await transport.request(prepared);
    } catch {
      if (attempt + 1 < maxAttempts) {
        continue;
      }
      fail("Upstream connection failed");
      return;
    }

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      try {
        await readBody(upstream.body);
      } catch {
        // The status code remains sufficient for retry and user-facing failure.
      }
      if (retryableStatus(upstream.statusCode) && attempt + 1 < maxAttempts) {
        continue;
      }
      fail(`Upstream HTTP ${upstream.statusCode}`);
      return;
    }

    const converter = prepared.createConverter(options.conversationId ?? "unknown");
    let pending: CwEvent[] = [];
    const writePendingIfCommitted = (events: CwEvent[]) => {
      pending.push(...events);
      if (!converter.committed) {
        return;
      }
      begin();
      for (const event of pending) {
        sink.write(event);
      }
      pending = [];
    };
    const pumped = await pumpUpstream(upstream, converter, writePendingIfCommitted);
    const terminalError = converter.terminalError ?? pumped.streamError;

    if (terminalError) {
      if (!converter.committed && attempt + 1 < maxAttempts) {
        continue;
      }
      if (converter.committed) {
        begin();
        for (const event of pending) {
          sink.write(event);
        }
        pending = [];
      }
      fail(terminalError);
      return;
    }

    begin();
    for (const event of pending) {
      sink.write(event);
    }
    end();
    return;
  }
}
