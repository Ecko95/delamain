import { closeSync, openSync, readSync, statSync } from "node:fs";

export type LogEventKind =
  | "message"
  | "reasoning"
  | "command"
  | "file_change"
  | "error"
  | "turn"
  | "delamain"
  | "raw";

export type LogEventLevel = "info" | "warn" | "error";

export type LogEvent = {
  kind: LogEventKind;
  level: LogEventLevel;
  at: string;
  title: string;
  body?: string;
};

export function parseLogChunk(chunk: string, now: () => Date = () => new Date()): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    events.push(parseLogLine(trimmed, now().toISOString()));
  }
  return events;
}

export function formatLogEvent(event: LogEvent): string[] {
  const icon = iconFor(event);
  const prefix = event.level === "error" ? "ERROR " : event.level === "warn" ? "WARN " : "";
  const lines = [`${icon} ${prefix}${event.title}`];
  if (event.body) {
    const body = prettyJson(event.body) || event.body;
    lines.push(...body.split(/\r?\n/).filter(Boolean).slice(0, 18).map((line) => `  ${compact(line, 180)}`));
  }
  return lines;
}

export class LogBuffer {
  private offset = 0;
  private inode?: number;
  private events: LogEvent[] = [];

  constructor(
    private readonly path: string,
    private readonly capacity = 2000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  readNew(): LogEvent[] {
    const stat = statSync(this.path);
    if (this.inode !== undefined && (stat.ino !== this.inode || stat.size < this.offset)) {
      this.offset = 0;
      this.events = [];
    }
    this.inode = stat.ino;
    if (stat.size === this.offset) {
      return this.events;
    }

    const fd = openSync(this.path, "r");
    try {
      const length = stat.size - this.offset;
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, this.offset);
      this.offset += bytesRead;
      const parsed = parseLogChunk(buffer.subarray(0, bytesRead).toString("utf8"), this.now);
      this.events.push(...parsed);
      if (this.events.length > this.capacity) {
        this.events = this.events.slice(-this.capacity);
      }
      return this.events;
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* best-effort close */
      }
    }
  }

  tail(limit: number): LogEvent[] {
    return this.readNew().slice(-Math.max(0, limit));
  }
}

function parseLogLine(line: string, at: string): LogEvent {
  if (line.startsWith("[delamain]")) {
    return { kind: "delamain", level: "info", at, title: line };
  }
  if (line.startsWith("[stderr]")) {
    return { kind: "error", level: "error", at, title: line };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: "raw", level: "info", at, title: line };
  }
  if (!isRecord(parsed)) {
    return { kind: "raw", level: "info", at, title: JSON.stringify(parsed) };
  }

  return parseStructured(parsed, at);
}

function parseStructured(record: Record<string, unknown>, at: string): LogEvent {
  const type = stringValue(record.type);
  const item = isRecord(record.item) ? record.item : undefined;
  const itemType = stringValue(item?.type);
  const cursorEvent = isRecord(record.event) ? record.event : undefined;
  const cursorType = stringValue(cursorEvent?.type) || stringValue(record.event_type) || stringValue(record.event);
  const effectiveType = itemType || cursorType || type || "json";

  if (type === "turn.started" || type === "turn.completed" || type === "thread.started" || type === "thread.completed") {
    return { kind: "turn", level: "info", at, title: type, body: compactJson(record, ["type", "thread_id"]) };
  }
  if (effectiveType === "agent_message" || type === "agent_message" || type === "assistant" || cursorType === "assistant") {
    return {
      kind: "message",
      level: "info",
      at,
      title: titleWithId("agent message", item),
      body: bodyFrom(item, record, ["text", "message", "content"]),
    };
  }
  if (effectiveType === "reasoning" || type === "reasoning" || cursorType === "reasoning") {
    return {
      kind: "reasoning",
      level: "info",
      at,
      title: titleWithId("reasoning", item),
      body: bodyFrom(item, record, ["text", "summary", "content"]),
    };
  }
  if (effectiveType === "command_execution" || type === "command_execution" || cursorType === "command") {
    const command = stringValue(item?.command) || stringValue(record.command) || stringValue(cursorEvent?.command);
    const status = stringValue(item?.status) || stringValue(record.status) || stringValue(cursorEvent?.status);
    const exitCode = item?.exit_code ?? record.exit_code ?? cursorEvent?.exit_code;
    const output = stringValue(item?.aggregated_output) || stringValue(record.output) || stringValue(cursorEvent?.output);
    return {
      kind: "command",
      level: exitCode && exitCode !== 0 ? "error" : "info",
      at,
      title: `${command ? `command: ${compact(command, 180)}` : "command"}${status || exitCode !== undefined ? ` (${[status, exitCode !== undefined ? `exit=${String(exitCode)}` : undefined].filter(Boolean).join(" ")})` : ""}`,
      body: output,
    };
  }
  if (effectiveType === "file_change" || type === "file_change" || cursorType === "file_change") {
    const path = stringValue(item?.path) || stringValue(record.path) || stringValue(cursorEvent?.path);
    return {
      kind: "file_change",
      level: "info",
      at,
      title: path ? `file change: ${path}` : "file change",
      body: bodyFrom(item, record, ["diff", "summary", "changes"]),
    };
  }
  if (effectiveType === "error" || type === "error" || stringValue(record.level) === "error") {
    return {
      kind: "error",
      level: "error",
      at,
      title: stringValue(record.message) || stringValue(record.error) || "error",
      body: compactJson(record, ["type", "level", "message", "error"]),
    };
  }

  return {
    kind: "raw",
    level: stringValue(record.level) === "error" ? "error" : "info",
    at,
    title: type || cursorType || "json",
    body: compactJson(record, []),
  };
}

function titleWithId(title: string, item: Record<string, unknown> | undefined): string {
  const id = stringValue(item?.id);
  return id ? `${title} ${id}` : title;
}

function bodyFrom(item: Record<string, unknown> | undefined, record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(item?.[key]) || stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return compactJson(record, ["type", "item", "thread_id"]);
}

function compactJson(record: Record<string, unknown>, omitted: string[]): string | undefined {
  const omittedSet = new Set(omitted);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omittedSet.has(key)) {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? compact(JSON.stringify(extra), 240) : undefined;
}

function iconFor(event: LogEvent): string {
  switch (event.kind) {
    case "message":
      return "MSG";
    case "reasoning":
      return "WHY";
    case "command":
      return "CMD";
    case "file_change":
      return "FILE";
    case "error":
      return "ERR";
    case "turn":
      return "TURN";
    case "delamain":
      return "SYS";
    case "raw":
      return "RAW";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function prettyJson(value: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return undefined;
  }
}
