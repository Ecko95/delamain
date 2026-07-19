// src/parsedLog.ts
//
// Cockpit contract 1: `delamain log <peer> <lines> --parsed` prints ONE JSON
// object {peerId, engine, events: ParsedLogEvent[]}. Pure, so the wire shape is
// unit-testable without a peer/log on disk. The engine NDJSON parsers
// (codexEvents/cursorEvents/piEvents) are reused verbatim — this only
// classifies each tailed line and normalizes to the ParsedLogEvent shape.

import { parseCodexJsonLine } from "./codexEvents.js";
import { parseCursorJsonLine } from "./cursorEvents.js";
import { parsePiJsonLine } from "./piEvents.js";
import type { PeerEngine } from "./types.js";

export type ParsedLogEvent = {
  type: string;
  text: string | null;
  label: string | null;
  isAgentMessage: boolean;
  waitingQuestion: string | null;
  raw?: string;
};

const PARSERS = {
  codex: parseCodexJsonLine,
  cursor: parseCursorJsonLine,
  pi: parsePiJsonLine,
} as const;

function plain(type: string, line: string): ParsedLogEvent {
  return { type, text: line, label: null, isAgentMessage: false, waitingQuestion: null };
}

function isJson(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function parseLine(line: string, engine: PeerEngine): ParsedLogEvent {
  // Runner-emitted plain lines are prefixed; classify by prefix, not JSON.
  if (line.startsWith("[delamain] ")) return plain("runner", line);
  if (line.startsWith("[stderr] ")) return plain("stderr", line);
  if (!isJson(line)) {
    return { type: "raw", raw: line, text: null, label: null, isAgentMessage: false, waitingQuestion: null };
  }
  const p = PARSERS[engine](line);
  return {
    type: p.type ?? "event",
    text: p.text ?? null,
    label: p.label ?? null,
    isAgentMessage: Boolean(p.isAgentMessage),
    waitingQuestion: p.waitingQuestion ?? null,
  };
}

/** Build the contract-1 object from a raw log tail (already sliced to N lines). */
export function buildParsedLog(peerId: string, engine: PeerEngine, rawLog: string) {
  const events = rawLog
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => parseLine(line, engine));
  return { peerId, engine, events };
}
