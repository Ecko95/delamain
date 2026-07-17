// src/workflow/journal.ts
//
// SP1 wave 3 — deterministic replay for resume (design §14). Each ctx.agent()
// call is journaled by its per-run call index with a hash of the inputs that
// determine its result. On (re-)dispatch the engine replays the longest
// unchanged prefix: a call is served from the journal only if its index is
// below the first divergence AND its input hashes match the journaled call.
//
// Hashing covers only what changes the agent's actual work — engine, model,
// and schema — not cosmetic opts (label, phase), so a display-only tweak
// doesn't invalidate an otherwise-identical run.

import { createHash } from "node:crypto";
import type { AgentJournalRow } from "../store.js";

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 32);
}

export function hashOpts(opts: Record<string, unknown> | undefined): string {
  const relevant = {
    engine: opts?.engine ?? "codex",
    model: opts?.model ?? null,
    schema: opts?.schema ?? null,
  };
  return createHash("sha256").update(canonicalize(relevant), "utf8").digest("hex").slice(0, 32);
}

/** Stable JSON: object keys sorted recursively so key order can't change the hash. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

/**
 * Tracks the longest-unchanged-prefix decision across a run's agent calls.
 * Calls are issued in deterministic index order (the sandbox child assigns a
 * monotonic per-agent index), so a synchronous decide() per call is enough.
 */
export class ReplayPlan {
  private readonly byIndex = new Map<number, AgentJournalRow>();
  private divergedAt = Number.POSITIVE_INFINITY;
  private replayed = 0;

  constructor(journal: AgentJournalRow[]) {
    for (const row of journal) {
      this.byIndex.set(row.callIndex, row);
    }
  }

  get replayedCount(): number {
    return this.replayed;
  }

  /**
   * Decide how to serve the agent call at `callIndex`. Returns the cached
   * result to replay, or signals that the call must run live (and marks this
   * index as the divergence point so every later call also runs live).
   */
  decide(callIndex: number, promptHash: string, optsHash: string): { replay: true; result: unknown } | { replay: false } {
    if (callIndex < this.divergedAt) {
      const row = this.byIndex.get(callIndex);
      if (row && row.status === "done" && row.promptHash === promptHash && row.optsHash === optsHash) {
        this.replayed += 1;
        return { replay: true, result: JSON.parse(row.resultJson) };
      }
    }
    // Missing, mismatched, or already past divergence → run live from here on.
    this.divergedAt = Math.min(this.divergedAt, callIndex);
    return { replay: false };
  }
}
