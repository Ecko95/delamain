import type { PeerRecord, PeerStatus } from "../types.js";
import type { CodexUsage } from "../codexUsage.js";
import type { CodexContextLevel } from "../codexContext.js";
import { formatLogEvent, parseLogChunk, type LogEvent } from "./logEvents.js";
import { defaultTheme, type Theme } from "./theme.js";

export type DashboardStatus = PeerStatus | "cleanup";
export type WorktreeRisk = "shared-checkout" | "shared-branch";
export type DashboardMode = "normal" | "kill-confirm" | "answer" | "help";
export type DashboardFocusPane = "peers" | "details" | "logs" | "status";
export type FleetStage = "spawn" | "work" | "wait" | "integrate" | "done";

export type DashboardState = {
  selectedIndex?: number;
  selectedPeerId?: string;
  expandedPeerId?: string;
  peerOffset?: number;
  collapsedStatuses?: Partial<Record<DashboardStatus, boolean>>;
  focusPane?: DashboardFocusPane;
  mode?: DashboardMode;
  message?: string;
  logOffset?: number;
};

export type DashboardPeerRow = {
  id: string;
  index: number;
  status: DashboardStatus;
  activity: string;
  project: string;
  branch: string;
  worktree: string;
  pid: string;
  elapsed: string;
  lastEvent: string;
  risk?: WorktreeRisk;
  selected: boolean;
  expanded: boolean;
  contextPercent?: number;
  contextLevel?: CodexContextLevel;
  compacted?: boolean;
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
  codexUsage?: CodexUsage;
  warnings: string[];
  details: DashboardDetailRow[];
  logLines: string[];
  logEvents: LogEvent[];
  logOffset: number;
  peerOffset: number;
  collapsedStatuses: Partial<Record<DashboardStatus, boolean>>;
  message: string;
  focusPane: DashboardFocusPane;
  mode: DashboardMode;
};

export type DashboardViewModelOptions = {
  now?: Date;
  logLimit?: number;
  logProvider?: (peerId: string, lines: number) => string;
  logEventsProvider?: (peerId: string, events: number) => LogEvent[];
  diffStatProvider?: (peerId: string, repo: string, baseRef: string) => string | undefined;
  codexUsageProvider?: () => CodexUsage | undefined;
};

const LOG_LIMIT = 80;
const FORMATTED_LOG_LIMIT = 220;
const LOG_EVENT_LIMIT = 2000;
const FLEET_STAGES: FleetStage[] = ["spawn", "work", "wait", "integrate", "done"];
const FOCUS_PANES: DashboardFocusPane[] = ["peers", "details", "logs", "status"];
const STATIC_ACTIVITY: Record<Exclude<DashboardStatus, "starting" | "working">, string> = {
  waiting: "WAIT",
  idle: "IDLE",
  done: "DONE",
  cleanup: "PUSH",
  failed: "FAIL",
  frozen: "STOP",
  killed: "KILL",
  // Phase 33 — short 4-char labels for the GSD state machine.
  gsd_pending: "QUED",
  gsd_running_phase: "GSDR",
  gsd_polling_state: "POLL",
  gsd_running_gate_check: "GATE",
  gsd_halted_on_gate_failure: "HALT",
  gsd_completed: "GSDC",
  gsd_failed: "GFAIL",
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
  const frame = Math.floor(now.getTime() / 120);
  const rows = peers.map((peer, index) => ({
    id: peer.id,
    index,
    status: dashboardStatus(peer),
    activity: statusActivity(dashboardStatus(peer), frame),
    project: projectLabel(peer),
    branch: valueOrDash(peer.mergeBranch || peer.baseBranch || peer.branch),
    worktree: worktreeLabel(peer, worktrees.risks.get(peer.id)),
    pid: valueOrDash(String(peer.codexPid || peer.runnerPid || "")),
    elapsed: duration(peer.startedAt, peer.finishedAt, now),
    lastEvent: valueOrDash(peer.question || peer.lastEvent),
    risk: worktrees.risks.get(peer.id),
    selected: index === selectedIndex,
    expanded: state.expandedPeerId === peer.id,
    contextPercent: peer.contextPercent,
    contextLevel: peer.contextLevel,
    compacted: peer.compacted,
  }));
  const mode = state.mode || "normal";
  const logEvents = selectedPeer ? safeLogEvents(selectedPeer.id, options) : [];
  const logLines = selectedPeer ? formatDashboardLogEvents(logEvents) : [];
  const logOffset = Math.max(0, state.logOffset || 0);
  const diffStat = selectedPeer && options.diffStatProvider
    ? options.diffStatProvider(selectedPeer.id, selectedPeer.worktreePath || selectedPeer.repo, selectedPeer.baseRef || "")
    : undefined;

  return {
    peers: rows,
    selectedPeer,
    selectedIndex,
    counts: countByDashboardStatus(peers),
    codexUsage: safeCodexUsage(options),
    warnings: worktrees.warnings,
    details: selectedPeer ? detailRows(selectedPeer, diffStat) : [],
    logLines,
    logEvents,
    logOffset,
    peerOffset: Math.max(0, state.peerOffset || 0),
    collapsedStatuses: state.collapsedStatuses || defaultCollapsedStatuses(),
    message: messageForState(state, selectedPeer, mode),
    focusPane: state.focusPane || "peers",
    mode,
  };
}

function safeCodexUsage(options: DashboardViewModelOptions): CodexUsage | undefined {
  try {
    return options.codexUsageProvider?.();
  } catch {
    return undefined;
  }
}

export function defaultCollapsedStatuses(): Partial<Record<DashboardStatus, boolean>> {
  return {
    done: true,
    killed: true,
    idle: true,
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

export function statusColor(status: DashboardStatus, theme: Theme = defaultTheme): string {
  return theme.statusColors[status];
}

export function statusActivity(status: DashboardStatus, frame = 0): string {
  if (status === "starting" || status === "working") {
    return knightRiderFrame(frame);
  }
  return STATIC_ACTIVITY[status];
}

export function formatDashboardLogLines(lines: string[]): string[] {
  return formatDashboardLogEvents(parseLogChunk(lines.join("\n")));
}

export function formatDashboardLogEvents(events: LogEvent[]): string[] {
  const formatted: string[] = [];
  for (const event of events) {
    formatted.push(...formatLogEvent(event));
  }
  return formatted.slice(-FORMATTED_LOG_LIMIT);
}

export type FleetGridCell = {
  project: string;
  stage: FleetStage;
  peers: DashboardPeerRow[];
};

export function fleetGridCells(peers: DashboardPeerRow[]): FleetGridCell[] {
  const projects = Array.from(new Set(peers.map((peer) => peer.project))).sort((a, b) => a.localeCompare(b));
  const cells: FleetGridCell[] = [];
  for (const stage of FLEET_STAGES) {
    for (const project of projects) {
      cells.push({
        project,
        stage,
        peers: peers.filter((peer) => peer.project === project && fleetStageForStatus(peer.status) === stage),
      });
    }
  }
  return cells;
}

export function fleetStageForStatus(status: DashboardStatus): FleetStage {
  if (status === "starting" || status === "gsd_pending") {
    return "spawn";
  }
  if (status === "working" || status === "gsd_running_phase" || status === "gsd_polling_state" || status === "gsd_running_gate_check") {
    return "work";
  }
  if (status === "waiting" || status === "frozen" || status === "gsd_halted_on_gate_failure") {
    return "wait";
  }
  if (status === "cleanup") {
    return "integrate";
  }
  return "done";
}

export type TriageBucket = "working" | "waiting" | "starting" | "failed" | "done";

const TRIAGE_ORDER: TriageBucket[] = ["working", "waiting", "starting", "failed", "done"];
const TRIAGE_LABELS: Record<TriageBucket, string> = {
  working: "WORKING",
  waiting: "WAITING",
  starting: "STARTING",
  failed: "FAILED",
  done: "DONE",
};

export function triageBucketForStatus(status: DashboardStatus): TriageBucket {
  if (status === "working" || status === "gsd_running_phase" || status === "gsd_polling_state" || status === "gsd_running_gate_check") {
    return "working";
  }
  if (status === "waiting") {
    return "waiting";
  }
  if (status === "starting") {
    return "starting";
  }
  if (status === "failed" || status === "frozen" || status === "gsd_halted_on_gate_failure" || status === "gsd_failed" || status === "killed") {
    return "failed";
  }
  return "done";
}

export function triageGroups(rows: DashboardPeerRow[]): Array<{ bucket: TriageBucket; label: string; peers: DashboardPeerRow[] }> {
  return TRIAGE_ORDER.map((bucket) => ({
    bucket,
    label: TRIAGE_LABELS[bucket],
    peers: rows.filter((row) => triageBucketForStatus(row.status) === bucket),
  }));
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
  if (mode === "answer" && selected) {
    return `Reply to ${selected.id}: enter sends, escape cancels`;
  }
  if (mode === "answer") {
    return "Reply: no peer selected - escape cancels";
  }
  return state.message || "Ready";
}

function safeLogEvents(peerId: string, options: DashboardViewModelOptions): LogEvent[] {
  if (options.logEventsProvider) {
    try {
      return options.logEventsProvider(peerId, LOG_EVENT_LIMIT).slice(-LOG_EVENT_LIMIT);
    } catch {
      return [];
    }
  }
  return parseLogChunk(safeLogTail(peerId, options).join("\n")).slice(-LOG_EVENT_LIMIT);
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

function formatDashboardLogLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("[delamain]")) {
    return [`🧭 ${trimmed}`];
  }
  if (trimmed.startsWith("[stderr]")) {
    return [`⚠️ ${trimmed}`];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [`│ ${trimmed}`];
  }
  if (!isRecord(parsed)) {
    return [`◇ ${JSON.stringify(parsed)}`];
  }

  const type = stringValue(parsed.type);
  const item = isRecord(parsed.item) ? parsed.item : undefined;
  const itemType = stringValue(item?.type);
  const event = itemType ? `${type || "event"}/${itemType}` : type || "json";
  const icon = logIcon(type, itemType);
  const id = stringValue(item?.id);
  const lines = [`${icon} ${event}${id ? ` ${id}` : ""}`];

  const text = compact(stringValue(item?.text) || stringValue(parsed.text), 240);
  if (text) {
    lines.push(`  text: ${text}`);
  }

  const command = stringValue(item?.command);
  if (command) {
    lines.push(`  command: ${compact(command, 220)}`);
  }

  const status = stringValue(item?.status);
  const exitCode = item?.exit_code;
  if (status || exitCode !== undefined) {
    lines.push(`  result: ${[status, exitCode !== undefined ? `exit=${String(exitCode)}` : undefined].filter(Boolean).join(" ")}`);
  }

  const output = stringValue(item?.aggregated_output);
  if (output) {
    lines.push(...formatOutputBlock(output));
  }

  const extra = compactJsonWithout(parsed, new Set(["type", "item", "thread_id"]));
  if (extra) {
    lines.push(`  json: ${extra}`);
  }
  return lines;
}

function formatOutputBlock(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }
  const lines = ["  output:"];
  const pretty = prettyJson(trimmed);
  const source = pretty || trimmed;
  for (const line of source.split(/\r?\n/).slice(0, 18)) {
    lines.push(`    ${compact(line, 180)}`);
  }
  if (source.split(/\r?\n/).length > 18) {
    lines.push("    ...");
  }
  return lines;
}

function prettyJson(value: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return undefined;
  }
}

function compactJsonWithout(record: Record<string, unknown>, omitted: Set<string>): string | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!omitted.has(key)) {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? compact(JSON.stringify(extra), 240) : undefined;
}

function logIcon(type?: string, itemType?: string): string {
  if (type === "thread.started") {
    return "🧵";
  }
  if (type === "turn.started") {
    return "▶️";
  }
  if (type === "turn.completed") {
    return "✅";
  }
  if (itemType === "agent_message") {
    return "💬";
  }
  if (itemType === "command_execution") {
    return "🔨";
  }
  if (itemType === "file_change") {
    return "📝";
  }
  return "◇";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compact(text: string | undefined, max: number): string | undefined {
  if (!text) {
    return undefined;
  }
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function knightRiderFrame(frame: number): string {
  const width = 8;
  const lead = knightRiderPosition(frame, width);
  let result = "";
  for (let index = 0; index < width; index += 1) {
    result += index === lead ? "■" : "⬝";
  }
  return result;
}

function knightRiderPosition(frame: number, width: number): number {
  const distance = width - 1;
  const cycle = distance * 2;
  const position = Math.abs(frame) % cycle;
  return position <= distance ? position : cycle - position;
}

function detailRows(peer: PeerRecord, diffStat?: string): DashboardDetailRow[] {
  const rows: DashboardDetailRow[] = [
    { label: "id", value: peer.id },
    { label: "status", value: dashboardStatus(peer) },
    { label: "model", value: modelWithEffort(peer.model) },
    { label: "project", value: projectLabel(peer) },
    { label: "source", value: valueOrDash(peer.sourceRepo) },
    { label: "worktree", value: valueOrDash(peer.worktreePath || peer.repo) },
    { label: "base", value: valueOrDash(peer.baseRef || peer.baseBranch) },
    { label: "merge target", value: peer.mergeBranch ? `origin/${peer.mergeBranch}` : "-" },
    { label: "peer branch", value: valueOrDash(peer.worktreeBranch || peer.branch) },
    { label: "task", value: valueOrDash(peer.task) },
    { label: "integration", value: integrationLabel(peer) },
    { label: "diff", value: diffStat ?? "-" },
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

function modelWithEffort(model?: string): string {
  const m = model || "default";
  const effort = model && model !== "gpt-5.5" ? "high" : "default";
  return `${m}  effort:${effort}`;
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
