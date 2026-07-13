import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { archivePath } from "./paths.js";
import { readState, writeState } from "./store.js";
import { TERMINAL_PEER_STATUSES } from "./types.js";
import type { PeerRecord, PeerState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Pid-expected peer with a dead pid and no heartbeat for this long => failed.
const DEAD_AFTER_MS = 6 * 60 * 60 * 1000;

// Statuses where a live pid is EXPECTED (mirrors peerManager's isActive).
// waiting/idle peers persist their status as the process exits by design, and
// GSD-kind peers carry no pids/heartbeats at all — never dead-mark those.
const PID_EXPECTED_STATUSES = new Set<string>(["starting", "working"]);

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

function lastSeenStamp(peer: PeerRecord): string {
  return peer.lastHeartbeatAt ?? peer.finishedAt ?? peer.updatedAt;
}

function lastSeenMs(peer: PeerRecord): number {
  const ms = Date.parse(lastSeenStamp(peer));
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
 * than the cutoff move to state.archive.json; (2) pid-expected peers (starting/
 * working, non-GSD) whose pids are all dead and whose heartbeat is stale get
 * marked failed (archived on the NEXT sweep once they age past the cutoff).
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
  // ponytail: conservative across one sweep; a peer referenced only by another
  // peer archived this round survives until the next sweep, which converges.
  const referencedIds = new Set(state.peers.flatMap((peer) => peer.dependsOn ?? []));

  for (const peer of state.peers) {
    if (
      TERMINAL_PEER_STATUSES.has(peer.status) &&
      lastSeenMs(peer) < cutoffMs &&
      !referencedIds.has(peer.id) &&
      peer.integrationStatus !== "pushed"
    ) {
      archived.push(peer);
      continue;
    }
    const pidExpected = PID_EXPECTED_STATUSES.has(peer.status) && peer.kind !== "gsd_phase_batch";
    if (pidExpected && !anyPidAlive(peer) && nowMs - lastSeenMs(peer) > DEAD_AFTER_MS) {
      const dead: PeerRecord = {
        ...peer,
        status: "failed",
        error: `swept: no live pids and no heartbeat since ${lastSeenStamp(peer)}`,
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
