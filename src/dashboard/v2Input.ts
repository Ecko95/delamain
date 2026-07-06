import type { PeerRecord } from "../types.js";
import { commandForKey, type DashboardCommand } from "./keybindings.js";
import {
  fleetStageForStatus,
  type DashboardMode,
  type DashboardPeerRow,
  type DashboardStatus,
} from "./model.js";
import { cyberpunkTheme, defaultTheme, type Theme } from "./theme.js";

export type V2Pane = "overview" | "limits" | "telegram" | "warnings" | "peers" | "details" | "logs";

export type RuntimeState = {
  selectedIndex: number;
  selectedPeerId?: string;
  focusPane: V2Pane;
  mode: DashboardMode;
  message: string;
  answerInput: string;
  logOffset: number;
  peerOffset: number;
  collapsedStatuses: Partial<Record<DashboardStatus, boolean>>;
  collapsedPanes: Partial<Record<V2Pane, boolean>>;
  followSelectedPeer: boolean;
  forceLogRefresh: boolean;
  theme: Theme;
  visiblePeers: DashboardPeerRow[];
  logEventLevels: Array<"info" | "warn" | "error">;
};

export type DashboardV2Actions = {
  refresh: () => void;
  quit: () => void;
  killPeer: (peerId: string) => PeerRecord;
  sendPeerReply: (peerId: string, text: string) => PeerRecord;
};

const PANES: V2Pane[] = ["overview", "limits", "telegram", "warnings", "peers", "details", "logs"];

export function v2CommandForKey(sequence: string, state: RuntimeState): DashboardCommand {
  return commandForKey(sequence, state.mode, state.focusPane === "logs" ? "logs" : "peers");
}

export function handleDashboardV2Input(sequence: string, state: RuntimeState, actions: DashboardV2Actions): boolean {
  if (state.mode === "answer" && isTextInput(sequence)) {
    if (sequence === "\x7f" || sequence === "\b") {
      state.answerInput = state.answerInput.slice(0, -1);
    } else {
      state.answerInput += sequence;
    }
    actions.refresh();
    return true;
  }

  if (state.mode === "normal" && /^[1-7]$/.test(sequence)) {
    togglePane(state, PANES[Number(sequence) - 1]);
    actions.refresh();
    return true;
  }

  const command = v2CommandForKey(sequence, state);
  switch (command) {
    case "quit":
      actions.quit();
      return true;
    case "focus-next":
      focusPane(state, 1);
      break;
    case "focus-prev":
      focusPane(state, -1);
      break;
    case "toggle-status-group":
      togglePane(state, state.focusPane);
      break;
    case "select-next":
      moveFocused(state, 1);
      break;
    case "select-prev":
      moveFocused(state, -1);
      break;
    case "select-left":
      moveFleetSelection(state, -1, 0);
      break;
    case "select-right":
      moveFleetSelection(state, 1, 0);
      break;
    case "page-log-down":
      pageFocused(state, 10);
      break;
    case "page-log-up":
      pageFocused(state, -10);
      break;
    case "jump-top":
      jumpFocused(state, "top");
      break;
    case "jump-bottom":
      jumpFocused(state, "bottom");
      break;
    case "log-bottom":
      state.logOffset = 0;
      state.forceLogRefresh = true;
      state.message = "Logs: latest";
      break;
    case "refresh":
      state.forceLogRefresh = true;
      state.message = "Refreshed";
      break;
    case "cycle-theme":
      cycleTheme(state);
      break;
    case "enter-kill-mode":
      state.mode = "kill-confirm";
      state.message = "Kill selected peer? enter confirms, escape cancels";
      break;
    case "confirm-kill":
      confirmKill(state, actions.killPeer);
      break;
    case "enter-answer-mode":
      enterAnswerMode(state);
      break;
    case "submit-answer":
      submitAnswer(state, actions.sendPeerReply);
      break;
    case "jump-error":
      jumpPreviousError(state);
      break;
    case "help":
      state.mode = "help";
      state.message = "Help";
      break;
    case "cancel-mode":
      state.mode = "normal";
      state.answerInput = "";
      state.message = "Cancelled";
      break;
    case "toggle-details":
    case "scroll-log-down":
    case "scroll-log-up":
    case "noop":
      if (command === "scroll-log-down") {
        scrollLogs(state, "newer", 1);
      } else if (command === "scroll-log-up") {
        scrollLogs(state, "older", 1);
      } else if (command === "noop") {
        return false;
      }
      break;
  }
  actions.refresh();
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

export function initialThemeFromEnv(themeName: string | undefined = process.env.DELAMAIN_THEME): Theme {
  return themeName === "default" ? defaultTheme : cyberpunkTheme;
}

export function cycleTheme(state: RuntimeState): void {
  state.theme = state.theme === cyberpunkTheme ? defaultTheme : cyberpunkTheme;
  state.message = `Theme: ${state.theme === cyberpunkTheme ? "cyberpunk" : "default"}`;
}

function moveFocused(state: RuntimeState, direction: 1 | -1): void {
  if (state.focusPane === "logs") {
    scrollLogs(state, direction === -1 ? "older" : "newer", 1);
    return;
  }
  if (state.focusPane === "overview") {
    moveFleetSelection(state, 0, direction);
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

function moveFleetSelection(state: RuntimeState, dx: -1 | 0 | 1, dy: -1 | 0 | 1): void {
  if (state.visiblePeers.length === 0) {
    state.message = "No peers";
    return;
  }
  const selected = state.visiblePeers.find((peer) => peer.id === state.selectedPeerId) || state.visiblePeers[0];
  const projects = Array.from(new Set(state.visiblePeers.map((peer) => peer.project))).sort((a, b) => a.localeCompare(b));
  const stages = ["spawn", "work", "wait", "integrate", "done"] as const;
  let projectIndex = Math.max(0, projects.indexOf(selected.project));
  let stageIndex = Math.max(0, stages.indexOf(fleetStageForStatus(selected.status)));
  for (let attempts = 0; attempts < projects.length * stages.length; attempts += 1) {
    projectIndex = clamp(projectIndex + dx, 0, Math.max(0, projects.length - 1));
    stageIndex = clamp(stageIndex + dy, 0, stages.length - 1);
    const peer = state.visiblePeers.find((candidate) => (
      candidate.project === projects[projectIndex] && fleetStageForStatus(candidate.status) === stages[stageIndex]
    ));
    if (peer) {
      state.selectedPeerId = peer.id;
      state.selectedIndex = peer.index;
      state.logOffset = 0;
      state.followSelectedPeer = true;
      state.message = `Selected ${peer.id}`;
      return;
    }
    if (dx === 0 && dy === 0) {
      break;
    }
    if ((dx < 0 && projectIndex === 0) || (dx > 0 && projectIndex === projects.length - 1) || (dy < 0 && stageIndex === 0) || (dy > 0 && stageIndex === stages.length - 1)) {
      break;
    }
  }
}

function enterAnswerMode(state: RuntimeState): void {
  const selected = state.visiblePeers.find((peer) => peer.id === state.selectedPeerId);
  if (!selected) {
    state.message = "No peer selected";
    return;
  }
  if (selected.status !== "waiting") {
    state.message = `Peer ${selected.id} is not waiting`;
    return;
  }
  state.mode = "answer";
  state.answerInput = "";
  state.message = `Reply to ${selected.id}: enter sends, escape cancels`;
}

function submitAnswer(state: RuntimeState, sendPeerReply: (peerId: string, text: string) => PeerRecord): void {
  if (!state.selectedPeerId) {
    state.message = "No peer selected";
    state.mode = "normal";
    return;
  }
  const text = state.answerInput.trim();
  if (!text) {
    state.message = "Reply is empty";
    return;
  }
  try {
    const peer = sendPeerReply(state.selectedPeerId, text);
    state.message = `Sent reply to ${peer.id}`;
    state.mode = "normal";
    state.answerInput = "";
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
  }
}

function jumpPreviousError(state: RuntimeState): void {
  const index = state.logEventLevels.map((level, eventIndex) => ({ level, eventIndex })).reverse().find((event) => event.level === "error")?.eventIndex;
  if (index === undefined) {
    state.message = "No error event in log buffer";
    return;
  }
  state.logOffset = Math.max(0, state.logEventLevels.length - index - 1);
  state.focusPane = "logs";
  state.message = "Jumped to previous error";
}

function confirmKill(state: RuntimeState, killSelectedPeer: (peerId: string) => PeerRecord): void {
  if (!state.selectedPeerId) {
    state.message = "No peer selected";
    state.mode = "normal";
    return;
  }
  try {
    const killed = killSelectedPeer(state.selectedPeerId);
    state.message = `Killed ${killed.id}`;
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
  }
  state.mode = "normal";
}

function isTextInput(sequence: string): boolean {
  return (sequence.length === 1 && sequence >= " " && sequence !== "\x7f") || sequence === "\x7f" || sequence === "\b";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
