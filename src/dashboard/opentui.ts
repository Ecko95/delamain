import { Box, Text, StyledText, createCliRenderer, fg as textColor, dim as dimText, stringToStyledText, type TextChunk } from "@opentui/core";
import { killPeer, listPeers, readPeerLog } from "../peerManager.js";
import { worktreeDiffStat } from "../git.js";
import { readCodexUsage, type CodexUsageLimit, type CodexUsageLevel } from "../codexUsage.js";
import { commandForKey, type DashboardCommand } from "./keybindings.js";
import {
  createDashboardViewModel,
  defaultCollapsedStatuses,
  nextFocusPane,
  statusColor,
  truncate,
  type DashboardPeerRow,
  type DashboardState,
  type DashboardStatus,
  type DashboardViewModel,
} from "./model.js";

type RuntimeState = Required<Pick<DashboardState, "selectedIndex" | "focusPane" | "mode" | "logOffset">> &
  Omit<DashboardState, "selectedIndex" | "focusPane" | "mode" | "logOffset"> & {
    peerOffset: number;
    collapsedStatuses: Partial<Record<DashboardStatus, boolean>>;
    selectedStatus?: DashboardStatus;
    followSelectedPeer: boolean;
    forceLogRefresh: boolean;
  };

const STATUS_ORDER = ["working", "waiting", "cleanup", "done", "failed", "frozen", "killed", "idle"] as const;
const PEER_REFRESH_MS = 1000;
const LOG_REFRESH_MS = 1500;
const DIFF_REFRESH_MS = 5000;
const USAGE_REFRESH_MS = 15000;

export async function runOpenTuiDashboard(): Promise<void> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    targetFps: 30,
    consoleMode: "disabled",
  });

  const state: RuntimeState = {
    selectedIndex: 0,
    focusPane: "peers",
    mode: "normal",
    logOffset: 0,
    peerOffset: 0,
    collapsedStatuses: defaultCollapsedStatuses(),
    followSelectedPeer: true,
    forceLogRefresh: false,
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  let cachedPeers = listPeers();
  let lastPeerRefresh = 0;
  let cachedLogPeerId: string | undefined;
  let cachedLogText = "";
  let lastLogRefresh = 0;
  let cachedDiffPeerId: string | undefined;
  let cachedDiffText: string | undefined;
  let lastDiffRefresh = 0;
  let cachedUsage = readCodexUsage();
  let lastUsageRefresh = 0;

  const refresh = (): void => {
    const currentTime = Date.now();
    if (currentTime - lastPeerRefresh >= PEER_REFRESH_MS) {
      cachedPeers = listPeers();
      lastPeerRefresh = currentTime;
    }
    const peers = cachedPeers;
    const view = createDashboardViewModel(peers, state, {
      logLimit: 80,
      logProvider: (peerId, lines) => {
        const peerChanged = cachedLogPeerId !== peerId;
        const shouldRefresh = state.forceLogRefresh
          || peerChanged
          || (state.logOffset === 0 && currentTime - lastLogRefresh >= LOG_REFRESH_MS);
        if (shouldRefresh) {
          cachedLogPeerId = peerId;
          cachedLogText = readPeerLog(peerId, lines);
          lastLogRefresh = currentTime;
          state.forceLogRefresh = false;
        }
        return cachedLogText;
      },
      diffStatProvider: (peerId, repo, baseRef) => {
        const peerChanged = cachedDiffPeerId !== peerId;
        const shouldRefresh = peerChanged || currentTime - lastDiffRefresh >= DIFF_REFRESH_MS;
        if (shouldRefresh && repo && baseRef) {
          cachedDiffPeerId = peerId;
          lastDiffRefresh = currentTime;
          try {
            const stat = worktreeDiffStat(repo, baseRef);
            cachedDiffText = stat
              ? `${stat.filesChanged} files  +${stat.insertions} -${stat.deletions}`
              : undefined;
          } catch {
            cachedDiffText = undefined;
          }
        }
        return cachedDiffText;
      },
      codexUsageProvider: () => {
        if (currentTime - lastUsageRefresh >= USAGE_REFRESH_MS) {
          cachedUsage = readCodexUsage();
          lastUsageRefresh = currentTime;
        }
        return cachedUsage;
      },
    });
    state.selectedIndex = view.selectedIndex;
    state.selectedPeerId = view.selectedPeer?.id;
    if (state.expandedPeerId && !peers.some((peer) => peer.id === state.expandedPeerId)) {
      state.expandedPeerId = undefined;
    }
    render(renderer, view, state);
  };

  const cleanup = (): void => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (interval) {
      clearInterval(interval);
    }
    renderer.destroy();
  };

  const quit = (): void => {
    cleanup();
    process.exit(0);
  };

  renderer.addInputHandler((sequence) => {
    const command = commandForKey(sequence, state.mode, state.focusPane);
    handleCommand(command, state, refresh, quit);
    return command !== "noop";
  });
  renderer.on("resize", () => refresh());
  process.once("SIGINT", quit);
  process.once("SIGTERM", quit);

  try {
    refresh();
    if (process.env.CODEX_PEERS_DASHBOARD_SMOKE === "1") {
      await renderer.idle();
      cleanup();
      return;
    }
    interval = setInterval(refresh, 120);
    await new Promise<void>(() => {});
  } finally {
    cleanup();
  }
}

function handleCommand(command: DashboardCommand, state: RuntimeState, refresh: () => void, quit: () => void): void {
  switch (command) {
    case "quit":
      quit();
      return;
    case "focus-next":
      state.focusPane = nextFocusPane(state.focusPane, 1);
      state.message = `Focus: ${state.focusPane}`;
      break;
    case "focus-prev":
      state.focusPane = nextFocusPane(state.focusPane, -1);
      state.message = `Focus: ${state.focusPane}`;
      break;
    case "select-next":
      state.selectedIndex += 1;
      state.selectedPeerId = undefined;
      state.logOffset = 0;
      state.followSelectedPeer = true;
      break;
    case "select-prev":
      state.selectedIndex -= 1;
      state.selectedPeerId = undefined;
      state.logOffset = 0;
      state.followSelectedPeer = true;
      break;
    case "toggle-details":
      state.expandedPeerId = state.expandedPeerId === state.selectedPeerId ? undefined : state.selectedPeerId;
      break;
    case "scroll-log-down":
      state.logOffset = Math.max(0, state.logOffset - 1);
      if (state.logOffset === 0) {
        state.forceLogRefresh = true;
      }
      break;
    case "scroll-log-up":
      state.logOffset += 1;
      break;
    case "page-log-down":
      if (state.focusPane === "peers") {
        state.peerOffset += 10;
        state.followSelectedPeer = false;
      } else {
        state.logOffset = Math.max(0, state.logOffset - 10);
        if (state.logOffset === 0) {
          state.forceLogRefresh = true;
        }
      }
      break;
    case "page-log-up":
      if (state.focusPane === "peers") {
        state.peerOffset = Math.max(0, state.peerOffset - 10);
        state.followSelectedPeer = false;
      } else {
        state.logOffset += 10;
      }
      break;
    case "jump-top":
      if (state.focusPane === "peers") {
        state.peerOffset = 0;
        state.followSelectedPeer = false;
      } else {
        state.logOffset = Number.MAX_SAFE_INTEGER;
      }
      break;
    case "jump-bottom":
      if (state.focusPane === "peers") {
        state.peerOffset = Number.MAX_SAFE_INTEGER;
        state.followSelectedPeer = false;
      } else {
        state.logOffset = 0;
        state.forceLogRefresh = true;
      }
      break;
    case "log-bottom":
      state.logOffset = 0;
      state.forceLogRefresh = true;
      state.message = "Logs: latest";
      break;
    case "toggle-status-group":
      toggleSelectedStatusGroup(state);
      break;
    case "refresh":
      state.forceLogRefresh = true;
      state.message = "Refreshed";
      break;
    case "enter-kill-mode":
      state.mode = "kill-confirm";
      break;
    case "confirm-kill":
      confirmKill(state);
      break;
    case "cancel-mode":
      state.mode = "normal";
      state.message = "Cancelled";
      break;
    case "noop":
      return;
  }
  refresh();
}

function confirmKill(state: RuntimeState): void {
  if (!state.selectedPeerId) {
    state.message = "No peer selected";
    state.mode = "normal";
    return;
  }
  try {
    const killed = killPeer(state.selectedPeerId);
    state.message = `Killed ${killed.id}`;
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
  }
  state.mode = "normal";
}

function toggleSelectedStatusGroup(state: RuntimeState): void {
  if (!state.selectedStatus) {
    state.message = "No selected status group";
    return;
  }
  const next = !state.collapsedStatuses[state.selectedStatus];
  state.collapsedStatuses = {
    ...state.collapsedStatuses,
    [state.selectedStatus]: next,
  };
  state.peerOffset = 0;
  state.message = `${next ? "Collapsed" : "Expanded"} ${state.selectedStatus}`;
}

function render(renderer: Awaited<ReturnType<typeof createCliRenderer>>, view: DashboardViewModel, state: RuntimeState): void {
  for (const child of renderer.root.getChildren()) {
    child.destroyRecursively();
  }

  const narrow = renderer.width < 100;
  renderer.root.add(
    Box(
      {
        id: "dashboard-root",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        gap: narrow ? 0 : 1,
      },
      statusPane(view),
      Box(
        {
          id: "dashboard-middle",
          width: "100%",
          flexGrow: 1,
          flexDirection: narrow ? "column" : "row",
          gap: 1,
        },
        peerPane(view, state, narrow, renderer.width, renderer.height),
        Box(
          {
            id: "dashboard-right",
            flexGrow: 1,
            flexDirection: "column",
            gap: narrow ? 0 : 1,
            minHeight: narrow ? 9 : 0,
          },
          detailsPane(view, narrow),
          logsPane(view, state, narrow, renderer.height),
        ),
      ),
      keysPane(view),
    ),
  );
  renderer.requestRender();
}

function statusPane(view: DashboardViewModel) {
  const chunks: TextChunk[] = [];
  STATUS_ORDER.forEach((status, index) => {
    if (index > 0) {
      chunks.push(...plainChunks("  "));
    }
    chunks.push(textColor(statusColor(status))(`${status} ${view.counts[status] || 0}`));
  });
  if (view.warnings.length > 0) {
    chunks.push(textColor("#f59e0b")(`  ${view.warnings.join(" | ")}`));
  }
  const usage = usageStatusChunks(view);
  if (usage.length > 0) {
    chunks.push(...plainChunks("  "));
    chunks.push(...usage);
  }
  return Box(
    paneProps("Status", view.focusPane === "status", { height: 3 }),
    Text({ content: truncateStyled(chunks, 180) }),
  );
}

function usageStatusChunks(view: DashboardViewModel): TextChunk[] {
  if (!view.codexUsage || view.codexUsage.limits.length === 0) {
    return [];
  }
  const chunks: TextChunk[] = [dimText("limits ")];
  view.codexUsage.limits.forEach((limit, index) => {
    if (index > 0) {
      chunks.push(dimText(" | "));
    }
    chunks.push(...usageLimitChunks(limit));
  });
  return chunks;
}

function usageLimitChunks(limit: CodexUsageLimit): TextChunk[] {
  const prefix = limit.level === "skull" ? "💀 " : "";
  const text = `${prefix}${limit.label} ${limit.remainingPercent}% left`;
  return [textColor(usageLevelColor(limit.level))(text)];
}

function usageLevelColor(level: CodexUsageLevel): string {
  switch (level) {
    case "green":
      return "#34d399";
    case "yellow":
      return "#facc15";
    case "red":
    case "skull":
      return "#f87171";
  }
}

function peerPane(view: DashboardViewModel, state: RuntimeState, narrow: boolean, screenWidth: number, screenHeight: number) {
  const paneWidth = narrow ? screenWidth : Math.min(Math.max(62, Math.floor(screenWidth * 0.46)), 86);
  const visibleRows = narrow ? 5 : Math.max(6, screenHeight - 9);
  const content = peerContent(view, state, paneWidth, visibleRows);
  return Box(
    paneProps(`Peers ${content.position}`, view.focusPane === "peers", {
      width: narrow ? "100%" : paneWidth,
      height: narrow ? 8 : "100%",
      flexShrink: 0,
    }),
    Text({ content: content.rows }),
  );
}

function detailsPane(view: DashboardViewModel, narrow: boolean) {
  return Box(
    paneProps("Details", view.focusPane === "details", {
      height: narrow ? 6 : 12,
      flexShrink: 0,
    }),
    Text({ content: detailsContent(view, narrow) }),
  );
}

function logsPane(view: DashboardViewModel, state: RuntimeState, narrow: boolean, screenHeight: number) {
  const visibleRows = narrow ? Math.max(3, screenHeight - 20) : Math.max(6, screenHeight - 24);
  const content = visibleLogContent(view.logLines, state.logOffset, visibleRows);
  state.logOffset = content.offset;
  return Box(
    paneProps(`Logs ${content.position}`, view.focusPane === "logs", {
      flexGrow: 1,
      minHeight: 3,
      overflow: "hidden",
    }),
    Text({ content: content.lines.join("\n") || "No recent log lines" }),
  );
}

function keysPane(view: DashboardViewModel) {
  const modeText = view.mode === "kill-confirm"
    ? view.message
    : `${view.message} | tab focus, j/k focused, c collapse, pgup/pgdn scroll, g/G top/bottom, b latest logs, r refresh, x kill, q quit`;
  return Box(
    paneProps("Keys", false, { height: 3 }),
    Text({ content: truncate(modeText, 180) }),
  );
}

function styledText(...chunks: TextChunk[]): StyledText {
  return new StyledText(chunks);
}

function plainChunks(text: string): TextChunk[] {
  return stringToStyledText(text).chunks;
}

function truncateStyled(chunks: TextChunk[], max: number): StyledText {
  let remaining = max;
  const result: TextChunk[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) {
      break;
    }
    if (chunk.text.length <= remaining) {
      result.push(chunk);
      remaining -= chunk.text.length;
      continue;
    }
    result.push({ ...chunk, text: chunk.text.slice(0, remaining) });
    remaining = 0;
  }
  return styledText(...result);
}

function detailsContent(view: DashboardViewModel, narrow: boolean): StyledText {
  if (view.details.length === 0) {
    return styledText(dimText("No peer selected"));
  }
  const chunks: TextChunk[] = [];
  const labelWidth = view.details.reduce((width, row) => Math.max(width, row.label.length), 0);
  view.details.forEach((row, index) => {
    const value = truncate(row.value, narrow ? 96 : 120);
    chunks.push(dimText(row.label.padStart(labelWidth)));
    chunks.push(dimText("  "));
    chunks.push(...detailValueChunks(row.label, value));
    if (index < view.details.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return styledText(...chunks);
}

function detailValueChunks(label: string, value: string): TextChunk[] {
  if (label === "status") {
    return [textColor(statusColor(value as DashboardStatus))(value)];
  }
  if (label === "model") {
    const effortIdx = value.indexOf("  effort:");
    if (effortIdx !== -1) {
      return [
        textColor("#22d3ee")(value.slice(0, effortIdx)),
        dimText("  effort:"),
        textColor("#94a3b8")(value.slice(effortIdx + 9)),
      ];
    }
    return [textColor("#22d3ee")(value)];
  }
  if (label === "diff") {
    if (value === "-") {
      return [dimText(value)];
    }
    // Format: "N files  +I -D" — tokenize on runs of spaces, colour + green and - red
    const chunks: TextChunk[] = [];
    const tokens = value.split(/(\s+)/);
    for (const token of tokens) {
      if (token.startsWith("+")) {
        chunks.push(textColor("#34d399")(token));
      } else if (token.startsWith("-")) {
        chunks.push(textColor("#f87171")(token));
      } else {
        chunks.push(...plainChunks(token));
      }
    }
    return chunks;
  }
  if (label === "question") {
    return [textColor("#facc15")(value)];
  }
  if (label === "integration") {
    return [textColor(value.startsWith("failed") ? "#f87171" : "#34d399")(value)];
  }
  return plainChunks(value);
}

type PeerDisplayLine = {
  kind: "group" | "peer";
  status: DashboardStatus;
  peer?: DashboardPeerRow;
  text?: string;
};

function peerContent(view: DashboardViewModel, state: RuntimeState, paneWidth: number, visibleRows: number): { rows: StyledText; position: string } {
  const lines = peerDisplayLines(view);
  const selectedLine = lines.findIndex((line) => line.peer?.selected);
  const maxOffset = Math.max(0, lines.length - visibleRows);
  let offset = clamp(state.peerOffset, 0, maxOffset);
  if (state.followSelectedPeer && selectedLine !== -1 && !view.collapsedStatuses[lines[selectedLine].status]) {
    if (selectedLine < offset) {
      offset = selectedLine;
    } else if (selectedLine >= offset + visibleRows) {
      offset = selectedLine - visibleRows + 1;
    }
  }
  state.peerOffset = offset;
  state.selectedStatus = view.selectedPeer ? view.peers.find((peer) => peer.id === view.selectedPeer?.id)?.status : undefined;

  const visible = lines.slice(offset, offset + visibleRows);
  const chunks: TextChunk[] = [];
  visible.forEach((line, index) => {
    chunks.push(...peerDisplayLine(line, paneWidth));
    if (index < visible.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return {
    rows: chunks.length > 0 ? styledText(...chunks) : styledText(dimText("No peers yet")),
    position: scrollPosition(offset, visibleRows, lines.length),
  };
}

function peerDisplayLines(view: DashboardViewModel): PeerDisplayLine[] {
  const lines: PeerDisplayLine[] = [];
  for (const status of STATUS_ORDER) {
    const peers = view.peers.filter((peer) => peer.status === status);
    if (peers.length === 0) {
      continue;
    }
    lines.push({ kind: "group", status, text: `${view.collapsedStatuses[status] ? "▸" : "▾"} ${status} ${peers.length}` });
    if (!view.collapsedStatuses[status]) {
      for (const peer of peers) {
        lines.push({ kind: "peer", status, peer });
      }
    }
  }
  return lines;
}

function peerDisplayLine(line: PeerDisplayLine, paneWidth: number): TextChunk[] {
  if (line.kind === "group") {
    return [textColor(statusColor(line.status))(line.text || line.status)];
  }
  return line.peer ? peerRow(line.peer, paneWidth) : [];
}

function paneProps(title: string, focused: boolean, extra: Record<string, unknown> = {}) {
  return {
    title,
    border: true,
    borderStyle: "single" as const,
    borderColor: focused ? "#ffff00" : "#777777",
    paddingX: 1,
    ...extra,
  };
}

function peerRow(peer: DashboardPeerRow, paneWidth: number): TextChunk[] {
  const contentWidth = Math.max(38, paneWidth - 4);
  const projectWidth = Math.max(18, contentWidth - 40);
  return [
    peer.selected ? textColor("#facc15")(">") : dimText(" "),
    textColor(statusColor(peer.status as DashboardStatus))(peer.activity.padEnd(8)),
    ...plainChunks(` ${String(peer.index + 1).padStart(2)} ${peer.id.padEnd(8)} ${peer.elapsed.padEnd(8)} `),
    textColor(statusColor(peer.status as DashboardStatus))(peer.status.padEnd(8)),
    ...plainChunks(` ${truncate(peer.project, projectWidth).padEnd(projectWidth)}`),
  ];
}

function visibleLogContent(lines: string[], requestedOffset: number, visibleRows: number): { lines: string[]; offset: number; position: string } {
  const maxOffset = Math.max(0, lines.length - visibleRows);
  const offset = clamp(requestedOffset, 0, maxOffset);
  const end = lines.length - offset;
  const start = Math.max(0, end - visibleRows);
  return {
    lines: lines.slice(start, end),
    offset,
    position: scrollPosition(offset, visibleRows, lines.length),
  };
}

function scrollPosition(offset: number, visibleRows: number, totalRows: number): string {
  if (totalRows <= visibleRows) {
    return `[all ${totalRows}]`;
  }
  const start = totalRows - offset - visibleRows + 1;
  const end = totalRows - offset;
  return `[${Math.max(1, start)}-${Math.max(1, end)}/${totalRows}]`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
