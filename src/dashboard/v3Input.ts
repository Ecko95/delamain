import type { PeerRecord } from "../types.js";
import { fleetStageForStatus, type DashboardPeerRow, type DashboardStatus } from "./model.js";
import { cyberpunkTheme, defaultTheme, type Theme } from "./theme.js";
import { initialThemeFromEnv } from "./v2Input.js";

export { initialThemeFromEnv };

export type V3Route = "fleet" | "map" | "limits" | "uplink" | "alerts";
export type V3Mode = "normal" | "palette" | "kill-confirm" | "answer" | "help";

export const V3_ROUTES: V3Route[] = ["fleet", "map", "limits", "uplink", "alerts"];

export type V3Toast = {
  text: string;
  level: "info" | "error";
  createdAt: number;
};

export type RuntimeStateV3 = {
  route: V3Route;
  drawerOpen: boolean;
  drawerFocused: boolean;
  pendingPeerId?: string;
  focusChangedAt?: number;
  paletteQuery: string;
  paletteIndex: number;
  toasts: V3Toast[];
  // kept from v2
  selectedIndex: number;
  selectedPeerId?: string;
  peerOffset: number;
  logOffset: number;
  collapsedStatuses: Partial<Record<DashboardStatus, boolean>>;
  followSelectedPeer: boolean;
  forceLogRefresh: boolean;
  visiblePeers: DashboardPeerRow[];
  logEventLevels: Array<"info" | "warn" | "error">;
  theme: Theme;
  answerInput: string;
  mode: V3Mode;
};

export type DashboardV3Actions = {
  refresh: () => void;
  quit: () => void;
  killPeer: (peerId: string) => PeerRecord;
  sendPeerReply: (peerId: string, text: string) => PeerRecord;
};

export type DashboardV3Command =
  | "switch-route-1"
  | "switch-route-2"
  | "switch-route-3"
  | "switch-route-4"
  | "switch-route-5"
  | "select-next"
  | "select-prev"
  | "map-left"
  | "map-right"
  | "toggle-drawer-focus"
  | "toggle-drawer-focus-prev"
  | "toggle-drawer"
  | "open-palette"
  | "toggle-status-group"
  | "jump-top"
  | "jump-bottom"
  | "page-up"
  | "page-down"
  | "log-bottom"
  | "jump-error"
  | "open-answer"
  | "open-kill-confirm"
  | "cycle-theme"
  | "refresh"
  | "help"
  | "quit"
  | "confirm-kill"
  | "palette-move-up"
  | "palette-move-down"
  | "palette-run"
  | "palette-close"
  | "submit-answer"
  | "cancel"
  | "noop";

const CTRL_C = "\x03";
const CTRL_K = "\x0b";
const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const SHIFT_TAB = "\x1b[Z";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ENTER = new Set(["\r", "\n"]);
const ESC = "\x1b";

export function v3CommandForKey(sequence: string, state: RuntimeStateV3): DashboardV3Command {
  if (sequence === CTRL_C) {
    return "quit";
  }

  switch (state.mode) {
    case "kill-confirm":
      if (ENTER.has(sequence)) {
        return "confirm-kill";
      }
      if (sequence === ESC || sequence === "q") {
        return "cancel";
      }
      return "noop";

    case "answer":
      if (ENTER.has(sequence)) {
        return "submit-answer";
      }
      if (sequence === ESC) {
        return "cancel";
      }
      return "noop";

    case "palette":
      if (ENTER.has(sequence)) {
        return "palette-run";
      }
      if (sequence === ESC) {
        return "palette-close";
      }
      if (sequence === ARROW_UP || sequence === CTRL_P) {
        return "palette-move-up";
      }
      if (sequence === ARROW_DOWN || sequence === CTRL_N) {
        return "palette-move-down";
      }
      return "noop";

    case "help":
      if (sequence === ESC || sequence === "q" || sequence === "?") {
        return "cancel";
      }
      return "noop";

    case "normal":
    default:
      return normalCommand(sequence);
  }
}

function normalCommand(sequence: string): DashboardV3Command {
  switch (sequence) {
    case "1":
      return "switch-route-1";
    case "2":
      return "switch-route-2";
    case "3":
      return "switch-route-3";
    case "4":
      return "switch-route-4";
    case "5":
      return "switch-route-5";
    case "q":
      return "quit";
    case "j":
    case ARROW_DOWN:
      return "select-next";
    case "k":
    case ARROW_UP:
      return "select-prev";
    case "h":
    case ARROW_LEFT:
      return "map-left";
    case "l":
    case ARROW_RIGHT:
      return "map-right";
    case "\r":
    case "\n":
    case " ":
      return "noop"; // ponytail: no modal to open; bottom dock (Plan 05) always shows the selection
    case "\t":
      return "toggle-drawer-focus";
    case SHIFT_TAB:
      return "toggle-drawer-focus-prev";
    case "`":
      return "toggle-drawer";
    case ":":
    case CTRL_K:
      return "open-palette";
    case "c":
      return "toggle-status-group";
    case "g":
      return "jump-top";
    case "G":
      return "jump-bottom";
    case PAGE_UP:
      return "page-up";
    case PAGE_DOWN:
      return "page-down";
    case "b":
      return "log-bottom";
    case "e":
      return "jump-error";
    case "a":
      return "open-answer";
    case "x":
      return "open-kill-confirm";
    case "t":
      return "cycle-theme";
    case "r":
      return "refresh";
    case "?":
      return "help";
    default:
      return "noop";
  }
}

export function handleDashboardV3Input(sequence: string, state: RuntimeStateV3, actions: DashboardV3Actions): boolean {
  // Text-entry branches (before command routing).
  if (state.mode === "answer" && isTextInput(sequence)) {
    if (sequence === "\x7f" || sequence === "\b") {
      state.answerInput = state.answerInput.slice(0, -1);
    } else {
      state.answerInput += sequence;
    }
    actions.refresh();
    return true;
  }
  if (state.mode === "palette" && isTextInput(sequence)) {
    if (sequence === "\x7f" || sequence === "\b") {
      state.paletteQuery = state.paletteQuery.slice(0, -1);
    } else {
      state.paletteQuery += sequence;
    }
    state.paletteIndex = 0;
    actions.refresh();
    return true;
  }

  const command = v3CommandForKey(sequence, state);
  switch (command) {
    case "quit":
      actions.quit();
      return true;
    case "switch-route-1":
      switchRoute(state, "fleet");
      break;
    case "switch-route-2":
      switchRoute(state, "map");
      break;
    case "switch-route-3":
      switchRoute(state, "limits");
      break;
    case "switch-route-4":
      switchRoute(state, "uplink");
      break;
    case "switch-route-5":
      switchRoute(state, "alerts");
      break;
    case "select-next":
      moveSelection(state, 1);
      break;
    case "select-prev":
      moveSelection(state, -1);
      break;
    case "map-left":
      moveFleetSelection(state, -1);
      break;
    case "map-right":
      moveFleetSelection(state, 1);
      break;
    case "open-answer":
      openAnswer(state);
      break;
    case "open-kill-confirm":
      openKillConfirm(state);
      break;
    case "toggle-drawer-focus":
      toggleDrawerFocus(state);
      break;
    case "toggle-drawer-focus-prev":
      toggleDrawerFocus(state);
      break;
    case "toggle-drawer":
      state.drawerOpen = !state.drawerOpen;
      if (!state.drawerOpen) {
        state.drawerFocused = false;
      }
      break;
    case "open-palette":
      state.mode = "palette";
      state.paletteQuery = "";
      state.paletteIndex = 0;
      break;
    case "toggle-status-group":
      toggleStatusGroup(state);
      break;
    case "jump-top":
      jump(state, "top");
      break;
    case "jump-bottom":
      jump(state, "bottom");
      break;
    case "page-up":
      page(state, -10);
      break;
    case "page-down":
      page(state, 10);
      break;
    case "log-bottom":
      state.logOffset = 0;
      state.forceLogRefresh = true;
      break;
    case "jump-error":
      jumpPreviousError(state);
      break;
    case "cycle-theme":
      cycleTheme(state);
      break;
    case "refresh":
      state.forceLogRefresh = true;
      pushToast(state, "Refreshed", "info");
      break;
    case "help":
      state.mode = "help";
      break;
    case "confirm-kill":
      confirmKill(state, actions);
      break;
    case "palette-move-up":
      state.paletteIndex = Math.max(0, state.paletteIndex - 1);
      break;
    case "palette-move-down":
      state.paletteIndex = Math.min(Math.max(0, filteredPaletteCount(state) - 1), state.paletteIndex + 1);
      break;
    case "palette-run":
      runPalette(state, actions);
      break;
    case "palette-close":
      state.mode = "normal";
      state.paletteQuery = "";
      state.paletteIndex = 0;
      break;
    case "submit-answer":
      submitAnswer(state, actions);
      break;
    case "cancel":
      cancel(state);
      break;
    case "noop":
      return false;
  }
  actions.refresh();
  return true;
}

// --- helpers -------------------------------------------------------------

function selectedPeer(state: RuntimeStateV3): DashboardPeerRow | undefined {
  return state.visiblePeers.find((peer) => peer.id === state.selectedPeerId);
}

function switchRoute(state: RuntimeStateV3, route: V3Route): void {
  state.route = route;
  state.focusChangedAt = Date.now();
}

function moveSelection(state: RuntimeStateV3, direction: 1 | -1): void {
  if (state.drawerFocused) {
    scrollLogs(state, direction === -1 ? "older" : "newer", 1);
    return;
  }
  state.selectedIndex += direction;
  state.selectedPeerId = undefined;
  state.logOffset = 0;
  state.followSelectedPeer = true;
}

// MAP-route column nav (h/l): move selection horizontally across projects on the fleet grid.
function moveFleetSelection(state: RuntimeStateV3, dx: -1 | 1): void {
  if (state.visiblePeers.length === 0) {
    return;
  }
  const selected = state.visiblePeers.find((peer) => peer.id === state.selectedPeerId) || state.visiblePeers[0];
  const projects = Array.from(new Set(state.visiblePeers.map((peer) => peer.project))).sort((a, b) => a.localeCompare(b));
  const stages = ["spawn", "work", "wait", "integrate", "done"] as const;
  let projectIndex = Math.max(0, projects.indexOf(selected.project));
  const stageIndex = Math.max(0, stages.indexOf(fleetStageForStatus(selected.status)));
  for (let attempts = 0; attempts < projects.length; attempts += 1) {
    const next = projectIndex + dx;
    if (next < 0 || next >= projects.length) {
      break;
    }
    projectIndex = next;
    const peer = state.visiblePeers.find(
      (candidate) => candidate.project === projects[projectIndex] && fleetStageForStatus(candidate.status) === stages[stageIndex],
    ) || state.visiblePeers.find((candidate) => candidate.project === projects[projectIndex]);
    if (peer) {
      state.selectedPeerId = peer.id;
      state.selectedIndex = peer.index;
      state.logOffset = 0;
      state.followSelectedPeer = true;
      return;
    }
  }
}

function scrollLogs(state: RuntimeStateV3, direction: "older" | "newer", amount: number): void {
  state.logOffset = direction === "older" ? state.logOffset + amount : Math.max(0, state.logOffset - amount);
  if (state.logOffset === 0) {
    state.forceLogRefresh = true;
  }
}

function page(state: RuntimeStateV3, amount: number): void {
  if (state.drawerFocused) {
    scrollLogs(state, amount < 0 ? "older" : "newer", Math.abs(amount));
    return;
  }
  state.peerOffset = Math.max(0, state.peerOffset + amount);
  state.followSelectedPeer = false;
}

function jump(state: RuntimeStateV3, target: "top" | "bottom"): void {
  if (state.drawerFocused) {
    state.logOffset = target === "top" ? Number.MAX_SAFE_INTEGER : 0;
    state.forceLogRefresh = target === "bottom";
    return;
  }
  state.peerOffset = target === "top" ? 0 : Number.MAX_SAFE_INTEGER;
  state.followSelectedPeer = false;
}

function toggleDrawerFocus(state: RuntimeStateV3): void {
  state.drawerFocused = !state.drawerFocused;
  if (state.drawerFocused) {
    state.drawerOpen = true;
  }
  state.focusChangedAt = Date.now();
}

function toggleStatusGroup(state: RuntimeStateV3): void {
  const status = selectedPeer(state)?.status;
  if (!status) {
    return;
  }
  state.collapsedStatuses[status] = !state.collapsedStatuses[status];
}

function jumpPreviousError(state: RuntimeStateV3): void {
  const index = state.logEventLevels
    .map((level, eventIndex) => ({ level, eventIndex }))
    .reverse()
    .find((event) => event.level === "error")?.eventIndex;
  if (index === undefined) {
    pushToast(state, "No error event in log buffer", "info");
    return;
  }
  state.logOffset = Math.max(0, state.logEventLevels.length - index - 1);
  state.drawerOpen = true;
  state.drawerFocused = true;
}

export function cycleTheme(state: RuntimeStateV3): void {
  state.theme = state.theme === cyberpunkTheme ? defaultTheme : cyberpunkTheme;
  pushToast(state, `Theme: ${state.theme === cyberpunkTheme ? "cyberpunk" : "default"}`, "info");
}

function openKillConfirm(state: RuntimeStateV3): void {
  const peer = selectedPeer(state);
  if (!peer) {
    pushToast(state, "No peer selected", "info");
    return;
  }
  state.pendingPeerId = peer.id;
  state.mode = "kill-confirm";
}

function openAnswer(state: RuntimeStateV3): void {
  const peer = selectedPeer(state);
  if (!peer) {
    pushToast(state, "No peer selected", "info");
    return;
  }
  if (peer.status !== "waiting") {
    pushToast(state, `Peer ${peer.id} is not waiting`, "info");
    return;
  }
  state.pendingPeerId = peer.id;
  state.mode = "answer";
  state.answerInput = "";
}

function confirmKill(state: RuntimeStateV3, actions: DashboardV3Actions): void {
  const peerId = state.pendingPeerId;
  if (!peerId) {
    closePending(state);
    return;
  }
  try {
    const killed = actions.killPeer(peerId);
    pushToast(state, `Killed ${killed.id}`, "info");
  } catch (error) {
    pushToast(state, error instanceof Error ? error.message : String(error), "error");
  }
  closePending(state);
}

function submitAnswer(state: RuntimeStateV3, actions: DashboardV3Actions): void {
  const peerId = state.pendingPeerId;
  if (!peerId) {
    closePending(state);
    return;
  }
  const text = state.answerInput.trim();
  if (!text) {
    pushToast(state, "Reply is empty", "info");
    return;
  }
  try {
    const peer = actions.sendPeerReply(peerId, text);
    pushToast(state, `Reply sent to ${peer.id}`, "info");
    closePending(state);
  } catch (error) {
    pushToast(state, error instanceof Error ? error.message : String(error), "error");
  }
}

function closePending(state: RuntimeStateV3): void {
  state.mode = "normal";
  state.pendingPeerId = undefined;
  state.answerInput = "";
}

function cancel(state: RuntimeStateV3): void {
  state.mode = "normal";
  state.pendingPeerId = undefined;
  state.answerInput = "";
}

// --- palette -------------------------------------------------------------

export type PaletteEntry = {
  label: string;
  run: (state: RuntimeStateV3, actions: DashboardV3Actions) => void;
};

const TERMINAL_STATUSES = new Set<DashboardStatus>(["done", "failed", "killed", "gsd_completed", "gsd_failed"]);

export function paletteEntries(state: RuntimeStateV3): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const peer of state.visiblePeers) {
    const id = peer.id;
    entries.push({
      label: `▸ ${id} · ${peer.status} · ${peer.project}`,
      run: (s) => {
        s.selectedPeerId = id;
        s.selectedIndex = peer.index;
      },
    });
  }
  for (const peer of state.visiblePeers.filter((p) => p.status === "waiting")) {
    const id = peer.id;
    entries.push({
      label: `↳ answer ${id}`,
      run: (s) => {
        s.selectedPeerId = id;
        s.selectedIndex = peer.index;
        openAnswer(s);
      },
    });
  }
  for (const peer of state.visiblePeers.filter((p) => !TERMINAL_STATUSES.has(p.status))) {
    const id = peer.id;
    entries.push({
      label: `✕ kill ${id}`,
      run: (s) => {
        s.selectedPeerId = id;
        s.selectedIndex = peer.index;
        openKillConfirm(s);
      },
    });
  }
  for (const route of V3_ROUTES) {
    entries.push({ label: `route ${route}`, run: (s) => switchRoute(s, route) });
  }
  entries.push({ label: "◐ theme", run: (s) => cycleTheme(s) });
  entries.push({ label: "⟳ refresh", run: (s, a) => { s.forceLogRefresh = true; pushToast(s, "Refreshed", "info"); a.refresh(); } });
  entries.push({ label: "? help", run: (s) => { s.mode = "help"; } });
  entries.push({ label: "q quit", run: (_s, a) => a.quit() });
  return entries;
}

export function filterPalette(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.toLowerCase();
  if (!needle) {
    return entries;
  }
  return entries.filter((entry) => isSubsequence(needle, entry.label.toLowerCase()));
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

function filteredPaletteCount(state: RuntimeStateV3): number {
  return filterPalette(paletteEntries(state), state.paletteQuery).length;
}

function runPalette(state: RuntimeStateV3, actions: DashboardV3Actions): void {
  const entries = filterPalette(paletteEntries(state), state.paletteQuery);
  const entry = entries[state.paletteIndex];
  state.mode = "normal";
  state.paletteQuery = "";
  state.paletteIndex = 0;
  if (entry) {
    entry.run(state, actions);
  }
}

// --- toasts --------------------------------------------------------------

export function pushToast(state: RuntimeStateV3, text: string, level: "info" | "error" = "info"): void {
  state.toasts.push({ text, level, createdAt: Date.now() });
  if (state.toasts.length > 3) {
    state.toasts = state.toasts.slice(-3);
  }
}

export function expireToasts(state: RuntimeStateV3, nowMs: number): void {
  state.toasts = state.toasts.filter((toast) => nowMs - toast.createdAt <= 3000);
}

function isTextInput(sequence: string): boolean {
  return (sequence.length === 1 && sequence >= " " && sequence !== "\x7f") || sequence === "\x7f" || sequence === "\b";
}

export function initialRuntimeStateV3(theme: Theme): RuntimeStateV3 {
  return {
    route: "fleet",
    drawerOpen: true,
    drawerFocused: false,
    paletteQuery: "",
    paletteIndex: 0,
    toasts: [],
    selectedIndex: 0,
    peerOffset: 0,
    logOffset: 0,
    collapsedStatuses: {},
    followSelectedPeer: true,
    forceLogRefresh: false,
    visiblePeers: [],
    logEventLevels: [],
    theme,
    answerInput: "",
    mode: "normal",
  };
}
