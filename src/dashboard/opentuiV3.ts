import {
  Box,
  Text,
  StyledText,
  createCliRenderer,
  fg as textColor,
  bg as textBg,
  dim as dimText,
  stringToStyledText,
  type TextChunk,
} from "@opentui/core";
import { worktreeDiffStat } from "../git.js";
import { killPeer, listPeers, resumePeer } from "../peerManager.js";
import { readCodexUsage, type CodexUsageLimit, type CodexUsageLevel } from "../codexUsage.js";
import { formatSupervisorTime, readSupervisorTelegramStatus, type SupervisorTelegramStatus } from "../supervisorStatus.js";
import type { PeerRecord } from "../types.js";
import { LogBuffer } from "./logEvents.js";
import {
  expireToasts,
  handleDashboardV3Input,
  initialRuntimeStateV3,
  initialThemeFromEnv,
  type RuntimeStateV3,
  type V3Route,
  type V3Toast,
} from "./v3Input.js";
import {
  createDashboardViewModel,
  fleetGridCells,
  statusColor,
  truncate,
  truncateMiddle,
  type DashboardPeerRow,
  type DashboardState,
  type DashboardStatus,
  type DashboardViewModel,
} from "./model.js";
import { defaultTheme, mutedTheme, type Theme } from "./theme.js";

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
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PEER_REFRESH_MS = 1000;
const DIFF_REFRESH_MS = 5000;
const USAGE_REFRESH_MS = 15000;
const SUPERVISOR_REFRESH_MS = 5000;

const ROUTE_META: Array<{ route: V3Route; glyph: string; digit: string; label: string; short: string }> = [
  { route: "fleet", glyph: "◉", digit: "1", label: "FLEET", short: "FLEET" },
  { route: "map", glyph: "◍", digit: "2", label: "MAP", short: "MAP" },
  { route: "limits", glyph: "⣿", digit: "3", label: "LIMITS", short: "LIM" },
  { route: "uplink", glyph: "⇅", digit: "4", label: "UPLINK", short: "UPL" },
  { route: "alerts", glyph: "⚠", digit: "5", label: "ALERTS", short: "ALR" },
];

const STATUS_GLYPH: Record<DashboardStatus, string> = {
  working: "◉",
  starting: "◌",
  waiting: "◍",
  gsd_running_phase: "◉",
  gsd_polling_state: "◎",
  gsd_running_gate_check: "◐",
  frozen: "▣",
  cleanup: "⇡",
  done: "○",
  gsd_completed: "○",
  failed: "✖",
  gsd_failed: "✖",
  gsd_halted_on_gate_failure: "⊘",
  killed: "✕",
  idle: "·",
  gsd_pending: "·",
};

const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];

export async function runOpenTuiDashboardV3(seed?: (state: RuntimeStateV3) => void): Promise<void> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    targetFps: 30,
    consoleMode: "disabled",
  });

  const state = initialRuntimeStateV3(initialThemeFromEnv());
  seed?.(state);

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
    expireToasts(state, currentTime);
    if (currentTime - lastPeerRefresh >= PEER_REFRESH_MS) {
      cachedPeers = listPeers();
      lastPeerRefresh = currentTime;
    }
    const view = createDashboardViewModel(cachedPeers, dashboardState(state), {
      logLimit: 80,
      logEventsProvider: (peerId) => {
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
        return cached.buffer.tail(2000);
      },
      diffStatProvider: (peerId, repo, baseRef) => {
        const peerChanged = cachedDiffPeerId !== peerId;
        const shouldRefresh = peerChanged || currentTime - lastDiffRefresh >= DIFF_REFRESH_MS;
        if (shouldRefresh && repo && baseRef) {
          cachedDiffPeerId = peerId;
          lastDiffRefresh = currentTime;
          try {
            const stat = worktreeDiffStat(repo, baseRef);
            cachedDiffText = stat ? `${stat.filesChanged} files  +${stat.insertions} -${stat.deletions}` : undefined;
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
    // Modal subject disappeared → close.
    if (state.modalPeerId && !view.peers.some((peer) => peer.id === state.modalPeerId)) {
      state.mode = "normal";
      state.modalPeerId = undefined;
      state.modalOpenedAt = undefined;
    }
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

  renderer.addInputHandler((sequence) =>
    handleDashboardV3Input(sequence, state, {
      refresh,
      quit,
      killPeer,
      sendPeerReply: (peerId, text) => resumePeer({ peerId, prompt: text }),
    }),
  );
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

function dashboardState(state: RuntimeStateV3): DashboardState {
  return {
    selectedIndex: state.selectedIndex,
    selectedPeerId: state.selectedPeerId,
    peerOffset: state.peerOffset,
    logOffset: state.logOffset,
    collapsedStatuses: state.collapsedStatuses,
    mode: "normal",
  };
}

type Layout = {
  W: number;
  H: number;
  narrow: boolean;
  medium: boolean;
  wide: boolean;
  railW: number;
  inspectorW: number;
  bodyH: number;
  drawerH: number;
  rosterContent: number;
  mainContent: number;
};

function computeLayout(state: RuntimeStateV3, W: number, H: number): Layout {
  const narrow = W < 100;
  const medium = W >= 100 && W < 142;
  const wide = W >= 142;
  const railW = narrow ? 0 : 4;
  const inspectorW = wide ? 30 : 0;
  const tabBarH = narrow ? 1 : 0;
  const drawerH = state.drawerOpen ? (medium ? 8 : Math.max(9, Math.floor(H * 0.24))) : 1;
  const bodyH = Math.max(6, H - 2 - tabBarH - 2 - drawerH);
  const mainOuter = W - railW;
  const rosterContent = Math.max(20, mainOuter - inspectorW - 4);
  const mainContent = Math.max(20, mainOuter - 4);
  return { W, H, narrow, medium, wide, railW, inspectorW, bodyH, drawerH, rosterContent, mainContent };
}

function render(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  view: DashboardViewModel,
  state: RuntimeStateV3,
  nowMs: number,
  supervisor: SupervisorTelegramStatus,
): void {
  for (const child of renderer.root.getChildren()) {
    child.destroyRecursively();
  }

  const overlayOpen = state.mode !== "normal";
  const theme = overlayOpen ? mutedTheme(state.theme) : state.theme;
  const layout = computeLayout(state, renderer.width, renderer.height);
  const spinner = SPINNER[Math.floor(nowMs / 120) % SPINNER.length];

  const children = [
    appBar(view, state, theme, spinner, layout),
    ...(layout.narrow ? [tabBar(state, theme, nowMs, view, layout)] : []),
    bodyRow(view, state, theme, spinner, nowMs, layout, supervisor),
    logsDrawer(view, state, theme, layout),
    footer(state, theme, layout),
  ];
  renderer.root.add(Box({ id: "v3-root", width: "100%", height: "100%", flexDirection: "column" }, ...children));

  // Toasts float above the footer, right-aligned.
  for (const box of toastBoxes(state, nowMs, layout)) {
    renderer.root.add(box);
  }

  if (state.mode === "modal" || state.mode === "modal-answer" || state.mode === "modal-kill") {
    renderer.root.add(modalBox(view, state, nowMs, layout));
  } else if (state.mode === "palette") {
    renderer.root.add(paletteBox(state, layout));
  } else if (state.mode === "help") {
    renderer.root.add(helpBox(state, nowMs, layout));
  }

  renderer.requestRender();
}

// --- app bar ------------------------------------------------------------

function appBar(view: DashboardViewModel, state: RuntimeStateV3, theme: Theme, spinner: string, layout: Layout) {
  const routeLabel = ROUTE_META.find((meta) => meta.route === state.route)?.label || "FLEET";
  const active = (view.counts.working || 0) + (view.counts.starting || 0) + (view.counts.gsd_running_phase || 0);
  const waiting = view.counts.waiting || 0;
  const failed = (view.counts.failed || 0) + (view.counts.gsd_failed || 0);
  const left: TextChunk[] = [
    textColor(theme.accent)(`${spinner} DELAMAIN `),
    ...dimmedChunks("▸ ", theme),
    textColor(theme.accent)(routeLabel),
  ];
  const right: TextChunk[] = [
    ...pillChunks(` ${view.peers.length} PEERS `, theme.chipBg, theme.chipFg, theme),
    ...plainChunks(" "),
    ...pillChunks(` ${active} ACTIVE `, theme.selBg, "#ffd9a8", theme),
    ...plainChunks(" "),
    ...(waiting > 0
      ? pillChunks(` ${waiting} WAITING `, theme.statusColors.waiting, "#050403", theme)
      : dimmedChunks(`▐ ${waiting} WAITING ▌`, theme)),
    ...plainChunks(" "),
    ...(failed > 0
      ? pillChunks(` ${failed} FAILED `, theme.statusColors.failed, "#050403", theme)
      : dimmedChunks(`▐ ${failed} FAILED ▌`, theme)),
    ...plainChunks("  "),
    ...dimmedChunks(": palette", theme),
  ];
  return Box(
    { id: "v3-appbar", width: "100%", height: 2, flexDirection: "row", border: ["bottom"], borderColor: theme.border, paddingX: 1 },
    Text({ content: styledText(...left) }),
    Box({ flexGrow: 1 }),
    Text({ content: styledText(...right) }),
  );
}

function tabBar(state: RuntimeStateV3, theme: Theme, nowMs: number, view: DashboardViewModel, layout: Layout) {
  const warnings = view.warnings.length;
  const chunks: TextChunk[] = [];
  for (const meta of ROUTE_META) {
    const activeRoute = meta.route === state.route;
    const label = `${meta.glyph} ${meta.short}`;
    if (activeRoute) {
      chunks.push(textBg(theme.accent)(textColor("#050403")(`▐${label}▌`)));
    } else {
      let glyphColor = theme.textDim;
      if (meta.route === "alerts" && warnings > 0) {
        glyphColor = Math.floor(nowMs / 480) % 2 === 0 ? theme.statusColors.failed : theme.border;
      }
      chunks.push(textColor(glyphColor)(` ${meta.glyph} `), ...dimmedChunks(meta.short, theme));
    }
    chunks.push(...plainChunks(" "));
  }
  return Box(
    { id: "v3-tabbar", width: "100%", height: 1, flexDirection: "row", paddingX: 1 },
    Text({ content: styledText(...chunks) }),
  );
}

// --- body ---------------------------------------------------------------

function bodyRow(
  view: DashboardViewModel,
  state: RuntimeStateV3,
  theme: Theme,
  spinner: string,
  nowMs: number,
  layout: Layout,
  supervisor: SupervisorTelegramStatus,
) {
  const children = [];
  if (!layout.narrow) {
    children.push(iconRail(state, theme, nowMs, view, layout));
  }
  children.push(mainArea(view, state, theme, spinner, nowMs, layout, supervisor));
  return Box({ id: "v3-body", width: "100%", height: layout.bodyH, flexDirection: "row" }, ...children);
}

function iconRail(state: RuntimeStateV3, theme: Theme, nowMs: number, view: DashboardViewModel, layout: Layout) {
  const warnings = view.warnings.length;
  const chunks: TextChunk[] = [];
  ROUTE_META.forEach((meta, index) => {
    const activeRoute = meta.route === state.route;
    let glyph = meta.glyph;
    let glyphChunk: TextChunk;
    if (activeRoute) {
      glyphChunk = textBg(theme.accent)(textColor("#050403")(` ${glyph} `));
    } else if (meta.route === "alerts" && warnings > 0) {
      const color = Math.floor(nowMs / 480) % 2 === 0 ? theme.statusColors.failed : theme.border;
      glyphChunk = textColor(color)(` ${glyph} `);
    } else {
      glyphChunk = textColor(theme.textDim)(` ${glyph} `);
    }
    const digitChunk = activeRoute
      ? textBg(theme.accent)(textColor("#050403")(` ${meta.digit} `))
      : textColor(theme.border)(` ${meta.digit} `);
    chunks.push(glyphChunk, ...plainChunks("\n"), digitChunk);
    if (index < ROUTE_META.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return Box(
    { id: "v3-rail", width: 4, height: "100%", flexShrink: 0, border: ["right"], borderColor: theme.border },
    Text({ content: styledText(...chunks) }),
  );
}

function mainArea(
  view: DashboardViewModel,
  state: RuntimeStateV3,
  theme: Theme,
  spinner: string,
  nowMs: number,
  layout: Layout,
  supervisor: SupervisorTelegramStatus,
) {
  if (state.route === "fleet") {
    const children = [rosterPane(view, state, theme, spinner, nowMs, layout)];
    if (layout.wide) {
      children.push(inspectorPane(view, state, theme, layout));
    }
    return Box({ id: "v3-main", flexGrow: 1, height: "100%", flexDirection: "row" }, ...children);
  }
  const inner = routeContent(state.route, view, state, theme, spinner, supervisor, layout);
  return Box(
    paneProps(routeTitle(state.route, view), theme, { id: "v3-main", flexGrow: 1, height: "100%" }),
    Text({ content: inner }),
  );
}

function routeTitle(route: V3Route, view: DashboardViewModel): string {
  const label = ROUTE_META.find((meta) => meta.route === route)?.label || route.toUpperCase();
  return `◢ ${label} ◤`;
}

function routeContent(
  route: V3Route,
  view: DashboardViewModel,
  state: RuntimeStateV3,
  theme: Theme,
  spinner: string,
  supervisor: SupervisorTelegramStatus,
  layout: Layout,
): StyledText {
  switch (route) {
    case "map":
      return fleetGrid(view, spinner, theme);
    case "limits":
      return limitsContent(view, theme);
    case "uplink":
      return uplinkContent(state, theme, supervisor);
    case "alerts":
      return alertsContent(view, theme, layout);
    default:
      return styledText(...dimmedChunks("-", theme));
  }
}

// --- roster (FLEET) -----------------------------------------------------

type RosterLine =
  | { kind: "group"; status: DashboardStatus; label: string }
  | { kind: "peer"; peer: DashboardPeerRow }
  | { kind: "terminal"; label: string }
  | { kind: "empty" };

function rosterLines(view: DashboardViewModel): RosterLine[] {
  const lines: RosterLine[] = [];
  const terminalBits: string[] = [];
  for (const status of STATUS_ORDER) {
    const peers = view.peers.filter((peer) => peer.status === status);
    if (peers.length === 0) {
      continue;
    }
    if (status === "done" || status === "killed" || status === "gsd_completed" || status === "idle" || status === "gsd_pending") {
      terminalBits.push(`${status.toUpperCase()} ${peers.length}`);
      continue;
    }
    lines.push({ kind: "group", status, label: `${view.collapsedStatuses[status] ? "▸" : "▾"} ${status.toUpperCase()} ${peers.length}` });
    if (!view.collapsedStatuses[status]) {
      for (const peer of peers) {
        lines.push({ kind: "peer", peer });
      }
    }
  }
  if (terminalBits.length > 0) {
    lines.push({ kind: "terminal", label: `▸ ${terminalBits.join(" · ")}` });
  }
  return lines;
}

function rosterPane(
  view: DashboardViewModel,
  state: RuntimeStateV3,
  theme: Theme,
  spinner: string,
  nowMs: number,
  layout: Layout,
) {
  const width = layout.wide ? layout.W - layout.railW - layout.inspectorW : layout.W - layout.railW;
  const content = layout.rosterContent;
  const visibleRows = Math.max(3, layout.bodyH - 2);
  const lines = rosterLines(view);
  const selectedLine = lines.findIndex((line) => line.kind === "peer" && line.peer.selected);
  const maxOffset = Math.max(0, lines.length - visibleRows);
  let offset = clamp(state.peerOffset, 0, maxOffset);
  if (state.followSelectedPeer && selectedLine !== -1) {
    if (selectedLine < offset) {
      offset = selectedLine;
    } else if (selectedLine >= offset + visibleRows) {
      offset = selectedLine - visibleRows + 1;
    }
  }
  state.peerOffset = offset;

  const rosterRows = lines.filter((line) => line.kind === "peer").length;
  const visible = lines.slice(offset, offset + visibleRows);
  const chunks: TextChunk[] = [];
  const sweepAllowed = state.theme !== defaultTheme && state.mode === "normal";
  visible.forEach((line, index) => {
    const rowIndex = offset + index;
    let bg: string | undefined;
    if (sweepAllowed) {
      bg =
        focusSweepBg(nowMs, state.focusChangedAt, index, visibleRows) ??
        (layout.W >= 100 ? ambientSweepBg(nowMs, rowIndex, rosterRows) : undefined);
    }
    chunks.push(...rosterLineChunks(line, content, spinner, theme, state, bg, layout));
    if (index < visible.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  // Fill the remainder with dim texture rows.
  for (let extra = visible.length; extra < visibleRows; extra += 1) {
    chunks.push(...plainChunks("\n"));
    chunks.push(...textureChunks(content, theme));
  }

  const position = scrollPosition(offset, visibleRows, lines.length);
  return Box(
    paneProps(`◢ ROSTER ${position} ◤`, theme, { width, height: "100%", flexShrink: 0 }),
    Text({ content: chunks.length > 0 ? styledText(...chunks) : styledText(...dimmedChunks("No peers yet", theme)) }),
  );
}

function rosterLineChunks(
  line: RosterLine,
  content: number,
  spinner: string,
  theme: Theme,
  state: RuntimeStateV3,
  bg: string | undefined,
  layout: Layout,
): TextChunk[] {
  if (line.kind === "group") {
    const color = statusColor(line.status, theme);
    const fillWidth = Math.max(0, content - line.label.length - 1);
    return applyBg(
      [textColor(color)(line.label), ...plainChunks(" "), textColor(theme.textDim)("▚".repeat(fillWidth))],
      line.label.length + 1 + fillWidth,
      bg,
      content,
    );
  }
  if (line.kind === "terminal") {
    return applyBg([...dimmedChunks(line.label, theme), textColor(theme.border)(" " + "·".repeat(Math.max(0, content - line.label.length - 1)))], content, bg, content);
  }
  if (line.kind === "empty") {
    return textureChunks(content, theme);
  }
  const peer = line.peer;
  const glyph = STATUS_GLYPH[peer.status] || "·";
  const color = statusColor(peer.status, theme);
  const activity =
    peer.status === "working" || peer.status === "starting" || peer.status === "gsd_running_phase"
      ? peer.activity.slice(0, 8).padEnd(8)
      : "        ";
  const idPart = peer.id.padEnd(8);
  const elapsed = peer.elapsed.padEnd(7);
  const compactRow = layout.narrow || content < 60;
  const projectWidth = compactRow ? Math.max(8, content - 28) : Math.max(10, Math.min(24, content - 34));
  const project = truncate(peer.project, projectWidth).padEnd(projectWidth);
  const usedSoFar = 2 + 8 + 1 + 8 + 1 + 7 + 1 + projectWidth + 1;
  const eventWidth = Math.max(0, content - usedSoFar);
  const lastEvent = eventWidth >= 8 && peer.lastEvent && peer.lastEvent !== "-" ? truncate(peer.lastEvent, eventWidth) : "";

  if (peer.selected) {
    const focused = !state.drawerFocused;
    const rowBg = focused ? "#ffb066" : theme.selBg;
    const rowFg = focused ? "#050403" : theme.text;
    let row = `▸ ${glyph} ${activity} ${idPart} ${elapsed} ${project}`;
    if (lastEvent) {
      row += ` ${lastEvent}`;
    }
    return [textBg(rowBg)(textColor(rowFg)(row.padEnd(content).slice(0, content)))];
  }

  const chunks: TextChunk[] = [
    textColor(color)(`${glyph} `),
    textColor(color)(activity),
    ...bodyChunks(` ${idPart} ${elapsed} `, theme),
    ...bodyChunks(project, theme),
  ];
  let len = 2 + 8 + 1 + 8 + 1 + 7 + 1 + projectWidth;
  if (lastEvent) {
    chunks.push(...dimmedChunks(` ${lastEvent}`, theme));
    len += 1 + lastEvent.length;
  }
  return applyBg(chunks, len, bg, content);
}

function textureChunks(content: number, theme: Theme): TextChunk[] {
  return [textColor(theme.border)("· ".repeat(Math.max(0, Math.floor(content / 2))))];
}

// Wrap chunks with a row background and pad to full content width so bands are square.
function applyBg(chunks: TextChunk[], len: number, bg: string | undefined, content: number): TextChunk[] {
  if (!bg) {
    return chunks;
  }
  const padded = [...chunks.map((chunk) => textBg(bg)(chunk))];
  const pad = Math.max(0, content - len);
  if (pad > 0) {
    padded.push(textBg(bg)(" ".repeat(pad)));
  }
  return padded;
}

// --- inspector ----------------------------------------------------------

function inspectorPane(view: DashboardViewModel, state: RuntimeStateV3, theme: Theme, layout: Layout) {
  const peer = view.peers.find((row) => row.id === state.selectedPeerId) || view.peers[view.selectedIndex];
  const detail = (label: string) => view.details.find((row) => row.label === label)?.value || "-";
  const chunks: TextChunk[] = [];
  if (!peer) {
    chunks.push(...dimmedChunks("No peer selected", theme));
  } else {
    const glyph = STATUS_GLYPH[peer.status] || "·";
    chunks.push(textColor(statusColor(peer.status, theme))(`${glyph} ${peer.status}`), ...dimmedChunks(`  ${peer.elapsed}`, theme), ...plainChunks("\n"));
    chunks.push(...bodyChunks(truncate(detail("model"), 26), theme), ...plainChunks("\n"));
    chunks.push(...bodyChunks(truncate(`${peer.project} · ${detail("peer branch")}`, 26), theme), ...plainChunks("\n"));
    chunks.push(textColor(theme.accent)("◢ GIT"), ...plainChunks("\n"));
    chunks.push(...inspectorRow("base", detail("base"), theme));
    chunks.push(...inspectorRow("tree", detail("worktree"), theme));
    chunks.push(...inspectorRow("diff", detail("diff"), theme));
    chunks.push(textColor(theme.accent)("◢ TASK"), ...plainChunks("\n"));
    chunks.push(...wrapText(detail("task"), 26, 3, theme));
    chunks.push(textColor(theme.accent)("◢ LAST"), ...plainChunks("\n"));
    chunks.push(...wrapText(detail("last event"), 26, 2, theme));
  }
  return Box(
    paneProps(`◢ INSPECTOR :: ${peer?.id || "-"} ◤`, theme, { width: 30, height: "100%", flexShrink: 0, border: ["left"] }),
    Text({ content: styledText(...chunks) }),
  );
}

function inspectorRow(label: string, value: string, theme: Theme): TextChunk[] {
  return [...dimmedChunks(label.padEnd(5), theme), ...bodyChunks(truncateMiddle(value, 20), theme), ...plainChunks("\n")];
}

function wrapText(text: string, width: number, maxLines: number, theme: Theme): TextChunk[] {
  const words = (text || "-").split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
    if (lines.length >= maxLines) {
      break;
    }
  }
  if (current.trim() && lines.length < maxLines) {
    lines.push(current.trim());
  }
  const chunks: TextChunk[] = [];
  lines.slice(0, maxLines).forEach((line) => {
    chunks.push(...bodyChunks(truncate(line, width), theme), ...plainChunks("\n"));
  });
  return chunks;
}

// --- MAP ----------------------------------------------------------------

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
        const glyph = peer.selected ? "◉" : peer.status === "working" || peer.status === "starting" ? spinner.slice(0, 1) : STATUS_GLYPH[peer.status] || "○";
        chunks.push(
          peer.selected
            ? textBg(theme.selBg)(textColor(theme.borderFocused)(glyph))
            : textColor(statusColor(peer.status, theme))(glyph),
        );
      }
      const overflow = peers.length > blips.length ? `+${peers.length - blips.length}` : "";
      chunks.push(...bodyChunks(overflow.padEnd(Math.max(0, colWidth - blips.length)), theme));
    }
  });
  return styledText(...chunks);
}

// --- LIMITS -------------------------------------------------------------

function limitsContent(view: DashboardViewModel, theme: Theme): StyledText {
  if (!view.codexUsage || view.codexUsage.limits.length === 0) {
    return styledText(...dimmedChunks("Waiting for Codex rate-limit telemetry", theme));
  }
  const chunks: TextChunk[] = [];
  view.codexUsage.limits.forEach((limit, index) => {
    chunks.push(...brailleMeterLine(limit, theme));
    if (index < view.codexUsage!.limits.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return styledText(...chunks);
}

function brailleMeterLine(limit: CodexUsageLimit, theme: Theme): TextChunk[] {
  const cells = 12;
  const filled = Math.round((limit.usedPercent / 100) * cells * 6);
  let bar = "";
  for (let i = 0; i < cells; i += 1) {
    bar += BRAILLE_LEVELS[clamp(filled - i * 6, 0, 6)];
  }
  const color = usageLevelColor(limit.level, theme);
  const prefix = limit.level === "skull" ? "💀 " : "";
  const chunks: TextChunk[] = [
    textColor(color)(`${prefix}${limit.label.padEnd(7)} `),
    textColor(color)(bar),
    textColor(color)(` ${limit.remainingPercent}% left`),
  ];
  if (limit.resetAt) {
    chunks.push(...dimmedChunks(`\n        ${resetLabel(limit)}`, theme));
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

function usageLevelColor(level: CodexUsageLevel, theme: Theme): string {
  switch (level) {
    case "green":
      return "#ffb066";
    case "yellow":
      return "#ffd166";
    case "red":
    case "skull":
      return "#ff4433";
    default:
      return theme.text;
  }
}

// --- UPLINK -------------------------------------------------------------

function uplinkContent(state: RuntimeStateV3, theme: Theme, supervisor: SupervisorTelegramStatus): StyledText {
  const chunks: TextChunk[] = [textColor(supervisorColor(supervisor.level))(`${supervisor.icon} ${truncate(supervisor.label, 72)}`), ...plainChunks("\n")];
  chunks.push(...dimmedChunks("roadmap  ", theme), ...bodyChunks(supervisor.roadmap || "-", theme), ...plainChunks("\n"));
  chunks.push(...dimmedChunks("slice    ", theme), ...bodyChunks(supervisor.sliceId || "-", theme), ...plainChunks("\n"));
  chunks.push(...dimmedChunks("branch   ", theme), ...bodyChunks(truncateMiddle(supervisor.mergeBranch || "-", 42), theme));
  if (supervisor.latestLogAt) {
    chunks.push(...plainChunks("\n"), ...dimmedChunks("tick     ", theme), ...bodyChunks(formatSupervisorTime(supervisor.latestLogAt), theme));
  }
  if (supervisor.haltedReason) {
    chunks.push(...plainChunks("\n"), textColor(theme.statusColors.failed)(truncate(supervisor.haltedReason, 72)));
  }
  return styledText(...chunks);
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
    default:
      return "#94a3b8";
  }
}

// --- ALERTS -------------------------------------------------------------

function alertsContent(view: DashboardViewModel, theme: Theme, layout: Layout): StyledText {
  if (view.warnings.length === 0) {
    const width = layout.mainContent;
    const label = "NO SIGNALS";
    const pad = Math.max(0, Math.floor((width - label.length) / 2));
    const dither = "▚▞".repeat(Math.max(1, Math.floor(width / 2)));
    return styledText(
      textColor(theme.border)(dither),
      ...plainChunks("\n"),
      ...plainChunks(" ".repeat(pad)),
      textColor(theme.border)(label),
      ...plainChunks("\n"),
      textColor(theme.border)(dither),
    );
  }
  const chunks: TextChunk[] = [];
  view.warnings.forEach((warning, index) => {
    chunks.push(textColor(theme.statusColors.waiting)(`⚠ ${truncate(warning, layout.mainContent - 2)}`));
    if (index < view.warnings.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return styledText(...chunks);
}

// --- logs drawer --------------------------------------------------------

function logsDrawer(view: DashboardViewModel, state: RuntimeStateV3, theme: Theme, layout: Layout) {
  const peerId = view.selectedPeer?.id || "-";
  if (!state.drawerOpen) {
    return Box(
      { id: "v3-drawer", width: "100%", height: 1, flexDirection: "row", border: ["top"], borderColor: theme.border, paddingX: 1 },
      Text({ content: styledText(...dimmedChunks(`▸ LOGS :: ${peerId} — \` to open`, theme)) }),
    );
  }
  const visibleRows = Math.max(3, layout.drawerH - 3);
  const content = visibleLogContent(view.logLines, state.logOffset, visibleRows);
  state.logOffset = content.offset;
  const lines = withScrollbar(
    content.lines.length > 0 ? content.lines : ["No recent log lines"],
    content.offset,
    content.visibleRows,
    content.totalRows,
  );
  const chunks: TextChunk[] = [...plainChunks(`${logProgressLine(content.offset, content.visibleRows, content.totalRows)}\n`)];
  lines.forEach((line, index) => {
    chunks.push(...logLineChunks(line, theme));
    if (index < lines.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  const title = `▴ LOGS :: ${peerId} ${content.position}    \` toggle`;
  return Box(
    {
      id: "v3-drawer",
      width: "100%",
      height: layout.drawerH,
      flexShrink: 0,
      border: ["top"],
      borderColor: state.drawerFocused ? theme.borderFocused : theme.border,
      paddingX: 1,
      title: ` ${title} `,
    },
    Text({ content: styledText(...chunks) }),
  );
}

function logLineChunks(line: string, theme: Theme): TextChunk[] {
  const map: Array<[string, string, string]> = [
    ["TURN", "▸", theme.statusColors.starting],
    ["CMD", "⌁", theme.statusColors.working],
    ["FILE", "✎", theme.statusColors.cleanup],
    ["ERR", "✖", theme.statusColors.failed],
    ["MSG", "▪", theme.statusColors.waiting],
  ];
  for (const [prefix, glyph, color] of map) {
    if (line.startsWith(prefix)) {
      return [textColor(color)(`${glyph} ${line}`)];
    }
  }
  if (/(error|failed|fatal|halted|kill(ed)?)/i.test(line)) {
    return [textColor(theme.statusColors.failed)(line)];
  }
  return bodyChunks(line, theme);
}

// --- footer -------------------------------------------------------------

function footer(state: RuntimeStateV3, theme: Theme, layout: Layout) {
  const keys: Array<[string, string]> = [
    ["j/k", "nav"],
    ["↵", "open"],
    [":", "palette"],
    ["`", "logs"],
    ["1-5", "view"],
    ["tab", "drawer"],
    ["?", "help"],
  ];
  const chunks: TextChunk[] = [];
  keys.forEach(([key, label], index) => {
    chunks.push(textColor(theme.accent)(key), ...dimmedChunks(` ${label}`, theme));
    if (index < keys.length - 1) {
      chunks.push(...dimmedChunks(" · ", theme));
    }
  });
  const scrolled = state.logOffset > 0;
  const status = scrolled
    ? [textBg(theme.statusColors.starting === "#35e0d8" ? "#35e0d8" : "#35e0d8")(textColor("#050403")("▐ ⏸ SCROLLED ▌"))]
    : [textBg(theme.accent)(textColor("#050403")("▐ ◉ LIVE ▌"))];
  return Box(
    { id: "v3-footer", width: "100%", height: 2, flexDirection: "row", border: ["top"], borderColor: theme.border, paddingX: 1 },
    Text({ content: styledText(...chunks) }),
    Box({ flexGrow: 1 }),
    Text({ content: styledText(...status) }),
  );
}

// --- toasts -------------------------------------------------------------

function toastBoxes(state: RuntimeStateV3, nowMs: number, layout: Layout): ReturnType<typeof Box>[] {
  const boxes: ReturnType<typeof Box>[] = [];
  state.toasts.forEach((toast, index) => {
    const chip = toastChip(toast, nowMs, state.theme);
    if (!chip) {
      return;
    }
    const top = Math.max(1, layout.H - 3 - state.toasts.length + index);
    const boxWidth = chip.width + 2;
    boxes.push(
      Box(
        {
          position: "absolute",
          zIndex: 90,
          top,
          left: Math.max(1, layout.W - boxWidth - 2),
          width: boxWidth,
          height: 1,
        },
        Text({ content: styledText(...chip.chunks) }),
      ),
    );
  });
  return boxes;
}

function toastChip(toast: V3Toast, nowMs: number, theme: Theme): { chunks: TextChunk[]; width: number } | undefined {
  const t = nowMs - toast.createdAt;
  if (t >= 3000) {
    return undefined;
  }
  const full = `▐ ✔ ${toast.text} ▌`;
  const grow = Math.ceil(Math.min(1, t / 240) * full.length);
  const text = full.slice(full.length - grow);
  const fg = toast.level === "error" ? "#ff4433" : t > 2760 ? "#8a5a2e" : theme.chipFg;
  return { chunks: [textBg(theme.chipBg)(textColor(fg)(text))], width: text.length };
}

// --- modal --------------------------------------------------------------

function modalBox(view: DashboardViewModel, state: RuntimeStateV3, nowMs: number, layout: Layout) {
  const w = layout.narrow ? layout.W - 4 : Math.min(80, layout.W - 8);
  const h = Math.min(22, layout.H - 6);
  const left = Math.max(0, Math.floor((layout.W - w) / 2));
  const top = Math.max(0, Math.floor((layout.H - h) / 2));
  const contentRows = h - 2;
  const innerWidth = w - 4;
  const peer = view.peers.find((row) => row.id === state.modalPeerId);
  const detail = (label: string) => view.details.find((row) => row.label === label)?.value || "-";
  const reveal = modalReveal(nowMs, state.modalOpenedAt || nowMs, contentRows);

  const rows: TextChunk[][] = [];
  // summary strip
  if (peer) {
    rows.push([
      textColor(statusColor(peer.status, state.theme))(`${STATUS_GLYPH[peer.status] || "·"} ${peer.status}`),
      ...dimmedChunks(`  ${peer.elapsed}  ·  `, state.theme),
      ...bodyChunks(truncate(detail("model"), 22), state.theme),
      ...dimmedChunks("  ·  ", state.theme),
      ...bodyChunks(truncate(peer.project, 20), state.theme),
    ]);
  } else {
    rows.push([...dimmedChunks("peer unavailable", state.theme)]);
  }
  rows.push([]);
  // tabs
  const tabs = ["INFO", "LOG", "GIT"];
  const tabChunks: TextChunk[] = [];
  tabs.forEach((tab, index) => {
    if (index === state.modalTab) {
      tabChunks.push(textBg(state.theme.accent)(textColor("#050403")(` ${tab} `)));
    } else {
      tabChunks.push(textColor(state.theme.textDim)(` ${tab} `));
    }
    tabChunks.push(...plainChunks(" "));
  });
  rows.push(tabChunks);
  rows.push([]);
  // tab body
  const bodyRows = modalTabBody(state, view, detail, innerWidth);
  const bodyBudget = Math.max(2, contentRows - 6 - 2);
  for (const row of bodyRows.slice(0, bodyBudget)) {
    rows.push(row);
  }
  // fill
  while (rows.length < contentRows - 2) {
    rows.push([]);
  }
  // button row
  rows.push(modalButtonRow(state, view, nowMs, innerWidth));

  // Apply open-sweep reveal
  const chunks: TextChunk[] = [];
  rows.slice(0, contentRows).forEach((rowChunks, index) => {
    if (!reveal.done && index === reveal.reveal) {
      chunks.push(textBg(state.theme.cyanBand ? "#35e0d8" : "#35e0d8")(textColor("#050403")(" ".repeat(innerWidth))));
    } else if (!reveal.done && index > reveal.reveal) {
      chunks.push(textColor("#150b03")("▚".repeat(innerWidth)));
    } else {
      chunks.push(...rowChunks);
    }
    if (index < Math.min(rows.length, contentRows) - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });

  return Box(
    {
      id: "v3-modal",
      position: "absolute",
      zIndex: 100,
      left,
      top,
      width: w,
      height: h,
      borderStyle: "double",
      borderColor: "#35e0d8",
      backgroundColor: "#050403",
      paddingX: 1,
      title: ` ◢ PEER ${state.modalPeerId || "-"} ◤ `,
    },
    Text({ content: styledText(...chunks) }),
  );
}

function modalTabBody(
  state: RuntimeStateV3,
  view: DashboardViewModel,
  detail: (label: string) => string,
  innerWidth: number,
): TextChunk[][] {
  const rows: TextChunk[][] = [];
  const kv = (label: string, value: string) => rows.push([...dimmedChunks(label.padEnd(12), state.theme), ...bodyChunks(truncate(value, innerWidth - 13), state.theme)]);
  if (state.modalTab === 0) {
    kv("task", detail("task"));
    kv("question", detail("question"));
    const record = view.selectedPeer?.id === state.modalPeerId ? view.selectedPeer : undefined;
    const row = view.peers.find((candidate) => candidate.id === state.modalPeerId);
    kv("started", record?.startedAt ? new Date(record.startedAt).toLocaleString() : "-");
    kv("runtime", row?.elapsed || "-");
    kv("last event", detail("last event"));
    kv("integration", detail("integration"));
    kv("log", detail("log"));
  } else if (state.modalTab === 1) {
    const lines = view.logLines.slice(Math.max(0, view.logLines.length - 12 - state.modalScroll), view.logLines.length - state.modalScroll);
    if (lines.length === 0) {
      rows.push([...dimmedChunks("no log lines", state.theme)]);
    }
    for (const line of lines) {
      rows.push(logLineChunks(truncate(line, innerWidth), state.theme));
    }
  } else {
    kv("source", detail("source"));
    kv("worktree", detail("worktree"));
    kv("base", detail("base"));
    kv("target", detail("merge target"));
    kv("branch", detail("peer branch"));
    kv("diff", detail("diff"));
  }
  return rows;
}

function modalButtonRow(state: RuntimeStateV3, view: DashboardViewModel, nowMs: number, innerWidth: number): TextChunk[] {
  const peer = view.peers.find((row) => row.id === state.modalPeerId);
  const waiting = peer?.status === "waiting";
  const narrow = innerWidth < 50;

  if (state.mode === "modal-answer") {
    const cursor = Math.floor(nowMs / 480) % 2 === 0 ? "▏" : " ";
    return [
      textBg("#35e0d8")(textColor("#050403")(" ↳ ")),
      ...plainChunks(" "),
      ...bodyChunks(truncate(state.answerInput, innerWidth - 6), state.theme),
      textColor(state.theme.accent)(cursor),
    ];
  }

  const buttons: Array<{ key: "answer" | "view-log" | "kill"; label: string; glyph: string }> = [];
  if (waiting) {
    buttons.push({ key: "answer", label: "ANSWER", glyph: "↳" });
  }
  buttons.push({ key: "view-log", label: "VIEW LOG", glyph: "≡" });
  buttons.push({ key: "kill", label: "KILL", glyph: "✕" });
  const focusedIndex = clamp(state.modalButton, 0, buttons.length - 1);

  const chunks: TextChunk[] = [];
  // answer disabled chip when not waiting
  if (!waiting) {
    chunks.push(textColor("#3a2410")(narrow ? "▐↳▌ " : "⟦ ↳ ANSWER ⟧ "));
  }
  buttons.forEach((btn, index) => {
    const focused = index === focusedIndex;
    const killArmed = btn.key === "kill" && state.mode === "modal-kill";
    if (killArmed) {
      chunks.push(textBg("#ff4433")(textColor("#050403")(" ✕ CONFIRM KILL ")));
    } else if (state.mode === "modal-kill") {
      chunks.push(textColor("#3a2410")(narrow ? `▐${btn.glyph}▌` : `⟦ ${btn.glyph} ${btn.label} ⟧`));
    } else if (focused) {
      const bg = btn.key === "kill" ? "#ff4433" : "#35e0d8";
      chunks.push(textBg(bg)(textColor("#050403")(narrow ? `▐${btn.glyph}▌` : ` ${btn.glyph} ${btn.label} `)));
    } else {
      const keyColor = btn.key === "kill" ? "#ff4433" : state.theme.accent;
      if (narrow) {
        chunks.push(textColor(keyColor)(`⟦${btn.glyph}⟧`));
      } else {
        chunks.push(textColor(state.theme.textDim)("⟦ "), textColor(keyColor)(btn.glyph), textColor(state.theme.textDim)(` ${btn.label} ⟧`));
      }
    }
    chunks.push(...plainChunks(" "));
  });
  return chunks;
}

// --- palette ------------------------------------------------------------

function paletteBox(state: RuntimeStateV3, layout: Layout) {
  const w = layout.narrow ? layout.W - 4 : Math.min(64, layout.W - 8);
  const left = Math.max(0, Math.floor((layout.W - w) / 2));
  const innerWidth = w - 4;
  const maxResults = layout.narrow ? 6 : 10;
  const entries = filterPaletteLabels(state);
  const results = entries.slice(0, maxResults);
  const index = clamp(state.paletteIndex, 0, Math.max(0, results.length - 1));
  const h = results.length + 4;

  const chunks: TextChunk[] = [textColor(state.theme.accent)("▸ "), ...bodyChunks(`${state.paletteQuery}▏`, state.theme), ...plainChunks("\n")];
  if (results.length === 0) {
    chunks.push(...dimmedChunks("no matches", state.theme));
  }
  results.forEach((label, i) => {
    if (i === index) {
      chunks.push(textBg(state.theme.selBg)(textColor("#ffffff")(` ${truncate(label, innerWidth - 2)} `.padEnd(innerWidth))));
    } else {
      chunks.push(...bodyChunks(truncate(label, innerWidth), state.theme));
    }
    if (i < results.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });

  return Box(
    {
      id: "v3-palette",
      position: "absolute",
      zIndex: 110,
      left,
      top: 3,
      width: w,
      height: h,
      borderStyle: "single",
      borderColor: "#35e0d8",
      backgroundColor: "#050403",
      paddingX: 1,
      title: " ◢ PALETTE ◤ ",
    },
    Text({ content: styledText(...chunks) }),
  );
}

// Rebuild palette labels here to avoid re-importing filter internals; mirrors paletteEntries shape.
function filterPaletteLabels(state: RuntimeStateV3): string[] {
  const needle = state.paletteQuery.toLowerCase();
  const labels: string[] = [];
  for (const peer of state.visiblePeers) {
    labels.push(`▸ ${peer.id} · ${peer.status} · ${peer.project}`);
  }
  for (const peer of state.visiblePeers.filter((p) => p.status === "waiting")) {
    labels.push(`↳ answer ${peer.id}`);
  }
  const terminal = new Set(["done", "failed", "killed", "gsd_completed", "gsd_failed"]);
  for (const peer of state.visiblePeers.filter((p) => !terminal.has(p.status))) {
    labels.push(`✕ kill ${peer.id}`);
  }
  for (const meta of ROUTE_META) {
    labels.push(`route ${meta.route}`);
  }
  labels.push("◐ theme", "⟳ refresh", "? help", "q quit");
  if (!needle) {
    return labels;
  }
  return labels.filter((label) => isSubsequence(needle, label.toLowerCase()));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
    if (haystack[j] === needle[i]) {
      i += 1;
    }
  }
  return i === needle.length;
}

// --- help ---------------------------------------------------------------

function helpBox(state: RuntimeStateV3, nowMs: number, layout: Layout) {
  const w = layout.narrow ? layout.W - 4 : Math.min(80, layout.W - 8);
  const h = Math.min(22, layout.H - 6);
  const left = Math.max(0, Math.floor((layout.W - w) / 2));
  const top = Math.max(0, Math.floor((layout.H - h) / 2));
  const lines = [
    "1-5    switch route",
    "j/k    move selection (or scroll logs when drawer focused)",
    "h/l    MAP columns",
    "↵ / space   open peer modal",
    "tab    toggle main / drawer focus",
    "`      toggle logs drawer",
    ": / Ctrl+K   command palette",
    "c      collapse focused status group",
    "g/G    top / bottom     pgup/pgdn   page",
    "b      latest logs      e   previous error",
    "a      answer waiting peer",
    "x      kill selected peer",
    "t      cycle theme      r   refresh",
    "? / esc / q   close help / quit",
  ];
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    const [key, ...rest] = line.split(/\s{2,}/);
    chunks.push(textColor(state.theme.accent)(key.padEnd(8)), ...dimmedChunks(rest.join("  "), state.theme));
    if (index < lines.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return Box(
    {
      id: "v3-help",
      position: "absolute",
      zIndex: 110,
      left,
      top,
      width: w,
      height: h,
      borderStyle: "double",
      borderColor: "#35e0d8",
      backgroundColor: "#050403",
      paddingX: 1,
      title: " ◢ HELP ◤ ",
    },
    Text({ content: styledText(...chunks) }),
  );
}

// --- CRT sweeps ---------------------------------------------------------

export function ambientSweepBg(nowMs: number, rowIndex: number, rosterRows: number): string | undefined {
  const sweepRow = Math.floor(((nowMs % 9000) / 9000) * (rosterRows + 3));
  if (rowIndex === sweepRow) {
    return "#1a1006";
  }
  if (rowIndex === sweepRow - 1) {
    return "#100a04";
  }
  return undefined;
}

export function focusSweepBg(nowMs: number, changedAt: number | undefined, rowIndex: number, H: number): string | undefined {
  if (changedAt === undefined) {
    return undefined;
  }
  const D = 240;
  const t = nowMs - changedAt;
  if (t < 0 || t >= D) {
    return undefined;
  }
  const band = Math.floor((t / D) * H);
  if (rowIndex === band) {
    return "#2a1808";
  }
  if (rowIndex === band - 1) {
    return "#1a1006";
  }
  if (rowIndex === band - 2) {
    return "#100a04";
  }
  return undefined;
}

export function modalReveal(nowMs: number, openedAt: number, contentRows: number): { reveal: number; done: boolean } {
  const D = 360;
  const t = nowMs - openedAt;
  const p = Math.min(1, t / D);
  return { reveal: Math.ceil(p * contentRows), done: t >= D };
}

// --- shared chunk/scroll helpers (copied from v2) -----------------------

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

function pillChunks(text: string, bg: string, fg: string, theme: Theme): TextChunk[] {
  return [textColor(theme.textDim)("▐"), textBg(bg)(textColor(fg)(text)), textColor(theme.textDim)("▌")];
}

function paneProps(title: string, theme: Theme, extra: Record<string, unknown> = {}) {
  return {
    title: ` ${title} `,
    border: true,
    borderStyle: "single" as const,
    borderColor: theme.border,
    paddingX: 1,
    ...extra,
  };
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

function scrollPosition(offset: number, visibleRows: number, totalRows: number): string {
  if (totalRows <= visibleRows) {
    return `⟨all ${totalRows}⟩`;
  }
  const start = totalRows - offset - visibleRows + 1;
  const end = totalRows - offset;
  return `⟨${Math.max(1, start)}-${Math.max(1, end)}/${totalRows}⟩`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
