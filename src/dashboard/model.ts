import type { PeerRecord, PeerStatus } from "../types.js";

export type DashboardStatus = PeerStatus | "cleanup";
export type WorktreeRisk = "shared-checkout" | "shared-branch";
export type DashboardMode = "normal" | "kill-confirm" | "help";
export type DashboardFocusPane = "peers" | "details" | "logs" | "status";

export type DashboardState = {
  selectedIndex?: number;
  selectedPeerId?: string;
  expandedPeerId?: string;
  focusPane?: DashboardFocusPane;
  mode?: DashboardMode;
  message?: string;
  logOffset?: number;
};

export type DashboardPeerRow = {
  id: string;
  index: number;
  status: DashboardStatus;
  project: string;
  branch: string;
  worktree: string;
  pid: string;
  elapsed: string;
  lastEvent: string;
  risk?: WorktreeRisk;
  selected: boolean;
  expanded: boolean;
};

export type DashboardDetailRow = {
  label: string;
  value: string;
};

export type DashboardViewModel = {
  peers: DashboardPeerRow[];
  selectedPeer?: PeerRecord;
  selectedIndex: number;
  counts: Record<DashboardStatus, number>;
  warnings: string[];
  details: DashboardDetailRow[];
  logLines: string[];
  message: string;
  focusPane: DashboardFocusPane;
  mode: DashboardMode;
};

export type DashboardViewModelOptions = {
  now?: Date;
  logLimit?: number;
  logProvider?: (peerId: string, lines: number) => string;
};

const LOG_LIMIT = 80;
const FOCUS_PANES: DashboardFocusPane[] = ["peers", "details", "logs", "status"];
const STATUS_COLORS: Record<DashboardStatus, string> = {
  starting: "#60a5fa",
  working: "#22d3ee",
  waiting: "#facc15",
  idle: "#94a3b8",
  done: "#a3a3a3",
  cleanup: "#34d399",
  failed: "#f87171",
  frozen: "#c084fc",
  killed: "#fb923c",
};

export function createDashboardViewModel(
  inputPeers: PeerRecord[],
  state: DashboardState = {},
  options: DashboardViewModelOptions = {},
): DashboardViewModel {
  const peers = dashboardPeers(inputPeers);
  const selectedIndex = selectedIndexFor(peers, state);
  const selectedPeer = peers[selectedIndex];
  const worktrees = analyzeWorktrees(peers);
  const now = options.now || new Date();
  const rows = peers.map((peer, index) => ({
    id: peer.id,
    index,
    status: dashboardStatus(peer),
    project: projectLabel(peer),
    branch: valueOrDash(peer.baseBranch || peer.branch),
    worktree: worktreeLabel(peer, worktrees.risks.get(peer.id)),
    pid: valueOrDash(String(peer.codexPid || peer.runnerPid || "")),
    elapsed: duration(peer.startedAt, peer.finishedAt, now),
    lastEvent: valueOrDash(peer.question || peer.lastEvent),
    risk: worktrees.risks.get(peer.id),
    selected: index === selectedIndex,
    expanded: state.expandedPeerId === peer.id,
  }));
  const mode = state.mode || "normal";
  const logLines = selectedPeer ? safeLogTail(selectedPeer.id, options) : [];
  const logOffset = Math.max(0, state.logOffset || 0);

  return {
    peers: rows,
    selectedPeer,
    selectedIndex,
    counts: countByDashboardStatus(peers),
    warnings: worktrees.warnings,
    details: selectedPeer ? detailRows(selectedPeer) : [],
    logLines: logOffset > 0 ? logLines.slice(0, Math.max(0, logLines.length - logOffset)) : logLines,
    message: messageForState(state, selectedPeer, mode),
    focusPane: state.focusPane || "peers",
    mode,
  };
}

export function nextFocusPane(current: DashboardFocusPane = "peers", direction: 1 | -1 = 1): DashboardFocusPane {
  const index = FOCUS_PANES.indexOf(current);
  const safeIndex = index === -1 ? 0 : index;
  return FOCUS_PANES[(safeIndex + direction + FOCUS_PANES.length) % FOCUS_PANES.length];
}

export function clampSelectedIndex(index: number, peerCount: number): number {
  if (peerCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), peerCount - 1);
}

export function dashboardPeers(peers: PeerRecord[]): PeerRecord[] {
  return [...peers].sort((a, b) => statusRank(a) - statusRank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function dashboardStatus(peer: PeerRecord): DashboardStatus {
  if (peer.status === "done" && peer.integrationStatus === "pushed") {
    return "cleanup";
  }
  return peer.status;
}

export function statusColor(status: DashboardStatus): string {
  return STATUS_COLORS[status];
}

export function projectLabel(peer: Pick<PeerRecord, "sourceRepo" | "repo" | "worktreePath">): string {
  const source = peer.sourceRepo || peer.repo;
  const parts = source.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return source || "-";
  }
  const markerIndex = findProjectMarker(parts);
  if (markerIndex !== -1 && markerIndex < parts.length - 1) {
    return parts.slice(markerIndex + 1).join("/");
  }
  return parts.slice(Math.max(0, parts.length - 2)).join("/");
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}...`.slice(0, max);
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 3) {
    return text.slice(0, max);
  }
  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half)}...${text.slice(text.length - (max - half - 3))}`;
}

function selectedIndexFor(peers: PeerRecord[], state: DashboardState): number {
  if (state.selectedPeerId) {
    const index = peers.findIndex((peer) => peer.id === state.selectedPeerId);
    if (index !== -1) {
      return index;
    }
  }
  return clampSelectedIndex(state.selectedIndex || 0, peers.length);
}

function messageForState(state: DashboardState, selected: PeerRecord | undefined, mode: DashboardMode): string {
  if (mode === "kill-confirm" && selected) {
    return `Kill selected peer? ${selected.id} (${projectLabel(selected)}) - enter confirms, escape cancels`;
  }
  if (mode === "kill-confirm") {
    return "Kill selected peer? No peer selected - escape cancels";
  }
  return state.message || "Ready";
}

function safeLogTail(peerId: string, options: DashboardViewModelOptions): string[] {
  const limit = Math.min(Math.max(options.logLimit || LOG_LIMIT, 0), LOG_LIMIT);
  if (limit <= 0 || !options.logProvider) {
    return [];
  }
  try {
    return options.logProvider(peerId, limit)
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-limit);
  } catch {
    return [];
  }
}

function detailRows(peer: PeerRecord): DashboardDetailRow[] {
  const rows: DashboardDetailRow[] = [
    { label: "project", value: projectLabel(peer) },
    { label: "source", value: valueOrDash(peer.sourceRepo) },
    { label: "worktree", value: valueOrDash(peer.worktreePath || peer.repo) },
    { label: "base", value: valueOrDash(peer.baseRef || peer.baseBranch) },
    { label: "peer branch", value: valueOrDash(peer.worktreeBranch || peer.branch) },
    { label: "task", value: valueOrDash(peer.task) },
    { label: "integration", value: integrationLabel(peer) },
    { label: "log", value: valueOrDash(peer.logPath) },
  ];
  if (peer.question) {
    rows.push({ label: "question", value: peer.question });
  }
  rows.push({ label: "last event", value: valueOrDash(peer.lastEvent) });
  return rows;
}

function integrationLabel(peer: PeerRecord): string {
  const status = peer.integrationStatus || "pending";
  return peer.integrationError ? `${status} (${peer.integrationError})` : status;
}

function countByDashboardStatus(peers: PeerRecord[]): Record<DashboardStatus, number> {
  return peers.reduce((acc, peer) => {
    const status = dashboardStatus(peer);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<DashboardStatus, number>);
}

function statusRank(peer: PeerRecord): number {
  if (peer.status === "waiting") {
    return 0;
  }
  if (peer.status === "starting" || peer.status === "working") {
    return 1;
  }
  if (peer.status === "failed" || peer.status === "frozen") {
    return 2;
  }
  if (peer.status === "done" && peer.integrationStatus === "pushed") {
    return 3;
  }
  if (peer.status === "done") {
    return 4;
  }
  if (peer.status === "killed") {
    return 5;
  }
  return 6;
}

function analyzeWorktrees(peers: PeerRecord[]): { risks: Map<string, WorktreeRisk>; warnings: string[] } {
  const active = peers.filter(isActive);
  const risks = new Map<string, WorktreeRisk>();
  const warnings: string[] = [];

  for (const group of groupedBy(active, (peer) => peer.worktreePath || peer.repo)) {
    if (group.length <= 1) {
      continue;
    }
    for (const peer of group) {
      risks.set(peer.id, "shared-checkout");
    }
    warnings.push(
      `shared checkout: ${group.map((peer) => peer.id).join(", ")} all use ${truncateMiddle(group[0].worktreePath || group[0].repo, 72)}`,
    );
  }

  for (const group of groupedBy(
    active.filter((peer) => peer.branch && peer.gitCommonDir),
    (peer) => `${peer.gitCommonDir || peer.repo}::${peer.branch}`,
  )) {
    const paths = new Set(group.map((peer) => peer.worktreePath || peer.repo));
    if (group.length <= 1 || paths.size <= 1) {
      continue;
    }
    for (const peer of group) {
      if (!risks.has(peer.id)) {
        risks.set(peer.id, "shared-branch");
      }
    }
    warnings.push(
      `same branch: ${group.map((peer) => peer.id).join(", ")} are on ${group[0].branch} across ${paths.size} worktrees`,
    );
  }

  return { risks, warnings: warnings.slice(0, 3) };
}

function groupedBy<T>(items: T[], keyFor: (item: T) => string | undefined): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (!key) {
      continue;
    }
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

function isActive(peer: PeerRecord): boolean {
  return peer.status === "starting" || peer.status === "working";
}

function worktreeLabel(peer: PeerRecord, risk?: WorktreeRisk): string {
  if (risk === "shared-checkout") {
    return "shared";
  }
  if (risk === "shared-branch") {
    return "branch";
  }
  if (peer.isLinkedWorktree === true) {
    return "linked";
  }
  if (peer.gitCommonDir) {
    return "main";
  }
  return "unknown";
}

function duration(start: string, end: string | undefined, now: Date): string {
  const ms = (end ? Date.parse(end) : now.getTime()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) {
    return "-";
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function valueOrDash(value: string | undefined): string {
  return value && value.length > 0 ? value : "-";
}

function findProjectMarker(parts: string[]): number {
  const markers = new Set(["dev", "projects", "project", "repos", "repositories", "src", "work"]);
  let found = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (markers.has(parts[index].toLowerCase())) {
      found = index;
    }
  }
  return found;
}
