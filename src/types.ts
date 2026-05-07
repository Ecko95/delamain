export type PeerStatus =
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "done"
  | "failed"
  | "frozen"
  | "killed";

export type PeerIntegrationStatus = "pending" | "skipped" | "pushed" | "failed";

export type PeerRecord = {
  id: string;
  name?: string;
  repo: string;
  sourceRepo?: string;
  branch?: string;
  baseBranch?: string;
  baseRef?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  gitDir?: string;
  gitCommonDir?: string;
  isLinkedWorktree?: boolean;
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
};

export type PeerState = {
  version: 1;
  updatedAt: string;
  peers: PeerRecord[];
};

export type SpawnPeerOptions = {
  repo: string;
  prompt: string;
  name?: string;
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
