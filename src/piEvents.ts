// src/piEvents.ts
//
// SP2 — parse pi's `--print --mode json` NDJSON event stream into the shared
// ParsedCodexEvent shape (so lifecycle.ts / the waiting-resume protocol / the
// dashboard all work unchanged across engines).
//
// pi's schema is structurally DIFFERENT from codex/cursor, so this is NOT a
// clone of codexEvents/cursorEvents' recursive walkers — it switches on the
// flat top-level `type`. Verified against @mariozechner/pi-coding-agent@0.73.1
// dist/*.d.ts and a live capture (tests/fixtures/pi/0.73.1-*.ndjson). See
// docs/superpowers/specs/2026-07-17-sp2-pi-ndjson-step0.md.
//
// Key differences that make a walker clone wrong:
//  - the session/thread id is on key `id` and appears ONLY on line 1;
//  - assistant text is nested in message.content[] and ALSO streamed as
//    text_delta — emitting text from both double-counts, so we take text ONLY
//    from message_end (assistant); text_delta contributes a progress label;
//  - there is no `agent_message` discriminant, so `isAgentMessage` is derived
//    from message_end/agent_end with role "assistant";
//  - tool identity is `toolName` (assistant blocks use camelCase `toolCall`).

import { parseWaitingQuestion, trim } from "./codexEvents.js";
import type { ParsedCodexEvent } from "./codexEvents.js";

const WRITE_TOOL_HINTS = ["write", "edit", "str_replace", "create_file", "patch", "apply_patch", "file_write", "multiedit"];

export function parsePiJsonLine(line: string): ParsedCodexEvent {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let ev: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    ev = parsed as Record<string, unknown>;
  } catch {
    return parseFallbackText(trimmed);
  }

  const type = typeof ev.type === "string" ? ev.type : undefined;

  switch (type) {
    // (a) session id — special case, first line only. NOT via generic key sets.
    case "session": {
      const id = typeof ev.id === "string" ? ev.id : undefined;
      return { type, threadId: id, label: id ? `session ${trim(id, 60)}` : "session" };
    }

    // (b) streaming — progress label only; do NOT emit text (message_end is the
    // authoritative final answer; emitting delta text too would double-count).
    case "message_update": {
      const am = ev.assistantMessageEvent as Record<string, unknown> | undefined;
      const amType = typeof am?.type === "string" ? am.type : undefined;
      if (amType === "text_delta" && typeof am?.delta === "string") {
        return { type, label: trim(am.delta, 180) };
      }
      if (amType === "error") {
        const msg = assistantText(am?.error);
        return {
          type,
          isAgentMessage: true,
          text: msg || undefined,
          label: `error: ${trim(errorMessageOf(am?.error) || msg, 140)}`,
          waitingQuestion: msg ? parseWaitingQuestion(msg) : undefined,
        };
      }
      return { type };
    }

    // (c)+(d) final assistant message + waiting sentinel. `message_end` is the
    // authoritative source; it also fires for the echoed user message, so gate
    // on role "assistant". `turn_end` carries the SAME message — emit it as a
    // label-only marker so text isn't counted twice.
    case "message_end": {
      const m = ev.message as Record<string, unknown> | undefined;
      if (!m || m.role !== "assistant") return { type };
      const text = assistantText(m);
      const failed = m.stopReason === "error" || m.stopReason === "aborted";
      return {
        type,
        isAgentMessage: true,
        text: text || undefined,
        label: failed
          ? `message_end error: ${trim(errorMessageOf(m) || text, 140)}`
          : trim(text, 140) || "message_end",
        waitingQuestion: text ? parseWaitingQuestion(text) : undefined,
      };
    }

    case "turn_end":
    case "agent_end":
      return { type, label: type }; // terminal markers; text already came from message_end

    // (e) tool labels — read toolName directly; correlate via toolCallId.
    case "tool_execution_start":
      return { type, label: `tool ${strOf(ev.toolName) ?? "?"}${argHint(ev.args)}` };
    case "tool_execution_end":
      return { type, label: `tool ${strOf(ev.toolName) ?? "?"} ${ev.isError ? "error" : "ok"}` };
    case "tool_execution_update":
      return { type };

    default:
      // turn_start, agent_start, message_start, queue_update, compaction_*,
      // session_info_changed, thinking_level_changed, auto_retry_* — no
      // user-visible text; keep a label for the log.
      return type ? { type, label: type } : {};
  }
}

/** Join the `text` content blocks of an AssistantMessage (skips thinking/toolCall). */
function assistantText(m: unknown): string {
  const content = (m as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: string; text: string } =>
      !!c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function errorMessageOf(m: unknown): string {
  const e = (m as { errorMessage?: unknown })?.errorMessage;
  return typeof e === "string" ? e : "";
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function argHint(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const hint = strOf(a.path) ?? strOf(a.command) ?? strOf(a.file_path);
  return hint ? ` ${trim(hint, 80)}` : "";
}

function parseFallbackText(text: string): ParsedCodexEvent {
  return { text, label: trim(text, 180), isAgentMessage: true, waitingQuestion: parseWaitingQuestion(text) };
}

/** True when a pi tool name denotes a file write (for write-activity detection). */
export function looksLikeFileWrite(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return WRITE_TOOL_HINTS.some((hint) => lower.includes(hint));
}
