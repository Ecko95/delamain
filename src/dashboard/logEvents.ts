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
  if (effectiveType === "agent_message" || type === "agent_message" || type === "assistant" || cursorType === "assistant" || isRecord(record.message)) {
    const text = stringValue(item?.text) || stringValue(record.text) || nestedMessageText(record) || nestedMessageText(item);
    return {
      kind: "message",
      level: "info",
      at,
      title: text ? compact(text, 200) : "agent message",
      body: undefined,
    };
  }
  if (type === "result") {
    const text = stringValue(record.result) || stringValue(record.message);
    return { kind: "message", level: stringValue(record.subtype) === "error" ? "error" : "info", at, title: text ? `result: ${compact(text, 200)}` : "result" };
  }
  // Cursor streams reasoning as {"type":"thinking","subtype":"delta","text":"..."} — render the text
  // inline, never the JSON envelope (was falling through to the raw dump).
  if (effectiveType === "reasoning" || type === "reasoning" || type === "thinking" || cursorType === "reasoning") {
    const text = stringValue(record.text) || stringValue(item?.text) || stringValue(item?.summary);
    return {
      kind: "reasoning",
      level: "info",
      at,
      title: text ? compact(text, 180) : titleWithId("reasoning", item),
      body: text ? undefined : bodyFrom(item, record, ["text", "summary", "content"]),
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
  // Cursor engine: {"type":"tool_call","subtype":"started|completed","tool_call":{"<name>ToolCall":{"args":{...}}}}.
  // Without this, tool calls fall through to the raw JSON dump (unreadable blobs in the log pane).
  if (type === "tool_call" || isRecord(record.tool_call)) {
    const wrapper = isRecord(record.tool_call) ? record.tool_call : undefined;
    const entryKey = wrapper ? Object.keys(wrapper)[0] : undefined;
    const inner = entryKey && isRecord(wrapper?.[entryKey]) ? (wrapper[entryKey] as Record<string, unknown>) : undefined;
    const args = isRecord(inner?.args) ? inner.args : undefined;
    const name = entryKey ? entryKey.replace(/ToolCall$/, "") : "tool";
    const done = stringValue(record.subtype) === "completed";
    return {
      kind: "command",
      level: "info",
      at,
      title: `${done ? "✓ " : ""}${name}${toolArgSummary(name, args) ? ` ${toolArgSummary(name, args)}` : ""}`,
    };
  }
  if (effectiveType === "file_change" || type === "file_change" || cursorType === "file_change") {
    const changes = arrayValue(item?.changes) || arrayValue(record.changes);
    const first = changes && isRecord(changes[0]) ? (changes[0] as Record<string, unknown>) : undefined;
    const path = stringValue(first?.path) || stringValue(item?.path) || stringValue(record.path) || stringValue(cursorEvent?.path);
    const kind = stringValue(first?.kind);
    const extra = changes && changes.length > 1 ? ` (+${changes.length - 1})` : "";
    return {
      kind: "file_change",
      level: "info",
      at,
      title: path ? `${kind ? `${kind} ` : ""}${baseName(path)}${extra}` : "file change",
      body: changes ? undefined : bodyFrom(item, record, ["diff", "summary"]),
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
    title: compact(type || cursorType || stringValue(record.message) || "event", 120),
    body: undefined,
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
  // Deliberately no JSON fallback — an unrecognized body is noise, not signal (operator feedback).
  return undefined;
}

// Cursor agent messages nest the text at message.content[].text — pull and join the text parts.
function nestedMessageText(record: Record<string, unknown> | undefined): string | undefined {
  const message = isRecord(record?.message) ? record.message : undefined;
  const content = arrayValue(message?.content) || arrayValue(record?.content);
  if (!content) {
    return stringValue(message?.text);
  }
  const parts = content
    .map((entry) => (isRecord(entry) ? stringValue(entry.text) : stringValue(entry)))
    .filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" ") : undefined;
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

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

// Condense a cursor tool call's args into a readable one-liner per tool kind.
function toolArgSummary(name: string, args: Record<string, unknown> | undefined): string {
  if (!args) {
    return "";
  }
  switch (name) {
    case "glob":
      return stringValue(args.globPattern) || "";
    case "read":
    case "write":
    case "edit": {
      const p = stringValue(args.path);
      return p ? baseName(p) : "";
    }
    case "grep":
      return stringValue(args.pattern) || stringValue(args.query) || "";
    case "shell":
    case "bash":
      return compact(stringValue(args.command) || "", 120);
    default:
      return compact(JSON.stringify(args), 80);
  }
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
