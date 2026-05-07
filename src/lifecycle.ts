import { readFileSync } from "node:fs";
import { parseCodexJsonLine } from "./codexEvents.js";
import type { ParsedCodexEvent } from "./codexEvents.js";
import type { PeerRecord } from "./types.js";

export type TerminalResponseState = {
  sawAgentMessage: boolean;
  waitingQuestion?: string;
};

export function initialTerminalResponseState(): TerminalResponseState {
  return { sawAgentMessage: false };
}

export function updateTerminalResponseState(
  state: TerminalResponseState,
  parsed: ParsedCodexEvent,
): TerminalResponseState {
  if (!parsed.isAgentMessage) {
    return state;
  }
  return {
    sawAgentMessage: true,
    waitingQuestion: parsed.waitingQuestion,
  };
}

export function terminalResponseStateFromLog(text: string): TerminalResponseState {
  let state = initialTerminalResponseState();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("[codex-peers]") || line.startsWith("[stderr]")) {
      continue;
    }
    state = updateTerminalResponseState(state, parseCodexJsonLine(line));
  }
  return state;
}

export function reconcileFinishedWaitingPeer(peer: PeerRecord): PeerRecord {
  if (!isPossiblyStaleWaitingPeer(peer)) {
    return peer;
  }

  const terminal = terminalResponseFromPeerLog(peer);
  if (!terminal?.sawAgentMessage || terminal.waitingQuestion) {
    return peer;
  }

  return {
    ...peer,
    status: "done",
    question: undefined,
    lastEvent: "codex exited code=0; stale waiting status reconciled",
  };
}

function isPossiblyStaleWaitingPeer(peer: PeerRecord): boolean {
  return peer.status === "waiting" && Boolean(peer.finishedAt) && peer.exitCode === 0;
}

function terminalResponseFromPeerLog(peer: PeerRecord): TerminalResponseState | undefined {
  try {
    return terminalResponseStateFromLog(readFileSync(peer.logPath, "utf8"));
  } catch {
    return undefined;
  }
}
