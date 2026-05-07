import { Box, Text, ScrollBox, StyledText, createCliRenderer, fg as textColor, dim as dimText, stringToStyledText, type TextChunk } from "@opentui/core";
import { killPeer, listPeers, readPeerLog } from "../peerManager.js";
import { commandForKey, type DashboardCommand } from "./keybindings.js";
import {
  createDashboardViewModel,
  nextFocusPane,
  statusColor,
  truncate,
  type DashboardPeerRow,
  type DashboardState,
  type DashboardStatus,
  type DashboardViewModel,
} from "./model.js";

type RuntimeState = Required<Pick<DashboardState, "selectedIndex" | "focusPane" | "mode" | "logOffset">> &
  Omit<DashboardState, "selectedIndex" | "focusPane" | "mode" | "logOffset">;

const STATUS_ORDER = ["working", "waiting", "cleanup", "done", "failed", "frozen", "killed", "idle"] as const;

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
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  let destroyed = false;
  let cachedPeers = listPeers();
  let lastPeerRefresh = 0;

  const refresh = (): void => {
    const currentTime = Date.now();
    if (currentTime - lastPeerRefresh >= 1000) {
      cachedPeers = listPeers();
      lastPeerRefresh = currentTime;
    }
    const peers = cachedPeers;
    const view = createDashboardViewModel(peers, state, {
      logLimit: 80,
      logProvider: readPeerLog,
    });
    state.selectedIndex = view.selectedIndex;
    state.selectedPeerId = view.selectedPeer?.id;
    if (state.expandedPeerId && !peers.some((peer) => peer.id === state.expandedPeerId)) {
      state.expandedPeerId = undefined;
    }
    render(renderer, view);
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
    const command = commandForKey(sequence, state.mode);
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
      break;
    case "select-prev":
      state.selectedIndex -= 1;
      state.selectedPeerId = undefined;
      state.logOffset = 0;
      break;
    case "toggle-details":
      state.expandedPeerId = state.expandedPeerId === state.selectedPeerId ? undefined : state.selectedPeerId;
      break;
    case "scroll-log-down":
      state.logOffset = Math.max(0, state.logOffset - 1);
      break;
    case "scroll-log-up":
      state.logOffset += 1;
      break;
    case "page-log-down":
      state.logOffset = Math.max(0, state.logOffset - 10);
      break;
    case "page-log-up":
      state.logOffset += 10;
      break;
    case "refresh":
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

function render(renderer: Awaited<ReturnType<typeof createCliRenderer>>, view: DashboardViewModel): void {
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
        peerPane(view, narrow, renderer.width),
        Box(
          {
            id: "dashboard-right",
            flexGrow: 1,
            flexDirection: "column",
            gap: narrow ? 0 : 1,
            minHeight: narrow ? 9 : 0,
          },
          detailsPane(view, narrow),
          logsPane(view),
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
  return Box(
    paneProps("Status", view.focusPane === "status", { height: 3 }),
    Text({ content: truncateStyled(chunks, 180) }),
  );
}

function peerPane(view: DashboardViewModel, narrow: boolean, screenWidth: number) {
  const paneWidth = narrow ? screenWidth : Math.min(Math.max(62, Math.floor(screenWidth * 0.46)), 86);
  const rows = view.peers.length > 0 ? peerRows(view.peers, paneWidth) : styledText(dimText("No peers yet"));
  return Box(
    paneProps("Peers", view.focusPane === "peers", {
      width: narrow ? "100%" : paneWidth,
      height: narrow ? 8 : "100%",
      flexShrink: 0,
    }),
    Text({ content: rows }),
  );
}

function detailsPane(view: DashboardViewModel, narrow: boolean) {
  const rows = view.details.length > 0
    ? view.details.map((row) => `${row.label}: ${truncate(row.value, narrow ? 96 : 120)}`).join("\n")
    : "No peer selected";
  return Box(
    paneProps("Details", view.focusPane === "details", {
      height: narrow ? 6 : 12,
      flexShrink: 0,
    }),
    Text({ content: rows }),
  );
}

function logsPane(view: DashboardViewModel) {
  const lines = view.logLines.length > 0 ? view.logLines.slice(-180).join("\n") : "No recent log lines";
  return ScrollBox(
    paneProps("Logs", view.focusPane === "logs", {
      flexGrow: 1,
      minHeight: 3,
      overflow: "hidden",
    }),
    Text({ content: lines }),
  );
}

function keysPane(view: DashboardViewModel) {
  const modeText = view.mode === "kill-confirm" ? view.message : `${view.message} | tab focus, shift-tab back, j k select, enter details, pgup pgdn logs, r refresh, x kill, q quit`;
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

function peerRows(peers: DashboardPeerRow[], paneWidth: number): StyledText {
  const chunks: TextChunk[] = [];
  peers.forEach((peer, index) => {
    chunks.push(...peerRow(peer, paneWidth));
    if (index < peers.length - 1) {
      chunks.push(...plainChunks("\n"));
    }
  });
  return styledText(...chunks);
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
