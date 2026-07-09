import { mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { peersHome, statePath } from "./paths.js";
import { normalizePeerRecord } from "./types.js";
import type { PeerRecord, PeerState } from "./types.js";

const EMPTY_STATE: PeerState = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  peers: [],
};

export function ensureHome(): void {
  mkdirSync(peersHome(), { recursive: true });
  mkdirSync(dirname(statePath()), { recursive: true });
}

export function readState(): PeerState {
  ensureHome();
  try {
    return readStateFile();
  } catch {
    return { ...EMPTY_STATE, updatedAt: new Date().toISOString() };
  }
}

export function readStateFile(): PeerState {
  ensureHome();
  const raw = readFileSync(statePath(), "utf8");
  const parsed = JSON.parse(raw) as PeerState;
  if (parsed.version !== 1 || !Array.isArray(parsed.peers)) {
    throw new Error("Invalid delamain state file");
  }
  // Phase 33: normalize records on read so older on-disk state.json files
  // (which lack `kind`) come back with kind=="generic". Idempotent.
  return { ...parsed, peers: parsed.peers.map(normalizePeerRecord) };
}

export function writeState(state: PeerState): void {
  ensureHome();
  const next = { ...state, updatedAt: new Date().toISOString() };
  const target = statePath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

// ponytail: global state-write lock; shard per-peer if write throughput ever matters
const LOCK_STALE_MS = 5000; // far longer than any legit sub-ms read-modify-write hold
const LOCK_BACKOFF_MS = 5;
const LOCK_MAX_WAIT_MS = 10000;

function sync_sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serialize the cross-process read-modify-write critical section. All fs calls
// here are synchronous, so within one process this is already atomic; the lock
// only guards against other Node processes (CLI, MCP server, runner children).
export function withStateLock<T>(fn: () => T): T {
  const lock = `${statePath()}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(lock, "wx"));
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Stale-lock breaker: a holder that died mid-section (SIGKILL) leaks the
      // lockfile. Steal it if it is older than any legit hold could last.
      // ponytail: >LOCK_STALE_MS-paused holder (host suspend/debugger) can be
      // stolen; the sub-ms hold makes that practically unreachable.
      try {
        const mtime = statSync(lock).mtimeMs;
        // Re-stat immediately before unlink and steal only if it is still the
        // SAME stale lock — shrinks the window where we'd delete a successor's
        // fresh lock to two adjacent syscalls.
        if (Date.now() - mtime > LOCK_STALE_MS && statSync(lock).mtimeMs === mtime) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        // lock vanished between openSync and statSync — just retry
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring state lock: ${lock}`);
      }
      sync_sleep(LOCK_BACKOFF_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error; // ENOENT = lock was stolen by the stale-breaker; fine
      }
    }
  }
}

export function updatePeer(peerId: string, updater: (peer: PeerRecord) => PeerRecord): PeerRecord | undefined {
  return withStateLock(() => {
    const state = readState();
    let updated: PeerRecord | undefined;
    const peers = state.peers.map((peer) => {
      if (peer.id !== peerId) {
        return peer;
      }
      updated = updater(peer);
      return updated;
    });
    if (!updated) {
      return undefined;
    }
    writeState({ ...state, peers });
    return updated;
  });
}

export function upsertPeer(peer: PeerRecord): void {
  withStateLock(() => {
    const state = readState();
    const peers = state.peers.filter((existing) => existing.id !== peer.id);
    peers.unshift(peer);
    writeState({ ...state, peers });
  });
}

export function getPeer(peerId: string): PeerRecord | undefined {
  return readState().peers.find((peer) => peer.id === peerId || peer.id.startsWith(peerId));
}
