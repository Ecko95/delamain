// src/workflow/gsd.ts
//
// SP1 wave 7 — autonomous GSD on the engine (design §10). This is the
// engine-integrated preset over the proven per-phase loop in gsdRunner.ts:
// it keeps delamain's differentiators (multi-engine leaves, frozen-gate
// gateFrozenPhase, frozen-eligibility classifyFrozenBatch) and grafts gsd-pi
// auto-mode hardening (stuck-detection, wall-clock ceiling) while wiring the
// batch into the wave-4 workflow event stream.
//
// DESIGN DECISION (the wave-7 crux): GSD phases are STATEFUL across a single
// repo — /gsd-autonomous mutates .planning/ and each phase reads the cumulative
// STATE.md. They are therefore run IN-REPO and sequentially (option (b) from the
// handoff plan), NOT as worktree-isolated ctx.agent leaves (option (a)), which
// would reset .planning between phases. So gsd.ts reuses the engine's SUPPORTING
// facilities (event stream, stuck-detection, timeout, and — via dispatchGsdPeer's
// Map + the cursor-based advance — crash-recovery) rather than the sandboxed
// ctx.agent fan-out. `runGsdPhaseBatch` stays the primitive; this is its
// autonomous caller.

import { readStateDocument, isPhaseComplete, GsdStateMissingError } from "../gsdState.js";
import { runGsdPhaseBatch, type GsdRunnerDeps, type GsdRunOpts } from "../gsdRunner.js";
import { emitWorkflowEvent, type WorkflowEventType } from "./events.js";
import type { GsdPlanningMode, PeerRecord } from "../types.js";

export type DerivedGsdState = {
  /** current_phase reported by STATE.md (or undefined if none/missing). */
  currentPhase?: string;
  /** True when STATE.md marks the derived current phase complete. */
  complete: boolean;
  /** The next phase to run from `selectedPhases`, or undefined when exhausted. */
  nextPhase?: string;
  /** Index of nextPhase within selectedPhases (or the length when exhausted). */
  cursor: number;
};

/**
 * Read `.planning/STATE.md` and decide the next unit: the first selected phase
 * that STATE.md does not yet mark complete. Used to resume/derive a batch's
 * cursor from the repo's ground truth (gsd-pi's deriveState). Missing STATE.md
 * → start at the first phase.
 */
export async function deriveState(repo: string, selectedPhases: string[]): Promise<DerivedGsdState> {
  let state: Awaited<ReturnType<typeof readStateDocument>> | undefined;
  try {
    state = await readStateDocument(repo);
  } catch (err) {
    if (!(err instanceof GsdStateMissingError)) throw err;
  }
  const currentPhase = state ? (state.current_phase ?? state.phase ?? undefined) : undefined;
  let cursor = 0;
  if (state) {
    while (cursor < selectedPhases.length && isPhaseComplete(state, selectedPhases[cursor])) {
      cursor += 1;
    }
  }
  return {
    currentPhase,
    complete: state ? (cursor >= selectedPhases.length) : false,
    nextPhase: cursor < selectedPhases.length ? selectedPhases[cursor] : undefined,
    cursor,
  };
}

export type AutonomousGsdOpts = {
  codexBin?: string;
  /** Wall-clock ceiling on the whole batch (three-tier "hard" timeout). */
  hardTimeoutMs?: number;
  /** Disable the stuck-detection diagnostic retry (on by default here). */
  stuckRetry?: boolean;
  now?: () => number;
  /** Override the event sink (defaults to the workflow event stream). */
  emitEvent?: (type: string, payload: Record<string, unknown>) => void;
};

/**
 * Drive a GSD phase batch with the autonomous preset: stuck-detection ON,
 * lifecycle events streamed, optional hard timeout. Frozen-gate and cursor
 * advance are inherited unchanged from runGsdPhaseBatch.
 */
export function runAutonomousGsd(
  peer: PeerRecord,
  deps: GsdRunnerDeps,
  opts: AutonomousGsdOpts = {},
): Promise<PeerRecord> {
  const emit =
    opts.emitEvent ??
    ((type: string, payload: Record<string, unknown>) => emitWorkflowEvent(peer.id, type as WorkflowEventType, payload));
  const runOpts: GsdRunOpts = {
    codexBin: opts.codexBin,
    stuckRetry: opts.stuckRetry ?? true,
    hardTimeoutMs: opts.hardTimeoutMs,
    onEvent: emit,
    now: opts.now,
  };
  return runGsdPhaseBatch(peer, deps, runOpts);
}

/** Re-exported so callers can construct a planning-mode batch config. */
export type { GsdPlanningMode };
