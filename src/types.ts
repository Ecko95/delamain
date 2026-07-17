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
  | "gsd_failed"
  // SP1 wave 1 — workflow_run records reuse the generic statuses plus this
  // one: the run was stopped by an engine-level termination guard (timeoutMs).
  | "halted";

// Statuses that mean the peer's run is over. Shared by the sweep and the
// dashboards (see dashboard/v3Input.ts) so membership has one source of truth.
export const TERMINAL_PEER_STATUSES: ReadonlySet<PeerStatus> = new Set<PeerStatus>([
  "done",
  "failed",
  "killed",
  "gsd_completed",
  "gsd_failed",
  "halted",
]);

export type PeerIntegrationStatus = "pending" | "skipped" | "pushed" | "failed" | "merged";

export type PeerKind = "generic" | "gsd_phase_batch" | "workflow_run";

export type PeerEngine = "codex" | "cursor" | "pi";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type CursorRunOptions = {
	cloud?: boolean;
	approveMcps?: boolean;
	force?: boolean;
};

// SP2 — pi-engine-only options. Ignored when engine != "pi".
export type PiRunOptions = {
	tools?: string[];
	thinking?: string;
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
  piOptions?: PiRunOptions;
  // Codex-engine-only tuning knobs (persisted so resume reuses them).
  reasoningEffort?: ReasoningEffort;
  developerInstructions?: string;
  codexConfig?: string[];
  // SP1 wave 4: false keeps codex hooks enabled (SubagentStart/Stop) for a
  // multi_agent leaf. Omitted/true = the legacy `--disable hooks`.
  disableHooks?: boolean;
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
  // Citadel-adoption: ids of peers whose work this peer builds on. Integration
  // is refused until every dependency has integrationStatus "merged".
  dependsOn?: string[];
  // Citadel-adoption: repo-relative path prefixes this peer intends to write.
  // Suffix ":ro" marks a read-only claim (never conflicts). Enforced at spawn.
  claims?: string[];
  // S1/S2 context-window observability (codex engine). SEPARATE from `status`;
  // computed from the peer's session JSONL in codexContext.ts. Absent until the
  // first token_count event is seen.
  contextPercent?: number; // current-turn input_tokens as % of the context window
  contextLevel?: CodexContextLevel; // green/yellow/red/skull, thresholds in codexContext.ts
  compacted?: boolean; // codex auto-compacted (lossy) at least once during the run
  // SP1 wave 1 — false means the runner must NOT push the peer branch on
  // done (ephemeral workflow leaf). Persisted so resume (schema-retry) keeps
  // the same behavior. Missing → legacy push-on-done.
  integrate?: boolean;
  // Phase 33 additions:
  kind?: PeerKind; // missing → treat as "generic"
  gsdBatch?: GsdBatchSpawnConfig; // present only when kind === "gsd_phase_batch"
  // SP1 wave 1: present only when kind === "workflow_run".
  workflow?: import("./workflow/types.js").WorkflowRunConfig;
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
  piOptions?: PiRunOptions;
  // Codex-engine-only tuning knobs; validated + engine-guarded at the MCP boundary.
  reasoningEffort?: ReasoningEffort;
  developerInstructions?: string;
  codexConfig?: string[];
  /** SP1 wave 4: false keeps codex hooks enabled (multi_agent observability). */
  disableHooks?: boolean;
  dependsOn?: string[];
  claims?: string[];
  claimsOverride?: boolean;
  /**
   * SP1 wave 1: false spawns an ephemeral leaf whose branch is never pushed
   * on done (workflow agents). Omitted/true keeps the legacy push-on-done.
   */
  integrate?: boolean;
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
