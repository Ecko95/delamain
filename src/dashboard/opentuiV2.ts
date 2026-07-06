import { Box, Text, StyledText, createCliRenderer, fg as textColor, dim as dimText, stringToStyledText, type TextChunk } from "@opentui/core";
import { worktreeDiffStat } from "../git.js";
import { killPeer, listPeers, resumePeer } from "../peerManager.js";
import { readCodexUsage, type CodexUsageLimit, type CodexUsageLevel } from "../codexUsage.js";
import { formatSupervisorTime, readSupervisorTelegramStatus, type SupervisorTelegramStatus } from "../supervisorStatus.js";
import type { PeerRecord } from "../types.js";
import { LogBuffer } from "./logEvents.js";
import { handleDashboardV2Input, initialThemeFromEnv, type RuntimeState, type V2Pane } from "./v2Input.js";
import {
  createDashboardViewModel,
  defaultCollapsedStatuses,
  fleetGridCells,
  statusColor,
  truncate,
  truncateMiddle,
  type DashboardPeerRow,
  type DashboardState,
  type DashboardStatus,
  type DashboardViewModel,
} from "./model.js";
import { defaultTheme, type Theme } from "./theme.js";
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
    answerInput: "",
    logOffset: 0,
    peerOffset: 0,
    collapsedStatuses: defaultCollapsedStatuses(),
    collapsedPanes: {},
    followSelectedPeer: true,
    forceLogRefresh: false,
    visiblePeers: [],
    logEventLevels: [],
    theme: initialThemeFromEnv(),
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  let cachedPeers = listPeers();
  let lastPeerRefresh = 0;
  const logBuffers = new Map<string, { path: string; buffer: LogBuffer }>();
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
      logEventsProvider: (peerId, events) => {
        const peer = cachedPeers.find((candidate) => candidate.id === peerId);
        if (!peer?.logPath) {
          return [];
        }
        let cached = logBuffers.get(peerId);
        if (!cached || cached.path !== peer.logPath) {
          cached = { path: peer.logPath, buffer: new LogBuffer(peer.logPath) };
          logBuffers.set(peerId, cached);
        }
        state.forceLogRefresh = false;
        return cached.buffer.tail(events);
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
    state.visiblePeers = view.peers;
    state.logEventLevels = view.logEvents.map((event) => event.level);
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
    mode: state.mode,
    message: state.message,
  };
}

function handleInput(sequence: string, state: RuntimeState, refresh: () => void, quit: () => void): boolean {
  return handleDashboardV2Input(sequence, state, {
    refresh,
    quit,
    killPeer,
    sendPeerReply: (peerId, text) => resumePeer({ peerId, prompt: text }),
  });
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
    textColor(state.theme.statusColors.working)(`${spinner} delamain  `),
    ...dimmedChunks("fleet ", state.theme),
    textColor(state.theme.statusColors.cleanup)(`${view.peers.length}`),
    ...dimmedChunks("  active ", state.theme),
    textColor(state.theme.statusColors.working)(`${active}`),
    ...dimmedChunks("  waiting ", state.theme),
    textColor(state.theme.statusColors.waiting)(`${waiting}`),
    ...dimmedChunks("  failed ", state.theme),
    textColor(failed > 0 ? state.theme.statusColors.failed : state.theme.textDim)(`${failed}`),
    ...dimmedChunks("  selected ", state.theme),
    textColor(state.theme.borderFocused)(view.selectedPeer?.id || "-"),
  ];
  return Box(
    paneProps("Command Deck", state.focusPane === "overview", state.theme, { height: 4 }),
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
    return fleetGrid(view, spinner, state.theme);
  });
}

function fleetGrid(view: DashboardViewModel, spinner: string, theme: Theme): StyledText {
  if (view.peers.length === 0) {
    return styledText(...dimmedChunks("No peers yet", theme));
  }
  const projects = Array.from(new Set(view.peers.map((peer) => peer.project))).sort((a, b) => a.localeCompare(b)).slice(0, 5);
  const stages = ["spawn", "work", "wait", "integrate", "done"] as const;
  const cells = fleetGridCells(view.peers);
  const colWidth = Math.max(10, Math.floor(58 / Math.max(1, projects.length)));
  const chunks: TextChunk[] = [...dimmedChunks("stage".padEnd(10), theme)];
  for (const project of projects) {
    chunks.push(...dimmedChunks(truncate(project, colWidth).padEnd(colWidth), theme));
  }
  stages.forEach((stage) => {
    chunks.push(...plainChunks("\n"));
    chunks.push(...dimmedChunks(stage.padEnd(10), theme));
    for (const project of projects) {
      const peers = cells.find((cell) => cell.stage === stage && cell.project === project)?.peers || [];
      const blips = peers.slice(0, Math.max(1, colWidth - 2));
      if (blips.length === 0) {
        chunks.push(...dimmedChunks(".".padEnd(colWidth), theme));
        continue;
      }
      for (const peer of blips) {
        const glyph = peer.selected ? "@" : peer.status === "working" || peer.status === "starting" ? spinner.slice(0, 1) : "o";
        chunks.push(textColor(peer.selected ? theme.borderFocused : statusColor(peer.status, theme))(glyph));
      }
      const overflow = peers.length > blips.length ? `+${peers.length - blips.length}` : "";
      chunks.push(...bodyChunks(overflow.padEnd(Math.max(0, colWidth - blips.length)), theme));
    }
  });
  return styledText(...chunks);
}

function limitsPane(view: DashboardViewModel, state: RuntimeState) {
  return card("2 Limits", "limits", state, { height: state.collapsedPanes.limits ? 3 : 8, flexGrow: 1 }, () => {
    if (!view.codexUsage || view.codexUsage.limits.length === 0) {
      return styledText(...dimmedChunks("Waiting for Codex rate-limit telemetry", state.theme));
    }
    const chunks: TextChunk[] = [];
    view.codexUsage.limits.forEach((limit, index) => {
      chunks.push(...limitLine(limit, 12, state.theme));
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
      return styledText(textColor(state.theme.statusColors.cleanup)("No worktree collisions"));
    }
    const chunks: TextChunk[] = [];
    view.warnings.forEach((warning, index) => {
      chunks.push(textColor(state.theme.statusColors.waiting)(truncate(warning, 88)));
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
    chunks.push(...dimmedChunks("roadmap  ", state.theme));
    chunks.push(...bodyChunks(supervisor.roadmap || "-", state.theme));
    chunks.push(...plainChunks("\n"));
    chunks.push(...dimmedChunks("slice    ", state.theme));
    chunks.push(...bodyChunks(supervisor.sliceId || "-", state.theme));
    chunks.push(...plainChunks("\n"));
    chunks.push(...dimmedChunks("branch   ", state.theme));
    chunks.push(...bodyChunks(truncateMiddle(supervisor.mergeBranch || "-", 42), state.theme));
    if (supervisor.latestLogAt) {
      chunks.push(...plainChunks("\n"));
      chunks.push(...dimmedChunks("tick     ", state.theme));
      chunks.push(...bodyChunks(formatSupervisorTime(supervisor.latestLogAt), state.theme));
    }
    if (supervisor.haltedReason) {
      chunks.push(...plainChunks("\n"));
      chunks.push(textColor(state.theme.statusColors.failed)(truncate(supervisor.haltedReason, 72)));
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
      return styledText(...dimmedChunks("No peer selected", state.theme));
    }
    return groupedDetails(view.selectedPeer, view, width, state.theme);
  });
}

function logsPane(view: DashboardViewModel, state: RuntimeState, visibleRows: number) {
  const content = visibleLogContent(view.logLines, state.logOffset, Math.max(3, visibleRows));
  state.logOffset = content.offset;
  return card(`7 Logs ${content.position}`, "logs", state, { flexGrow: 1 }, () => {
    const lines = withScrollbar(
      content.lines.length > 0 ? content.lines : ["No recent log lines"],
      content.offset,
      content.visibleRows,
      content.totalRows,
    );
    const chunks: TextChunk[] = [...plainChunks(`${logProgressLine(content.offset, content.visibleRows, content.totalRows)}\n`)];
    appendThemedLines(chunks, lines, state.theme, Math.max(24, longestLine(lines)));
    return styledText(...chunks);
  });
}

function footerPane(state: RuntimeState) {
  const text = footerText(state);
  const height = state.mode === "help" ? 9 : 3;
  return Box(
    paneProps("Keys", false, state.theme, { height }),
    Text({ content: state.mode === "help" ? text : truncate(text, 180) }),
  );
}

function footerText(state: RuntimeState): string {
  if (state.mode === "kill-confirm") {
    return state.message;
  }
  if (state.mode === "answer") {
    return `answer> ${state.answerInput}`;
  }
  if (state.mode === "help") {
    return [
      "tab/S-tab focus  1-7/c collapse  j/k move or logs scroll  h/l fleet columns  pg up/down",
      "g/G top/bottom  b latest logs  e previous error  r refresh",
      "a answer waiting peer  t cycle theme  x kill selected peer  ? close help  q quit",
      "answer mode: enter sends, escape cancels, backspace edits",
    ].join("\n");
  }
  return `${state.message} | ? help | tab focus | 1-7/c collapse | h/j/k/l | pg | b logs | e error | a answer | t theme | x kill | q`;
}

function card(title: string, pane: V2Pane, state: RuntimeState, extra: Record<string, unknown>, renderContent: () => StyledText) {
  const collapsed = state.collapsedPanes[pane];
  return Box(
    paneProps(`${collapsed ? "▸" : "▾"} ${title}`, state.focusPane === pane, state.theme, {
      minHeight: collapsed ? 3 : 5,
      ...extra,
    }),
    Text({ content: collapsed ? styledText(...dimmedChunks("collapsed", state.theme)) : renderContent() }),
  );
}

function paneProps(title: string, focused: boolean, theme: Theme, extra: Record<string, unknown> = {}) {
  return {
    title,
    border: true,
    borderStyle: "rounded" as const,
    borderColor: focused ? theme.borderFocused : theme.border,
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
  const visibleLines = lines.slice(offset, offset + visibleRows);
  visibleLines.forEach((line, index) => {
    chunks.push(...peerDisplayLine(line, paneWidth, spinner, state.theme));
    if (index < visibleLines.length - 1) {
      chunks.push(...plainChunks("\n"));
      if (state.theme.rowRule) {
        chunks.push(...rowRuleChunks(state.theme, Math.max(12, paneWidth - 4)));
        chunks.push(...plainChunks("\n"));
      }
    }
  });
  return {
    rows: chunks.length > 0 ? styledText(...chunks) : styledText(...dimmedChunks("No peers yet", state.theme)),
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

function peerDisplayLine(line: PeerDisplayLine, paneWidth: number, spinner: string, theme: Theme): TextChunk[] {
  if (line.kind === "group") {
    return [textColor(statusColor(line.status, theme))(line.text || line.status)];
  }
  if (!line.peer) {
    return [];
  }
  const peer = line.peer;
  const contentWidth = Math.max(36, paneWidth - 4);
  const projectWidth = Math.max(12, Math.min(contentWidth - 34, contentWidth >= 70 ? 24 : contentWidth - 34));
  const eventWidth = Math.max(0, contentWidth - 34 - projectWidth - 1);
  const activity = peer.status === "working" || peer.status === "starting" || peer.status === "gsd_running_phase"
    ? spinner.padEnd(4)
    : peer.activity.slice(0, 4).padEnd(4);
  const chunks: TextChunk[] = [
    ...(peer.selected ? [textColor(theme.borderFocused)("● ")] : dimmedChunks("  ", theme)),
    textColor(statusColor(peer.status, theme))(activity),
    ...bodyChunks(` ${peer.id.padEnd(8)} ${peer.elapsed.padEnd(7)} `, theme),
    textColor(statusColor(peer.status, theme))(peer.status.slice(0, 10).padEnd(10)),
    ...bodyChunks(` ${truncate(peer.project, projectWidth).padEnd(projectWidth)}`, theme),
  ];
  if (eventWidth >= 12 && peer.lastEvent !== "-") {
    chunks.push(...dimmedChunks(` ${truncate(peer.lastEvent, eventWidth)}`, theme));
  }
  return chunks;
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

function limitLine(limit: CodexUsageLimit, barWidth: number, theme: Theme): TextChunk[] {
  const remaining = limit.remainingPercent;
  const used = Math.max(0, Math.min(barWidth, Math.round((limit.usedPercent / 100) * barWidth)));
  const bar = "█".repeat(used) + "░".repeat(barWidth - used);
  const prefix = limit.level === "skull" ? "💀 " : "";
  const chunks: TextChunk[] = [
    textColor(usageLevelColor(limit.level, theme))(`${prefix}${limit.label.padEnd(6)} `),
    textColor(usageLevelColor(limit.level, theme))(`[${bar}]`),
    textColor(usageLevelColor(limit.level, theme))(` ${remaining}% left`),
  ];
  if (limit.resetAt) {
    chunks.push(...dimmedChunks(`\n       ${resetLabel(limit)}`, theme));
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

function groupedDetails(peer: PeerRecord, view: DashboardViewModel, width: number, theme: Theme): StyledText {
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
      chunks.push(textColor(theme.statusColors.working)(row.label));
    } else {
      chunks.push(...dimmedChunks(row.label.padStart(labelWidth), theme));
      chunks.push(...dimmedChunks("  ", theme));
      chunks.push(...detailValue(row.label, truncateMiddle(row.value, valueWidth), theme));
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

function detailValue(label: string, value: string, theme: Theme): TextChunk[] {
  if (label === "status") {
    return [textColor(statusColor(value as DashboardStatus, theme))(value)];
  }
  if (label === "question") {
    return [textColor(theme.statusColors.waiting)(value)];
  }
  if (label === "integration") {
    return [textColor(value.startsWith("failed") ? theme.statusColors.failed : theme.statusColors.cleanup)(value)];
  }
  if (label === "diff" && value !== "-") {
    return value.split(/(\s+)/).flatMap((token) => {
      if (token.startsWith("+")) {
        return [textColor(theme.statusColors.cleanup)(token)];
      }
      if (token.startsWith("-")) {
        return [textColor(theme.statusColors.failed)(token)];
      }
      return bodyChunks(token, theme);
    });
  }
  return bodyChunks(value, theme);
}

function usageLevelColor(level: CodexUsageLevel, theme: Theme): string {
  switch (level) {
    case "green":
      return theme.statusColors.cleanup;
    case "yellow":
      return theme.statusColors.waiting;
    case "red":
    case "skull":
      return theme.statusColors.failed;
  }
}

function styledText(...chunks: TextChunk[]): StyledText {
  return new StyledText(chunks);
}

function bodyChunks(text: string, theme: Theme): TextChunk[] {
  if (theme === defaultTheme) {
    return plainChunks(text);
  }
  return [textColor(theme.text)(text)];
}

function dimmedChunks(text: string, theme: Theme): TextChunk[] {
  if (theme === defaultTheme) {
    return [dimText(text)];
  }
  return [textColor(theme.textDim)(text)];
}

function plainChunks(text: string): TextChunk[] {
  return stringToStyledText(text).chunks;
}

function rowRuleChunks(theme: Theme, width: number): TextChunk[] {
  if (!theme.rowRule) {
    return [];
  }
  return [textColor(theme.textDim)(theme.rowRule.repeat(width))];
}

function appendThemedLines(chunks: TextChunk[], lines: string[], theme: Theme, rowRuleWidth: number): void {
  lines.forEach((line, index) => {
    chunks.push(...logLineChunks(line, theme));
    if (index < lines.length - 1) {
      chunks.push(...plainChunks("\n"));
      if (theme.rowRule) {
        chunks.push(...rowRuleChunks(theme, rowRuleWidth));
        chunks.push(...plainChunks("\n"));
      }
    }
  });
}

function logLineChunks(line: string, theme: Theme): TextChunk[] {
  if (theme === defaultTheme) {
    return plainChunks(line);
  }
  if (line.startsWith("ERR")) {
    return [textColor(theme.statusColors.failed)(line)];
  }
  if (line.startsWith("CMD")) {
    return [textColor(theme.statusColors.working)(line)];
  }
  if (line.startsWith("MSG")) {
    return [textColor(theme.statusColors.waiting)(line)];
  }
  if (line.startsWith("TURN")) {
    return [textColor(theme.statusColors.starting)(line)];
  }
  if (line.startsWith("FILE")) {
    return [textColor(theme.statusColors.cleanup)(line)];
  }
  if (/(error|failed|fatal|halted|kill(ed)?)/i.test(line)) {
    return [textColor(theme.statusColors.failed)(line)];
  }
  return [textColor(theme.text)(line)];
}

function longestLine(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, line.length), 0);
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
