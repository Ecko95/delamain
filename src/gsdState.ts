// src/gsdState.ts
//
// STATE.md parser for the GSD peer runner. Reads <repo>/.planning/STATE.md
// (the canonical phase-boundary signal) and parses its YAML-ish frontmatter
// into a typed shape. The runner uses this to decide whether to advance to
// the next phase, halt, or finish a gsd_phase_batch.
//
// IMPORTANT: this module does NOT read .planning/HANDOFF.json. Per the
// Phase 33 ADR (.codex/adrs/2026-05-10-reject-gsd-sdk-runner-merge.md),
// HANDOFF.json presence means "session paused" — it is NOT a status
// signal the dispatcher should consume. Cherry-picked from the parked
// feat/gsd-sdk-runner branch's src/gsdState.ts (lines 76-126 — the
// parser; everything else discarded).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type GsdStateFrontmatter = {
  status?: string;
  current_phase?: string;
  phase?: string; // some milestones expose phase under this key
  phase_status?: string; // per-phase completion: complete | in_progress | paused | failed
  complete?: boolean; // derived: status === "complete" OR phase_status === "complete"
  stopped_at?: string;
  last_updated?: string;
  milestone?: string;
  milestone_name?: string;
  percent?: number;
};

export class GsdStateMissingError extends Error {
  readonly code = "GSD_STATE_MISSING";
  constructor(readonly absPath: string) {
    super(`gsd-state: STATE.md not found at ${absPath}`);
    this.name = "GsdStateMissingError";
  }
}

export class GsdStateMalformedError extends Error {
  readonly code = "GSD_STATE_MALFORMED";
  constructor(
    readonly absPath: string,
    readonly detail: string,
  ) {
    super(`gsd-state: malformed STATE.md at ${absPath}: ${detail}`);
    this.name = "GsdStateMalformedError";
  }
}

/**
 * Read STATE.md from a repo. Prefers `gsd-sdk query state-document --json`
 * when available on PATH (richer parse, follows GSD's own conventions);
 * falls back to direct file read + frontmatter parse.
 */
export async function readStateDocument(repo: string): Promise<GsdStateFrontmatter> {
  const viaSdk = tryReadViaGsdSdk(repo);
  if (viaSdk !== undefined) {
    return viaSdk;
  }
  return readStateDocumentDirect(repo);
}

function tryReadViaGsdSdk(repo: string): GsdStateFrontmatter | undefined {
  let r;
  try {
    r = spawnSync(
      "gsd-sdk",
      ["query", "state-document", "--json", "--cwd", repo],
      { encoding: "utf8" },
    );
  } catch {
    return undefined;
  }
  if (r.error || r.status !== 0 || !r.stdout) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    const front = (
      typeof parsed.frontmatter === "object" && parsed.frontmatter !== null
        ? (parsed.frontmatter as Record<string, unknown>)
        : parsed
    ) as Record<string, unknown>;
    return normaliseFrontmatter(front);
  } catch {
    return undefined;
  }
}

async function readStateDocumentDirect(repo: string): Promise<GsdStateFrontmatter> {
  const absPath = join(repo, ".planning", "STATE.md");
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      throw new GsdStateMissingError(absPath);
    }
    throw err;
  }
  const front = extractFrontmatter(raw);
  if (!front) {
    throw new GsdStateMalformedError(absPath, "no YAML frontmatter found");
  }
  return parseFrontmatter(front);
}

// CHERRY-PICKED VERBATIM from feat/gsd-sdk-runner branch src/gsdState.ts:76-86.
function extractFrontmatter(raw: string): string | undefined {
  if (!raw.startsWith("---")) {
    return undefined;
  }
  const rest = raw.slice(3).replace(/^\r?\n/, "");
  const end = rest.indexOf("\n---");
  if (end < 0) {
    return undefined;
  }
  return rest.slice(0, end);
}

// CHERRY-PICKED + EXTENDED from feat/gsd-sdk-runner branch src/gsdState.ts:88-126.
// Additions: current_phase, phase, phase_status, complete (derived).
function parseFrontmatter(text: string): GsdStateFrontmatter {
  const out: GsdStateFrontmatter = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const topLevel = rawLine.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (topLevel) {
      const key = topLevel[1];
      const value = unquote(topLevel[2].trim());
      if (!value) continue;
      switch (key) {
        case "status":
          out.status = value;
          break;
        case "current_phase":
          out.current_phase = value;
          break;
        case "phase":
          out.phase = value;
          break;
        case "phase_status":
          out.phase_status = value;
          break;
        case "stopped_at":
          out.stopped_at = value;
          break;
        case "last_updated":
          out.last_updated = value;
          break;
        case "milestone":
          out.milestone = value;
          break;
        case "milestone_name":
          out.milestone_name = value;
          break;
      }
      continue;
    }
    const nested = rawLine.match(/^\s+([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (nested && nested[1] === "percent") {
      const num = Number(unquote(nested[2].trim()));
      if (Number.isFinite(num)) out.percent = num;
    }
  }
  out.complete = out.status === "complete" || out.phase_status === "complete";
  return out;
}

function normaliseFrontmatter(raw: Record<string, unknown>): GsdStateFrontmatter {
  const out: GsdStateFrontmatter = {};
  const stringKeys = [
    "status",
    "current_phase",
    "phase",
    "phase_status",
    "stopped_at",
    "last_updated",
    "milestone",
    "milestone_name",
  ] as const;
  for (const k of stringKeys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim() !== "") {
      out[k] = v;
    }
  }
  if (typeof raw.percent === "number" && Number.isFinite(raw.percent)) {
    out.percent = raw.percent;
  }
  out.complete = out.status === "complete" || out.phase_status === "complete";
  return out;
}

// CHERRY-PICKED VERBATIM from feat/gsd-sdk-runner branch src/gsdState.ts:128-136.
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Determine if a phase has finished, given the most-recent STATE.md and
 * the phaseId the runner just dispatched. Two heuristics, OR-combined:
 *
 * 1. `current_phase` (or `phase`) advanced past `phaseId` (numeric-prefix
 *    compare on the leading "<number>" or "<number>.<number>" prefix).
 * 2. `complete: true` AND `current_phase`/`phase` equals `phaseId`
 *    (the phase finished and STATE.md is reporting its terminal state).
 */
export function isPhaseComplete(state: GsdStateFrontmatter, phaseId: string): boolean {
  const reportedPhase = state.current_phase ?? state.phase;
  if (!reportedPhase) {
    return state.complete === true;
  }
  if (reportedPhase === phaseId) {
    return state.complete === true;
  }
  // Compare numeric prefixes.
  const a = numericPrefix(reportedPhase);
  const b = numericPrefix(phaseId);
  if (a === undefined || b === undefined) {
    return false;
  }
  return a > b;
}

function numericPrefix(id: string): number | undefined {
  const m = id.match(/^(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  return Number(m[1]);
}
