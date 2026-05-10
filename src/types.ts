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

export type PeerIntegrationStatus = "pending" | "skipped" | "pushed" | "failed";

export type PeerKind = "generic" | "gsd_phase_batch";

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
  // Phase 33 additions:
  kind?: PeerKind; // missing → treat as "generic"
  gsdBatch?: GsdBatchSpawnConfig; // present only when kind === "gsd_phase_batch"
};

/**
 * Coalesce a freshly-deserialized PeerRecord into a stable runtime shape.
 * Currently: defaults missing `kind` to `"generic"` so older on-disk
 * state.json files keep working without migration. Idempotent.
 */
export function normalizePeerRecord(peer: PeerRecord): PeerRecord {
  if (peer.kind === undefined) {
    return { ...peer, kind: "generic" };
  }
  return peer;
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
