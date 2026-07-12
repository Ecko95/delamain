import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { archivePath } from "./paths.js";
import { readState, writeState } from "./store.js";
import type { PeerRecord, PeerState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Non-terminal peer with a dead pid and no heartbeat for this long => failed.
const DEAD_AFTER_MS = 6 * 60 * 60 * 1000;

// Matches the dashboard's terminal set (src/dashboard/v3Input.ts).
const TERMINAL_STATUSES = new Set(["done", "failed", "killed", "gsd_completed", "gsd_failed"]);

export type SweepOptions = {
  nowMs?: number;
  olderThanDays?: number;
  dryRun?: boolean;
};

export type SweepResult = {
  archived: PeerRecord[];
  markedDead: PeerRecord[];
  kept: number;
};

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lastSeenMs(peer: PeerRecord): number {
  const stamp = peer.lastHeartbeatAt ?? peer.finishedAt ?? peer.updatedAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : 0;
}

function anyPidAlive(peer: PeerRecord): boolean {
  return pidAlive(peer.runnerPid) || pidAlive(peer.codexPid) || pidAlive(peer.enginePid);
}

function appendToArchive(peers: PeerRecord[]): void {
  const target = archivePath();
  let archive: PeerState = { version: 1, updatedAt: new Date().toISOString(), peers: [] };
  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as PeerState;
      if (!Array.isArray(parsed.peers)) throw new Error("unexpected archive shape");
      archive = parsed;
    } catch {
      // Corrupt/unrecognized archive: keep it aside rather than destroy history.
      renameSync(target, `${target}.corrupt-${Date.now()}`);
    }
  }
  archive.peers.push(...peers);
  archive.updatedAt = new Date().toISOString();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/**
 * Citadel core/coordination/sweep.js pattern, adapted: (1) terminal peers older
 * than the cutoff move to state.archive.json; (2) non-terminal peers whose pids
 * are all dead and whose heartbeat is stale get marked failed (archived on the
 * NEXT sweep once they age past the cutoff).
 *
 * ponytail: no state lock — the repo has none; read-modify-write with atomic
 * rename matches store.ts's updatePeer/upsertPeer. Add locking store-wide if
 * concurrent writers ever bite.
 */
export function sweepPeers(options: SweepOptions = {}): SweepResult {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (options.olderThanDays ?? 7) * DAY_MS;

  const state = readState();
  const archived: PeerRecord[] = [];
  const markedDead: PeerRecord[] = [];
  const kept: PeerRecord[] = [];

  for (const peer of state.peers) {
    const terminal = TERMINAL_STATUSES.has(peer.status);
    if (terminal && lastSeenMs(peer) < cutoffMs) {
      archived.push(peer);
      continue;
    }
    if (!terminal && !anyPidAlive(peer) && nowMs - lastSeenMs(peer) > DEAD_AFTER_MS) {
      const dead: PeerRecord = {
        ...peer,
        status: "failed",
        error: `swept: no live pids and no heartbeat since ${peer.lastHeartbeatAt ?? peer.updatedAt}`,
        finishedAt: peer.finishedAt ?? new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
      markedDead.push(dead);
      kept.push(dead);
      continue;
    }
    kept.push(peer);
  }

  if (!options.dryRun) {
    if (archived.length) appendToArchive(archived);
    if (archived.length || markedDead.length) {
      writeState({ ...state, peers: kept });
    }
  }
  return { archived, markedDead, kept: kept.length };
}
