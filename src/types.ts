export type PeerStatus =
  | "starting"
  | "working"
  | "waiting"
  | "idle"
  | "done"
  | "failed"
  | "frozen"
  | "killed";

export type PeerRecord = {
  id: string;
  name?: string;
  repo: string;
  branch?: string;
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
