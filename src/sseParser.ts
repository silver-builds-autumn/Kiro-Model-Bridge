export interface ParsedSseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/** 支持任意网络分块、CRLF 和末尾无空行的增量 SSE 解析器。 */
export class SseParser {
  private buffer = "";

  push(chunk: string): ParsedSseEvent[] {
    this.buffer += chunk;
    return this.readCompleteRecords();
  }

  flush(): ParsedSseEvent[] {
    const events = this.readCompleteRecords();
    if (this.buffer.length === 0) {
      return events;
    }
    const trailing = this.parseRecord(this.buffer);
    this.buffer = "";
    if (trailing) {
      events.push(trailing);
    }
    return events;
  }

  private readCompleteRecords(): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = [];
    let match: RegExpExecArray | null;
    const separator = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\r\r|\n\r\n|\n\r|\n\n/;
    while ((match = separator.exec(this.buffer)) !== null) {
      const record = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.parseRecord(record);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  private parseRecord(record: string): ParsedSseEvent | undefined {
    const data: string[] = [];
    let event: string | undefined;
    let id: string | undefined;
    let retry: number | undefined;

    for (const line of record.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      if (field === "data") {
        data.push(value);
      } else if (field === "event") {
        event = value;
      } else if (field === "id" && !value.includes("\0")) {
        id = value;
      } else if (field === "retry" && /^\d+$/.test(value)) {
        retry = Number(value);
      }
    }

    if (data.length === 0) {
      return undefined;
    }
    return {
      ...(event !== undefined ? { event } : {}),
      data: data.join("\n"),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
  }
}
