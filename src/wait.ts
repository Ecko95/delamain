import { readStateFile } from "./store.js";
import type { PeerRecord, PeerState } from "./types.js";

export const WAIT_TERMINAL_STATUSES = new Set<string>([
  "done",
  "failed",
  "killed",
  "error",
  "merged",
  "integrated",
  "stopped",
  "waiting",
]);

export type WaitCommandOptions = {
  any?: boolean;
  intervalMs?: number;
  timeoutMs?: number;
  out?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_INTERVAL_MS = 15_000;

export function isTerminalWaitStatus(status: string): boolean {
  return WAIT_TERMINAL_STATUSES.has(status);
}

export async function runWaitCommand(peerIds: string[], options: WaitCommandOptions = {}): Promise<number> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? 0;
  const any = options.any ?? false;
  const out = options.out ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? delay;
  const nowMs = options.now ?? (() => Date.now());
  const startedAt = nowMs();
  const lastStatuses = new Map<string, string>();

  if (peerIds.length === 0) {
    throw new Error(WAIT_USAGE);
  }

  for (;;) {
    const state = await readStateForWait(sleep, intervalMs, startedAt, timeoutMs, nowMs);
    const peers = resolvePeers(state, peerIds);

    for (const peer of peers) {
      if (lastStatuses.get(peer.id) !== peer.status) {
        lastStatuses.set(peer.id, peer.status);
        out(`[${new Date(nowMs()).toISOString()}] ${formatPeerSummary(peer)}`);
      }
    }

    const terminalCount = peers.filter((peer) => isTerminalWaitStatus(peer.status)).length;
    if ((any && terminalCount > 0) || (!any && terminalCount === peers.length)) {
      printCurrentStatuses(peers, out);
      return 0;
    }

    if (timeoutMs > 0 && nowMs() - startedAt >= timeoutMs) {
      printCurrentStatuses(peers, out);
      return 2;
    }

    const remainingMs = timeoutMs > 0 ? timeoutMs - (nowMs() - startedAt) : intervalMs;
    await sleep(Math.max(1, Math.min(intervalMs, remainingMs)));
  }
}

export function formatPeerSummary(peer: PeerRecord): string {
  return `${peer.id}\t${peer.name || "-"}\t${peer.status}\t${peer.lastEvent || "-"}`;
}

async function readStateForWait(
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  startedAt: number,
  timeoutMs: number,
  nowMs: () => number,
): Promise<PeerState> {
  for (;;) {
    try {
      return readStateFile();
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      // ponytail: malformed JSON is assumed to be a mid-write state file; no
      // warning throttle or corruption diagnosis until a real operator needs it.
      if (timeoutMs > 0 && nowMs() - startedAt >= timeoutMs) {
        throw error;
      }
      await sleep(Math.max(1, Math.min(intervalMs, 1_000)));
    }
  }
}

function resolvePeers(state: PeerState, peerIds: string[]): PeerRecord[] {
  const peers = peerIds.map((id) => state.peers.find((peer) => peer.id === id || peer.id.startsWith(id)));
  const missing = peerIds.filter((_, index) => !peers[index]);
  if (missing.length > 0) {
    const known = state.peers.map((peer) => peer.id).join(", ") || "(none)";
    throw new Error(`Unknown peer id(s): ${missing.join(", ")}. Known peers: ${known}`);
  }
  // ponytail: prefix ambiguity intentionally mirrors the existing status CLI.
  return peers as PeerRecord[];
}

function printCurrentStatuses(peers: PeerRecord[], out: (line: string) => void): void {
  for (const peer of peers) {
    out(formatPeerSummary(peer));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const WAIT_USAGE =
  "Usage: delamain wait <peer-id...> [--interval <seconds>] [--timeout <seconds>] [--any]";
