import { Box, Text, StyledText, createCliRenderer, fg as textColor, dim as dimText, stringToStyledText, type TextChunk } from "@opentui/core";
import { worktreeDiffStat } from "../git.js";
import { killPeer, listPeers, readPeerLog } from "../peerManager.js";
import { readCodexUsage, type CodexUsageLimit, type CodexUsageLevel } from "../codexUsage.js";
import { formatSupervisorTime, readSupervisorTelegramStatus, type SupervisorTelegramStatus } from "../supervisorStatus.js";
import type { PeerRecord } from "../types.js";
import {
  createDashboardViewModel,
  defaultCollapsedStatuses,
  statusColor,
  truncate,
  truncateMiddle,
  type DashboardPeerRow,
  type DashboardState,
  type DashboardStatus,
  type DashboardViewModel,
} from "./model.js";

type V2Pane = "overview" | "limits" | "telegram" | "warnings" | "peers" | "details" | "logs";
type V2Mode = "normal" | "kill-confirm";

type RuntimeState = {
  selectedIndex: number;
  selectedPeerId?: string;
  focusPane: V2Pane;
  mode: V2Mode;
  message: string;
  logOffset: number;
  peerOffset: number;
  collapsedStatuses: Partial<Record<DashboardStatus, boolean>>;
  collapsedPanes: Partial<Record<V2Pane, boolean>>;
  followSelectedPeer: boolean;
  forceLogRefresh: boolean;
};

const STATUS_ORDER: DashboardStatus[] = [
  "working",
  "waiting",
  "cleanup",
  "gsd_running_phase",
  "gsd_polling_state",
  "gsd_running_gate_check",
  "failed",
  "gsd_halted_on_gate_failure",
  "frozen",
  "done",
  "gsd_completed",
  "killed",
  "idle",
  "gsd_pending",
  "gsd_failed",
];
const PANES: V2Pane[] = ["overview", "limits", "telegram", "warnings", "peers", "details", "logs"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PEER_REFRESH_MS = 1000;
const LOG_REFRESH_MS = 1500;
const DIFF_REFRESH_MS = 5000;
const USAGE_REFRESH_MS = 15000;
const SUPERVISOR_REFRESH_MS = 5000;

export async function runOpenTuiDashboardV2(): Promise<void> {
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
    message: "Ready",
    logOffset: 0,
    peerOffset: 0,
    collapsedStatuses: defaultCollapsedStatuses(),
    collapsedPanes: {},
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
  let cachedSupervisorPeerId: string | undefined;
  let cachedSupervisorStatus = readSupervisorTelegramStatus(undefined);
  let lastSupervisorRefresh = 0;

  const refresh = (): void => {
    const currentTime = Date.now();
    if (currentTime - lastPeerRefresh >= PEER_REFRESH_MS) {
      cachedPeers = listPeers();
      lastPeerRefresh = currentTime;
    }
    const view = createDashboardViewModel(cachedPeers, dashboardState(state), {
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
    const supervisorPeerChanged = cachedSupervisorPeerId !== view.selectedPeer?.id;
    if (supervisorPeerChanged || currentTime - lastSupervisorRefresh >= SUPERVISOR_REFRESH_MS) {
      cachedSupervisorPeerId = view.selectedPeer?.id;
      cachedSupervisorStatus = readSupervisorTelegramStatus(view.selectedPeer?.id);
      lastSupervisorRefresh = currentTime;
    }
    render(renderer, view, state, currentTime, cachedSupervisorStatus);
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
    const handled = handleInput(sequence, state, refresh, quit);
    return handled;
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

function dashboardState(state: RuntimeState): DashboardState {
  return {
    selectedIndex: state.selectedIndex,
    selectedPeerId: state.selectedPeerId,
    peerOffset: state.peerOffset,
    logOffset: state.logOffset,
    collapsedStatuses: state.collapsedStatuses,
    message: state.message,
  };
}

function handleInput(sequence: string, state: RuntimeState, refresh: () => void, quit: () => void): boolean {
  if (sequence === "\u0003" || (state.mode === "normal" && sequence === "q")) {
    quit();
    return true;
  }
  if (state.mode === "kill-confirm") {
    if (sequence === "\r" || sequence === "\n") {
      confirmKill(state);
      refresh();
      return true;
    }
    if (sequence === "\x1b") {
      state.mode = "normal";
      state.message = "Cancelled";
      refresh();
      return true;
    }
    return false;
  }

  if (sequence === "\t" || sequence === "\x1b[Z") {
    focusPane(state, sequence === "\t" ? 1 : -1);
  } else if (sequence === "c") {
    togglePane(state, state.focusPane);
  } else if (/^[1-7]$/.test(sequence)) {
    togglePane(state, PANES[Number(sequence) - 1]);
  } else if (sequence === "\x1b[B" || sequence === "j") {
    moveFocused(state, 1);
  } else if (sequence === "\x1b[A" || sequence === "k") {
    moveFocused(state, -1);
  } else if (sequence === "\x1b[6~") {
    pageFocused(state, 10);
  } else if (sequence === "\x1b[5~") {
    pageFocused(state, -10);
  } else if (sequence === "g") {
    jumpFocused(state, "top");
  } else if (sequence === "G") {
    jumpFocused(state, "bottom");
  } else if (sequence === "b" || sequence === "\x1b[F" || sequence === "\x1b[4~") {
    state.logOffset = 0;
    state.forceLogRefresh = true;
    state.message = "Logs: latest";
  } else if (sequence === "r") {
    state.forceLogRefresh = true;
    state.message = "Refreshed";
  } else if (sequence === "x") {
    state.mode = "kill-confirm";
    state.message = "Kill selected peer? enter confirms, escape cancels";
  } else {
    return false;
  }
  refresh();
  return true;
}

function focusPane(state: RuntimeState, direction: 1 | -1): void {
  const current = PANES.indexOf(state.focusPane);
  state.focusPane = PANES[(current + direction + PANES.length) % PANES.length];
  state.message = `Focus: ${state.focusPane}`;
}

function togglePane(state: RuntimeState, pane: V2Pane): void {
  state.collapsedPanes[pane] = !state.collapsedPanes[pane];
  state.message = `${state.collapsedPanes[pane] ? "Collapsed" : "Expanded"} ${pane}`;
}

function moveFocused(state: RuntimeState, direction: 1 | -1): void {
  if (state.focusPane === "logs") {
    scrollLogs(state, direction === -1 ? "older" : "newer", 1);
    return;
  }
  state.selectedIndex += direction;
  state.selectedPeerId = undefined;
  state.logOffset = 0;
  state.followSelectedPeer = true;
}

function pageFocused(state: RuntimeState, amount: number): void {
  if (state.focusPane === "logs") {
    scrollLogs(state, amount < 0 ? "older" : "newer", Math.abs(amount));
    return;
  }
  state.peerOffset = Math.max(0, state.peerOffset + amount);
  state.followSelectedPeer = false;
}

function scrollLogs(state: RuntimeState, direction: "older" | "newer", amount: number): void {
  state.logOffset = direction === "older"
    ? state.logOffset + amount
    : Math.max(0, state.logOffset - amount);
  if (state.logOffset === 0) {
    state.forceLogRefresh = true;
  }
}

function jumpFocused(state: RuntimeState, target: "top" | "bottom"): void {
  if (state.focusPane === "logs") {
    state.logOffset = target === "top" ? Number.MAX_SAFE_INTEGER : 0;
    state.forceLogRefresh = target === "bottom";
    return;
  }
  state.peerOffset = target === "top" ? 0 : Number.MAX_SAFE_INTEGER;
  state.followSelectedPeer = false;
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

function render(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  view: DashboardViewModel,
  state: RuntimeState,
  nowMs: number,
  supervisor: SupervisorTelegramStatus,
): void {
  for (const child of renderer.root.getChildren()) {
    child.destroyRecursively();
  }

  const spinner = SPINNER[Math.floor(nowMs / 120) % SPINNER.length];
  const narrow = renderer.width < 100;
  const medium = renderer.width >= 100 && renderer.width < 142;
  renderer.root.add(
    Box(
      {
        id: "dashboard-v2-root",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        gap: 1,
      },
      headerPane(view, state, spinner),
      narrow
        ? narrowGrid(view, state, renderer.height, spinner, supervisor)
        : medium
          ? mediumGrid(view, state, renderer.height, renderer.width, spinner, supervisor)
          : wideGrid(view, state, renderer.height, renderer.width, spinner, supervisor),
      footerPane(state),
    ),
  );
  renderer.requestRender();
}

function headerPane(view: DashboardViewModel, state: RuntimeState, spinner: string) {
  const active = (view.counts.working || 0) + (view.counts.starting || 0) + (view.counts.gsd_running_phase || 0);
  const waiting = view.counts.waiting || 0;
  const failed = (view.counts.failed || 0) + (view.counts.gsd_failed || 0);
  const chunks: TextChunk[] = [
    textColor("#22d3ee")(`${spinner} codex-peers v2  `),
    dimText("fleet "),
    textColor("#34d399")(`${view.peers.length}`),
    dimText("  active "),
    textColor("#22d3ee")(`${active}`),
    dimText("  waiting "),
    textColor("#facc15")(`${waiting}`),
    dimText("  failed "),
    textColor(failed > 0 ? "#f87171" : "#94a3b8")(`${failed}`),
    dimText("  selected "),
    textColor("#facc15")(view.selectedPeer?.id || "-"),
  ];
  return Box(
    paneProps("Command Deck", state.focusPane === "overview", { height: 4 }),
    Text({ content: styledText(...chunks) }),
  );
}

function wideGrid(
  view: DashboardViewModel,
  state: RuntimeState,
  screenHeight: number,
  screenWidth: number,
  spinner: string,
  supervisor: SupervisorTelegramStatus,
) {
  const topHeight = 8;
  const bottomHeight = Math.max(12, screenHeight - topHeight - 8);
  return Box(
    { id: "dashboard-v2-grid-wide", width: "100%", flexGrow: 1, flexDirection: "column", gap: 1 },
    Box(
      { width: "100%", height: topHeight, flexDirection: "row", gap: 1 },
      overviewPane(view, state, spinner),
      limitsPane(view, state),
      telegramPane(state, supervisor),
      warningsPane(view, state),
    ),
    Box(
      { width: "100%", height: bottomHeight, flexGrow: 1, flexDirection: "row", gap: 1 },
      peersPane(view, state, Math.max(44, Math.floor(screenWidth * 0.34)), bottomHeight - 2, spinner),
      detailsPane(view, state, Math.max(38, Math.floor(screenWidth * 0.28))),
      logsPane(view, state, bottomHeight - 2),
    ),
  );
}

function mediumGrid(
  view: DashboardViewModel,
  state: RuntimeState,
  screenHeight: number,
  screenWidth: number,
  spinner: string,
  supervisor: SupervisorTelegramStatus,
) {
  const leftWidth = Math.max(44, Math.floor(screenWidth * 0.44));
  return Box(
    { id: "dashboard-v2-grid-medium", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 },
    Box(
      { width: leftWidth, height: "100%", flexDirection: "column", gap: 1, flexShrink: 0 },
      overviewPane(view, state, spinner),
      peersPane(view, state, leftWidth, Math.max(8, screenHeight - 19), spinner),
    ),
    Box(
      { flexGrow: 1, height: "100%", flexDirection: "column", gap: 1 },
      limitsPane(view, state),
      telegramPane(state, supervisor),
      detailsPane(view, state, Math.max(42, screenWidth - leftWidth - 4)),
      warningsPane(view, state),
      logsPane(view, state, Math.max(8, screenHeight - 34)),
    ),
  );
}

function narrowGrid(
  view: DashboardViewModel,
  state: RuntimeState,
  screenHeight: number,
  spinner: string,
  supervisor: SupervisorTelegramStatus,
) {
  return Box(
    { id: "dashboard-v2-grid-narrow", width: "100%", flexGrow: 1, flexDirection: "column", gap: 1 },
    overviewPane(view, state, spinner),
    limitsPane(view, state),
    telegramPane(state, supervisor),
    peersPane(view, state, 80, 6, spinner),
    detailsPane(view, state, 80),
    warningsPane(view, state),
    logsPane(view, state, Math.max(4, screenHeight - 42)),
  );
}

function overviewPane(view: DashboardViewModel, state: RuntimeState, spinner: string) {
  return card("1 Overview", "overview", state, { height: state.collapsedPanes.overview ? 3 : 8, flexGrow: 1 }, () => {
    const chunks: TextChunk[] = [];
    STATUS_ORDER.filter((status) => view.counts[status]).slice(0, 8).forEach((status, index) => {
      if (index > 0) {
        chunks.push(...plainChunks("  "));
      }
      const label = status === "working" || status === "gsd_running_phase" ? `${spinner} ${status}` : status;
      chunks.push(textColor(statusColor(status))(`${label} ${view.counts[status]}`));
    });
    if (chunks.length === 0) {
      chunks.push(dimText("No peers yet"));
    }
    return styledText(...chunks);
  });
}

function limitsPane(view: DashboardViewModel, state: RuntimeState) {
  return card("2 Limits", "limits", state, { height: state.collapsedPanes.limits ? 3 : 8, flexGrow: 1 }, () => {
    if (!view.codexUsage || view.codexUsage.limits.length === 0) {
      return styledText(dimText("Waiting for Codex rate-limit telemetry"));
    }
    const chunks: TextChunk[] = [];
    view.codexUsage.limits.forEach((limit, index) => {
      chunks.push(...limitLine(limit, 12));
      if (index < view.codexUsage!.limits.length - 1) {
        chunks.push(...plainChunks("\n"));
      }
    });
    return styledText(...chunks);
  });
}

function warningsPane(view: DashboardViewModel, state: RuntimeState) {
  return card("4 Warnings", "warnings", state, { height: state.collapsedPanes.warnings ? 3 : 8, flexGrow: 1 }, () => {
    if (view.warnings.length === 0) {
      return styledText(textColor("#34d399")("No worktree collisions"));
    }
    const chunks: TextChunk[] = [];
    view.warnings.forEach((warning, index) => {
      chunks.push(textColor("#f59e0b")(truncate(warning, 88)));
      if (index < view.warnings.length - 1) {
        chunks.push(...plainChunks("\n"));
      }
    });
    return styledText(...chunks);
  });
}

function telegramPane(state: RuntimeState, supervisor: SupervisorTelegramStatus) {
  return card("3 Telegram", "telegram", state, { height: state.collapsedPanes.telegram ? 3 : 8, flexGrow: 1 }, () => {
    const chunks: TextChunk[] = [
      textColor(supervisorColor(supervisor.level))(`${supervisor.icon} ${truncate(supervisor.label, 72)}`),
    ];
    chunks.push(...plainChunks("\n"));
    chunks.push(dimText("roadmap  "));
    chunks.push(...plainChunks(supervisor.roadmap || "-"));
    chunks.push(...plainChunks("\n"));
    chunks.push(dimText("slice    "));
    chunks.push(...plainChunks(supervisor.sliceId || "-"));
    chunks.push(...plainChunks("\n"));
    chunks.push(dimText("branch   "));
    chunks.push(...plainChunks(truncateMiddle(supervisor.mergeBranch || "-", 42)));
    if (supervisor.latestLogAt) {
      chunks.push(...plainChunks("\n"));
      chunks.push(dimText("tick     "));
      chunks.push(...plainChunks(formatSupervisorTime(supervisor.latestLogAt)));
    }
    if (supervisor.haltedReason) {
      chunks.push(...plainChunks("\n"));
      chunks.push(textColor("#f87171")(truncate(supervisor.haltedReason, 72)));
    }
    return styledText(...chunks);
  });
}

function supervisorColor(level: SupervisorTelegramStatus["level"]): string {
  switch (level) {
    case "sent":
      return "#34d399";
    case "pending":
      return "#facc15";
    case "waiting":
      return "#f59e0b";
    case "halted":
      return "#f87171";
    case "unknown":
      return "#94a3b8";
  }
}

function peersPane(view: DashboardViewModel, state: RuntimeState, paneWidth: number, visibleRows: number, spinner: string) {
  const content = peerContent(view, state, paneWidth, Math.max(3, visibleRows), spinner);
  return card(`5 Peers ${content.position}`, "peers", state, { width: paneWidth, flexGrow: 1 }, () => {
    return content.rows;
  });
}

function detailsPane(view: DashboardViewModel, state: RuntimeState, width: number) {
  return card("6 Details", "details", state, { width, flexGrow: 1 }, () => {
    if (!view.selectedPeer || view.details.length === 0) {
      return styledText(dimText("No peer selected"));
    }
    return groupedDetails(view.selectedPeer, view, width);
  });
}

function logsPane(view: DashboardViewModel, state: RuntimeState, visibleRows: number) {
  const content = visibleLogContent(view.logLines, state.logOffset, Math.max(3, visibleRows));
  state.logOffset = content.offset;
  return card(`7 Logs ${content.position}`, "logs", state, { flexGrow: 1 }, () => {
    const lines = [
      logProgressLine(content.offset, content.visibleRows, content.totalRows),
      ...withScrollbar(content.lines.length > 0 ? content.lines : ["No recent log lines"], content.offset, content.visibleRows, content.totalRows),
    ];
    return styledText(...plainChunks(lines.join("\n")));
  });
}

function footerPane(state: RuntimeState) {
  const text = state.mode === "kill-confirm"
    ? state.message
    : `${state.message} | tab focus | 1-7/c collapse | j/k | pg | b logs | r | x kill | q`;
  return Box(
    paneProps("Keys", false, { height: 3 }),
    Text({ content: truncate(text, 180) }),
  );
}

function card(title: string, pane: V2Pane, state: RuntimeState, extra: Record<string, unknown>, renderContent: () => StyledText) {
  const collapsed = state.collapsedPanes[pane];
  return Box(
    paneProps(`${collapsed ? "▸" : "▾"} ${title}`, state.focusPane === pane, {
      minHeight: collapsed ? 3 : 5,
      ...extra,
    }),
    Text({ content: collapsed ? styledText(dimText("collapsed")) : renderContent() }),
  );
}

function paneProps(title: string, focused: boolean, extra: Record<string, unknown> = {}) {
  return {
    title,
    border: true,
    borderStyle: "rounded" as const,
    borderColor: focused ? "#facc15" : "#475569",
    paddingX: 1,
    ...extra,
  };
}

type PeerDisplayLine = {
  kind: "group" | "peer";
  status: DashboardStatus;
  peer?: DashboardPeerRow;
  text?: string;
};

function peerContent(view: DashboardViewModel, state: RuntimeState, paneWidth: number, visibleRows: number, spinner: string): { rows: StyledText; position: string } {
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

  const chunks: TextChunk[] = [];
  lines.slice(offset, offset + visibleRows).forEach((line, index) => {
    chunks.push(...peerDisplayLine(line, paneWidth, spinner));
    if (index < Math.min(visibleRows, lines.length) - 1) {
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

function peerDisplayLine(line: PeerDisplayLine, paneWidth: number, spinner: string): TextChunk[] {
  if (line.kind === "group") {
    return [textColor(statusColor(line.status))(line.text || line.status)];
  }
  if (!line.peer) {
    return [];
  }
  const peer = line.peer;
  const contentWidth = Math.max(36, paneWidth - 4);
  const projectWidth = Math.max(12, contentWidth - 34);
  const activity = peer.status === "working" || peer.status === "starting" || peer.status === "gsd_running_phase"
    ? spinner.padEnd(4)
    : peer.activity.slice(0, 4).padEnd(4);
  return [
    peer.selected ? textColor("#facc15")("● ") : dimText("  "),
    textColor(statusColor(peer.status))(activity),
    ...plainChunks(` ${peer.id.padEnd(8)} ${peer.elapsed.padEnd(7)} `),
    textColor(statusColor(peer.status))(peer.status.slice(0, 10).padEnd(10)),
    ...plainChunks(` ${truncate(peer.project, projectWidth).padEnd(projectWidth)}`),
  ];
}

function visibleLogContent(
  lines: string[],
  requestedOffset: number,
  visibleRows: number,
): { lines: string[]; offset: number; position: string; visibleRows: number; totalRows: number } {
  const maxOffset = Math.max(0, lines.length - visibleRows);
  const offset = clamp(requestedOffset, 0, maxOffset);
  const end = lines.length - offset;
  const start = Math.max(0, end - visibleRows);
  return {
    lines: lines.slice(start, end),
    offset,
    position: scrollPosition(offset, visibleRows, lines.length),
    visibleRows,
    totalRows: lines.length,
  };
}

function limitLine(limit: CodexUsageLimit, barWidth: number): TextChunk[] {
  const remaining = limit.remainingPercent;
  const used = Math.max(0, Math.min(barWidth, Math.round((limit.usedPercent / 100) * barWidth)));
  const bar = "█".repeat(used) + "░".repeat(barWidth - used);
  const prefix = limit.level === "skull" ? "💀 " : "";
  const chunks: TextChunk[] = [
    textColor(usageLevelColor(limit.level))(`${prefix}${limit.label.padEnd(6)} `),
    textColor(usageLevelColor(limit.level))(`[${bar}]`),
    textColor(usageLevelColor(limit.level))(` ${remaining}% left`),
  ];
  if (limit.resetAt) {
    chunks.push(dimText(`\n       ${resetLabel(limit)}`));
  }
  return chunks;
}

function resetLabel(limit: CodexUsageLimit): string {
  if (!limit.resetAt) {
    return "";
  }
  const date = new Date(limit.resetAt);
  if (!Number.isFinite(date.getTime())) {
    return "reset -";
  }
  const weekday = date.toLocaleDateString([], { weekday: "short" });
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return limit.label === "weekly" ? `resets ${weekday} ${time}` : `resets ${time}`;
}

function groupedDetails(peer: PeerRecord, view: DashboardViewModel, width: number): StyledText {
  const detail = (label: string) => view.details.find((row) => row.label === label)?.value || "-";
  const end = peer.finishedAt || undefined;
  const rows: Array<{ kind: "section"; label: string } | { kind: "row"; label: string; value: string }> = [
    { kind: "section", label: "Identity" },
    { kind: "row", label: "id", value: peer.id },
    { kind: "row", label: "status", value: detail("status") },
    { kind: "row", label: "model", value: detail("model") },
    { kind: "row", label: "project", value: detail("project") },
    { kind: "section", label: "Timing" },
    { kind: "row", label: "started", value: formatDateTime(peer.startedAt) },
    { kind: "row", label: "ended", value: end ? formatDateTime(end) : "running" },
    { kind: "row", label: "runtime", value: runtimeLabel(peer.startedAt, end) },
    { kind: "row", label: "updated", value: formatDateTime(peer.updatedAt) },
    { kind: "section", label: "Git" },
    { kind: "row", label: "source", value: detail("source") },
    { kind: "row", label: "worktree", value: detail("worktree") },
    { kind: "row", label: "base", value: detail("base") },
    { kind: "row", label: "target", value: detail("merge target") },
    { kind: "row", label: "branch", value: detail("peer branch") },
    { kind: "section", label: "Integration" },
    { kind: "row", label: "state", value: detail("integration") },
    { kind: "row", label: "diff", value: detail("diff") },
    { kind: "section", label: "Task" },
    { kind: "row", label: "task", value: detail("task") },
    { kind: "row", label: "question", value: detail("question") },
    { kind: "section", label: "Latest" },
    { kind: "row", label: "event", value: detail("last event") },
    { kind: "row", label: "log", value: detail("log") },
  ];
  const chunks: TextChunk[] = [];
  const labelWidth = 8;
  const valueWidth = Math.max(18, width - labelWidth - 8);
  rows.forEach((row, index) => {
    if (row.kind === "section") {
      chunks.push(textColor("#22d3ee")(row.label));
    } else {
      chunks.push(dimText(row.label.padStart(labelWidth)));
      chunks.push(dimText("  "));
      chunks.push(...detailValue(row.label, truncateMiddle(row.value, valueWidth)));
    }
    if (index < rows.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return styledText(...chunks);
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  return date.toLocaleString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function runtimeLabel(start: string, end: string | undefined): string {
  const startMs = Date.parse(start);
  const endMs = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return "-";
  }
  const totalSeconds = Math.floor((endMs - startMs) / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function logProgressLine(offset: number, visibleRows: number, totalRows: number): string {
  const width = 24;
  if (totalRows <= visibleRows || totalRows === 0) {
    return `top [${"█".repeat(width)}] bottom`;
  }
  const maxOffset = Math.max(1, totalRows - visibleRows);
  const fromTop = maxOffset - offset;
  const position = Math.round((fromTop / maxOffset) * (width - 1));
  const bar = Array.from({ length: width }, (_, index) => (index === position ? "█" : "─")).join("");
  const label = offset === maxOffset ? "top" : offset === 0 ? "bottom" : "middle";
  return `${label.padEnd(6)}[${bar}]`;
}

function withScrollbar(lines: string[], offset: number, visibleRows: number, totalRows: number): string[] {
  if (totalRows <= visibleRows || totalRows === 0) {
    return lines.map((line) => `${line} │`);
  }
  const maxOffset = Math.max(1, totalRows - visibleRows);
  const fromTop = maxOffset - offset;
  const thumb = Math.round((fromTop / maxOffset) * Math.max(0, lines.length - 1));
  return lines.map((line, index) => `${line} ${index === thumb ? "█" : "│"}`);
}

function detailValue(label: string, value: string): TextChunk[] {
  if (label === "status") {
    return [textColor(statusColor(value as DashboardStatus))(value)];
  }
  if (label === "question") {
    return [textColor("#facc15")(value)];
  }
  if (label === "integration") {
    return [textColor(value.startsWith("failed") ? "#f87171" : "#34d399")(value)];
  }
  if (label === "diff" && value !== "-") {
    return value.split(/(\s+)/).flatMap((token) => {
      if (token.startsWith("+")) {
        return [textColor("#34d399")(token)];
      }
      if (token.startsWith("-")) {
        return [textColor("#f87171")(token)];
      }
      return plainChunks(token);
    });
  }
  return plainChunks(value);
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

function styledText(...chunks: TextChunk[]): StyledText {
  return new StyledText(chunks);
}

function plainChunks(text: string): TextChunk[] {
  return stringToStyledText(text).chunks;
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
