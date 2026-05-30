import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { peersHome } from "./paths.js";

export type SupervisorTelegramLevel = "unknown" | "pending" | "sent" | "waiting" | "halted";

export type SupervisorTelegramStatus = {
  level: SupervisorTelegramLevel;
  icon: string;
  label: string;
  roadmap?: string;
  stateDir?: string;
  sliceId?: string;
  currentPeerId?: string;
  mergeBranch?: string;
  lastNotification?: string;
  haltedReason?: string;
  latestLogAt?: string;
};

type AutopilotState = {
  halted?: boolean;
  halted_reason?: string | null;
  current_slice_id?: string;
  current_peer_id?: string;
  current_merge_branch?: string;
  notified_events?: string[];
  history?: Array<{
    slice_id?: string;
    peer_id?: string;
    merge_branch?: string;
    outcome?: string | null;
  }>;
};

export function readSupervisorTelegramStatus(
  peerId: string | undefined,
  options: { home?: string; now?: Date } = {},
): SupervisorTelegramStatus {
  if (!peerId) {
    return unknownStatus("No peer selected");
  }
  const match = matchingAutopilotStates(options.home || peersHome(), peerId)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .at(-1);
  if (!match) {
    return unknownStatus("No supervisor match");
  }

  const relevantHistory = [...(match.state.history || [])].reverse().find((entry) => entry.peer_id === peerId);
  const lastNotification = lastRelevantNotification(match.state.notified_events || [], peerId);
  const level = supervisorLevel(match.state, peerId, lastNotification);
  const latestLogAt = latestSupervisorLogAt(match.dir);
  const label = supervisorLabel(level, lastNotification);

  return {
    level,
    icon: supervisorIcon(level),
    label,
    roadmap: match.roadmap,
    stateDir: match.dir,
    sliceId: peerId === match.state.current_peer_id ? match.state.current_slice_id : relevantHistory?.slice_id,
    currentPeerId: match.state.current_peer_id,
    mergeBranch: peerId === match.state.current_peer_id ? match.state.current_merge_branch : relevantHistory?.merge_branch,
    lastNotification,
    haltedReason: match.state.halted_reason || undefined,
    latestLogAt,
  };
}

export function formatSupervisorTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "-";
  }
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function matchingAutopilotStates(home: string, peerId: string): Array<{ roadmap: string; dir: string; state: AutopilotState; mtimeMs: number }> {
  if (!existsSync(home)) {
    return [];
  }
  const matches = [];
  for (const entry of safeReadDir(home)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(home, entry.name);
    const statePath = join(dir, "state.json");
    if (!existsSync(statePath)) {
      continue;
    }
    const state = readState(statePath);
    if (!state || !isAutopilotState(state)) {
      continue;
    }
    const currentMatch = state.current_peer_id === peerId;
    const historyMatch = Boolean(state.history?.some((history) => history.peer_id === peerId));
    if (currentMatch || historyMatch) {
      matches.push({ roadmap: entry.name, dir, state, mtimeMs: statSync(statePath).mtimeMs });
    }
  }
  return matches;
}

function readState(statePath: string): AutopilotState | undefined {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as AutopilotState;
  } catch {
    return undefined;
  }
}

function isAutopilotState(state: AutopilotState): boolean {
  return Array.isArray(state.history) || Array.isArray(state.notified_events) || typeof state.current_peer_id === "string";
}

function lastRelevantNotification(events: string[], peerId: string): string | undefined {
  return [...events].reverse().find((event) => event.includes(peerId) || event === "roadmap-complete");
}

function supervisorLevel(state: AutopilotState, peerId: string, lastNotification: string | undefined): SupervisorTelegramLevel {
  if (state.halted && state.halted_reason) {
    return "halted";
  }
  if (!lastNotification) {
    return state.current_peer_id === peerId ? "pending" : "unknown";
  }
  if (lastNotification.startsWith(`waiting:${peerId}:`)) {
    return "waiting";
  }
  if (
    lastNotification.startsWith(`failed:${peerId}`)
    || lastNotification.startsWith(`frozen:${peerId}`)
    || lastNotification.startsWith(`killed:${peerId}`)
    || lastNotification.startsWith(`merge-failed:${peerId}`)
  ) {
    return "halted";
  }
  return "sent";
}

function supervisorIcon(level: SupervisorTelegramLevel): string {
  switch (level) {
    case "sent":
      return "✅";
    case "pending":
      return "⏳";
    case "waiting":
      return "⚠️";
    case "halted":
      return "🛑";
    case "unknown":
      return "❔";
  }
}

function supervisorLabel(level: SupervisorTelegramLevel, lastNotification: string | undefined): string {
  switch (level) {
    case "sent":
      return lastNotification ? `notified: ${lastNotification}` : "notified";
    case "pending":
      return "supervised, no notification yet";
    case "waiting":
      return "waiting notification sent";
    case "halted":
      return "halt notification sent";
    case "unknown":
      return "no supervisor notification";
  }
}

function latestSupervisorLogAt(stateDir: string): string | undefined {
  const logDir = join(stateDir, "logs");
  if (!existsSync(logDir)) {
    return undefined;
  }
  const log = safeReadDir(logDir)
    .filter((entry) => entry.isFile() && entry.name.startsWith("supervisor-") && entry.name.endsWith(".log"))
    .map((entry) => join(logDir, entry.name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .at(-1);
  if (!log) {
    return undefined;
  }
  try {
    const lines = readFileSync(log, "utf8").trim().split(/\r?\n/);
    const last = lines.at(-1);
    const match = last?.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function unknownStatus(label: string): SupervisorTelegramStatus {
  return {
    level: "unknown",
    icon: supervisorIcon("unknown"),
    label,
  };
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
