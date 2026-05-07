import { stdout, stdin } from "node:process";
import { basename } from "node:path";
import { killPeer, listPeers, readPeerLog, tmuxStatusLine } from "./peerManager.js";
import type { PeerRecord, PeerStatus } from "./types.js";

const COLORS: Record<string, string> = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

type DashboardState = {
  killMode: boolean;
  input: string;
  selectedIndex: number;
  expandedPeerId?: string;
  message?: string;
};

type DashboardStatus = PeerStatus | "cleanup";

export function startDashboard(): void {
  const state: DashboardState = { killMode: false, input: "", selectedIndex: 0 };
  let peers: PeerRecord[] = [];

  function draw(): void {
    peers = dashboardPeers(listPeers());
    state.selectedIndex = clampSelectedIndex(state.selectedIndex, peers.length);
    if (state.expandedPeerId && !peers.some((peer) => peer.id === state.expandedPeerId)) {
      state.expandedPeerId = undefined;
    }
    stdout.write("\x1b[?25l");
    stdout.write("\x1b[H\x1b[2J");
    stdout.write(render(peers, state));
  }

  const interval = setInterval(draw, 1000);
  draw();

  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      const key = String(chunk);
      if (key === "\u0003" || (!state.killMode && key === "q")) {
        cleanup(interval);
        process.exit(0);
      }
      if (!state.killMode && key === "k") {
        state.killMode = true;
        state.input = "";
        state.message = undefined;
        draw();
        return;
      }
      if (!state.killMode && key === "r") {
        draw();
        return;
      }
      if (!state.killMode && (key === "\x1b[B" || key === "j")) {
        state.selectedIndex = clampSelectedIndex(state.selectedIndex + 1, peers.length);
        draw();
        return;
      }
      if (!state.killMode && key === "\x1b[A") {
        state.selectedIndex = clampSelectedIndex(state.selectedIndex - 1, peers.length);
        draw();
        return;
      }
      if (!state.killMode && (key === "\r" || key === "\n")) {
        const selected = peers[state.selectedIndex];
        state.expandedPeerId = selected && state.expandedPeerId !== selected.id ? selected.id : undefined;
        draw();
        return;
      }
      if (state.killMode) {
        handleKillInput(key, state, () => peers, draw);
      }
    });
  }

  process.on("SIGINT", () => {
    cleanup(interval);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup(interval);
    process.exit(0);
  });
}

export function printTmuxStatus(): void {
  console.log(tmuxStatusLine());
}

function render(peers: PeerRecord[], state: DashboardState): string {
  const width = stdout.columns || 120;
  const height = stdout.rows || 40;
  const rows: string[] = [];
  const counts = countByDashboardStatus(peers);
  const worktrees = analyzeWorktrees(peers);
  rows.push(`${c("bold")}Codex Peers Dashboard${c("reset")} ${c("dim")}${new Date().toLocaleString()}${c("reset")}`);
  rows.push(
    [
      badge("working", (counts.starting || 0) + (counts.working || 0)),
      badge("waiting", counts.waiting || 0),
      badge("done", counts.done || 0),
      badge("cleanup", counts.cleanup || 0),
      badge("failed", counts.failed || 0),
      badge("frozen", counts.frozen || 0),
      badge("killed", counts.killed || 0),
    ].join("  "),
  );
  for (const warning of worktrees.warnings) {
    rows.push(`${c("yellow")}${warning}${c("reset")}`);
  }
  rows.push("");
  rows.push(fit(" #  ID        STATUS    REPO                              BRANCH      WT       PID       ELAPSED  LAST EVENT", width));
  rows.push(c("gray") + "─".repeat(Math.min(width, 140)) + c("reset"));

  const maxPeerRows = Math.max(0, height - 10);
  let usedPeerRows = 0;
  let renderedPeers = 0;
  peers.forEach((peer, index) => {
    if (usedPeerRows >= maxPeerRows) {
      return;
    }
    const isExpanded = state.expandedPeerId === peer.id;
    rows.push(renderPeerRow(peer, index + 1, width, worktrees.risks.get(peer.id), index === state.selectedIndex, isExpanded));
    usedPeerRows += 1;
    renderedPeers += 1;
    if (isExpanded && usedPeerRows < maxPeerRows) {
      const detailRows = renderExpandedPeer(peer, width, maxPeerRows - usedPeerRows);
      rows.push(...detailRows);
      usedPeerRows += detailRows.length;
    }
  });
  if (peers.length > renderedPeers) {
    rows.push(c("dim") + `... ${peers.length - renderedPeers} more peers hidden by terminal height` + c("reset"));
  }

  rows.push("");
  if (state.killMode) {
    rows.push(`${c("yellow")}Kill peer number/id:${c("reset")} ${state.input || c("dim") + "<type index or id prefix>" + c("reset")}  ${c("dim")}Enter kill, Esc cancel${c("reset")}`);
  } else {
    rows.push(`${c("dim")}Keys: ↑/↓/j select  Enter expand  k kill  r refresh  q quit | CLI: codex-peers kill <id>${c("reset")}`);
  }
  if (state.message) {
    rows.push(state.message);
  }
  return `${rows.join("\n")}\n`;
}

function renderPeerRow(
  peer: PeerRecord,
  index: number,
  width: number,
  risk?: WorktreeRisk,
  selected = false,
  expanded = false,
): string {
  const repo = truncateMiddle(projectLabel(peer), 32);
  const branch = truncate(peer.baseBranch || peer.branch || "-", 10);
  const status = dashboardStatus(peer);
  const worktree = worktreeLabel(peer, risk);
  const pid = String(peer.codexPid || peer.runnerPid || "-").padEnd(9);
  const elapsed = duration(peer.startedAt, peer.finishedAt).padEnd(8);
  const event = truncate(peer.question || peer.lastEvent || "-", Math.max(12, width - 108));
  const marker = selected ? ">" : " ";
  const expander = expanded ? "v" : " ";
  return fit(
    [
      `${marker}${String(index).padStart(2)}${expander}`,
      peer.id.padEnd(8),
      colorStatus(status).padEnd(18),
      repo.padEnd(33),
      branch.padEnd(11),
      worktree.padEnd(8),
      pid,
      elapsed,
      event,
    ].join("  "),
    width,
  );
}

function renderExpandedPeer(peer: PeerRecord, width: number, maxRows: number): string[] {
  if (maxRows <= 0) {
    return [];
  }
  const rows: string[] = [];
  const details = [
    `project: ${projectLabel(peer)}`,
    `source: ${peer.sourceRepo || "-"}`,
    `worktree: ${peer.worktreePath || peer.repo}`,
    `base: ${peer.baseRef || peer.baseBranch || "-"}  peer branch: ${peer.worktreeBranch || peer.branch || "-"}`,
    `task: ${peer.task || "-"}`,
    `integration: ${peer.integrationStatus || "pending"}${peer.integrationError ? ` (${peer.integrationError})` : ""}`,
    `log: ${peer.logPath}`,
  ];
  if (peer.question) {
    details.push(`question: ${peer.question}`);
  }
  details.push(`last event: ${peer.lastEvent || "-"}`);

  for (const detail of details) {
    if (rows.length >= maxRows) {
      return rows;
    }
    rows.push(detailLine(detail, width));
  }

  const logTail = safeLogTail(peer.id, Math.max(0, Math.min(10, maxRows - rows.length - 1)));
  if (logTail.length > 0 && rows.length < maxRows) {
    rows.push(detailLine("recent log:", width));
    for (const line of logTail) {
      if (rows.length >= maxRows) {
        break;
      }
      rows.push(detailLine(`  ${line}`, width));
    }
  }
  return rows;
}

function detailLine(text: string, width: number): string {
  return `${c("dim")}     ${fit(text, Math.max(0, width - 5))}${c("reset")}`;
}

function safeLogTail(peerId: string, lines: number): string[] {
  if (lines <= 0) {
    return [];
  }
  try {
    return readPeerLog(peerId, lines)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-lines);
  } catch {
    return [];
  }
}

function dashboardPeers(peers: PeerRecord[]): PeerRecord[] {
  return [...peers].sort((a, b) => statusRank(a) - statusRank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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

type WorktreeRisk = "shared-checkout" | "shared-branch";

type WorktreeAnalysis = {
  risks: Map<string, WorktreeRisk>;
  warnings: string[];
};

function analyzeWorktrees(peers: PeerRecord[]): WorktreeAnalysis {
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
    return `${c("red")}shared${c("reset")}`;
  }
  if (risk === "shared-branch") {
    return `${c("yellow")}branch${c("reset")}`;
  }
  if (peer.isLinkedWorktree === true) {
    return `${c("green")}linked${c("reset")}`;
  }
  if (peer.gitCommonDir) {
    return `${c("cyan")}main${c("reset")}`;
  }
  return `${c("dim")}unknown${c("reset")}`;
}

function handleKillInput(
  key: string,
  state: DashboardState,
  getPeers: () => PeerRecord[],
  draw: () => void,
): void {
  if (key === "\x1b") {
    state.killMode = false;
    state.input = "";
    draw();
    return;
  }
  if (key === "\r" || key === "\n") {
    const target = resolveInput(state.input, getPeers());
    if (!target) {
      state.message = `${c("red")}No matching peer for "${state.input}".${c("reset")}`;
    } else {
      const killed = killPeer(target.id);
      state.message = `${c("yellow")}Killed ${killed.id} (${basename(killed.repo)}).${c("reset")}`;
    }
    state.killMode = false;
    state.input = "";
    draw();
    return;
  }
  if (key === "\x7f") {
    state.input = state.input.slice(0, -1);
    draw();
    return;
  }
  if (/^[a-zA-Z0-9_-]$/.test(key)) {
    state.input += key;
    draw();
  }
}

function resolveInput(input: string, peers: PeerRecord[]): PeerRecord | undefined {
  const trimmed = input.trim();
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= peers.length) {
    return peers[index - 1];
  }
  return peers.find((peer) => peer.id === trimmed || peer.id.startsWith(trimmed));
}

function countByDashboardStatus(peers: PeerRecord[]): Record<DashboardStatus, number> {
  return peers.reduce((acc, peer) => {
    const status = dashboardStatus(peer);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {} as Record<DashboardStatus, number>);
}

function badge(label: DashboardStatus, count: number): string {
  return `${statusColor(label)}${label} ${count}${c("reset")}`;
}

function colorStatus(status: DashboardStatus): string {
  return `${statusColor(status)}${status}${c("reset")}`;
}

function statusColor(status: DashboardStatus): string {
  switch (status) {
    case "cleanup":
      return c("magenta");
    case "done":
    case "idle":
      return c("green");
    case "starting":
    case "working":
      return c("cyan");
    case "waiting":
      return c("yellow");
    case "failed":
    case "frozen":
    case "killed":
      return c("red");
    default:
      return c("reset");
  }
}

function dashboardStatus(peer: PeerRecord): DashboardStatus {
  if (peer.status === "done" && peer.integrationStatus === "pushed") {
    return "cleanup";
  }
  return peer.status;
}

function duration(start: string, end?: string): string {
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
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

function clampSelectedIndex(index: number, peerCount: number): number {
  if (peerCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), peerCount - 1);
}

function truncate(text: string, max: number): string {
  if (stripAnsi(text).length <= max) {
    return text;
  }
  return `${stripAnsi(text).slice(0, Math.max(0, max - 1))}…`;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - (max - half - 1))}`;
}

function fit(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length <= width) {
    return text;
  }
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function c(name: keyof typeof COLORS): string {
  return COLORS[name];
}

function cleanup(interval: NodeJS.Timeout): void {
  clearInterval(interval);
  stdout.write("\x1b[?25h\x1b[0m\n");
  if (stdin.isTTY) {
    stdin.setRawMode(false);
  }
}
