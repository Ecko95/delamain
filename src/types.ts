import type { CodexContextLevel } from "./codexContext.js";

export type PeerStatus =
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "done"
  | "failed"
  | "frozen"
  | "killed"
  // Phase 33 — GSD peer state machine (added in plan 33-01; transitions
  // implemented in 33-02 and 33-03).
  | "gsd_pending"
  | "gsd_running_phase"
  | "gsd_polling_state"
  | "gsd_running_gate_check"
  | "gsd_halted_on_gate_failure"
  | "gsd_completed"
  | "gsd_failed";

export type PeerIntegrationStatus = "pending" | "skipped" | "pushed" | "failed" | "merged";

export type PeerKind = "generic" | "gsd_phase_batch";

export type PeerEngine = "codex" | "cursor";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CursorRunOptions = {
	cloud?: boolean;
	approveMcps?: boolean;
	force?: boolean;
};

export type GsdPlanningMode = "dynamic" | "frozen";

export type GsdBatchSpawnConfig = {
  planning_mode: GsdPlanningMode;
  selected_phases: string[];
  milestone?: string;
  cursor: number;
};

export type PeerRecord = {
  id: string;
  name?: string;
  repo: string;
  sourceRepo?: string;
  branch?: string;
  baseBranch?: string;
  baseRef?: string;
  mergeBranch?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  gitDir?: string;
  gitCommonDir?: string;
  isLinkedWorktree?: boolean;
  model?: string;
  task: string;
  status: PeerStatus;
  runnerPid?: number;
  codexPid?: number;
  enginePid?: number;
  engine?: PeerEngine;
  cursorOptions?: CursorRunOptions;
  // Codex-engine-only tuning knobs (persisted so resume reuses them).
  reasoningEffort?: ReasoningEffort;
  developerInstructions?: string;
  codexConfig?: string[];
  threadId?: string;
  startedAt: string;
  updatedAt: string;
  lastHeartbeatAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
  error?: string;
  lastEvent?: string;
  finalResult?: string;
  question?: string;
  integrationStatus?: PeerIntegrationStatus;
  integrationError?: string;
  integrationCommitSha?: string;
  integrationMergeCommitSha?: string;
  integrationPrNumber?: number;
  integrationPrUrl?: string;
  // S1/S2 context-window observability (codex engine). SEPARATE from `status`;
  // computed from the peer's session JSONL in codexContext.ts. Absent until the
  // first token_count event is seen.
  contextPercent?: number; // current-turn input_tokens as % of the context window
  contextLevel?: CodexContextLevel; // green/yellow/red/skull, thresholds in codexContext.ts
  compacted?: boolean; // codex auto-compacted (lossy) at least once during the run
  // Phase 33 additions:
  kind?: PeerKind; // missing → treat as "generic"
  gsdBatch?: GsdBatchSpawnConfig; // present only when kind === "gsd_phase_batch"
  // ponytail: PROVISIONAL T1 field — a2a peer inbox. Additive/optional, follows
  // the `kind` migration precedent (state.json without it still loads). Reconcile
  // with T1's own types.ts addition at merge. PeerMessage lives in peerInbox.ts.
  inbox?: import("./peerInbox.js").PeerMessage[];
};

/**
 * Coalesce a freshly-deserialized PeerRecord into a stable runtime shape.
 * Currently: defaults missing `kind` to `"generic"` so older on-disk
 * state.json files keep working without migration. Idempotent.
 */
export function normalizePeerRecord(peer: PeerRecord): PeerRecord {
  let next = peer;
  if (next.kind === undefined) {
    next = { ...next, kind: "generic" };
  }
  if (next.engine === undefined) {
    next = { ...next, engine: "codex" };
  }
  return next;
}

export type PeerState = {
  version: 1;
  updatedAt: string;
  peers: PeerRecord[];
};

export type SpawnPeerOptions = {
  repo: string;
  prompt: string;
  name?: string;
  startRef?: string;
  mergeBranch?: string;
  /**
   * Backwards-compatible alias: when startRef is omitted this also selects the
   * origin branch used to create the worktree; when mergeBranch is omitted this
   * selects the origin branch that receives the peer changes.
   */
  targetBranch?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  yolo?: boolean;
  engine?: PeerEngine;
  cursorOptions?: CursorRunOptions;
  // Codex-engine-only tuning knobs; validated + engine-guarded at the MCP boundary.
  reasoningEffort?: ReasoningEffort;
  developerInstructions?: string;
  codexConfig?: string[];
};

export type ResumePeerOptions = {
  peerId: string;
  prompt: string;
  model?: string;
  yolo?: boolean;
};

export type WaitPeerOptions = {
  peerId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  logLines?: number;
};

export type WaitPeerResult = {
  peer: PeerRecord;
  timedOut: boolean;
  elapsedMs: number;
  logTail?: string;
};

export type SpawnPeerAndWaitOptions = SpawnPeerOptions & Omit<WaitPeerOptions, "peerId">;
