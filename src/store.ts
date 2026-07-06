import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function updatePeer(peerId: string, updater: (peer: PeerRecord) => PeerRecord): PeerRecord | undefined {
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
}

export function upsertPeer(peer: PeerRecord): void {
  const state = readState();
  const peers = state.peers.filter((existing) => existing.id !== peer.id);
  peers.unshift(peer);
  writeState({ ...state, peers });
}

export function getPeer(peerId: string): PeerRecord | undefined {
  return readState().peers.find((peer) => peer.id === peerId || peer.id.startsWith(peerId));
}
