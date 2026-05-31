import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { archiveStatePath, peersHome, statePath } from "./paths.js";
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
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as PeerState;
    if (parsed.version !== 1 || !Array.isArray(parsed.peers)) {
      return { ...EMPTY_STATE, updatedAt: new Date().toISOString() };
    }
    // Phase 33: normalize records on read so older on-disk state.json files
    // (which lack `kind`) come back with kind=="generic". Idempotent.
    return { ...parsed, peers: parsed.peers.map(normalizePeerRecord) };
  } catch {
    return { ...EMPTY_STATE, updatedAt: new Date().toISOString() };
  }
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

// --- Archive -----------------------------------------------------------------
// Archived peers are moved out of state.json into state.archive.json so they
// drop off the live list and dashboard while staying fully recoverable.

const EMPTY_ARCHIVE: PeerState = {
  version: 1,
  updatedAt: new Date(0).toISOString(),
  peers: [],
};

export function readArchive(): PeerState {
  ensureHome();
  try {
    const raw = readFileSync(archiveStatePath(), "utf8");
    const parsed = JSON.parse(raw) as PeerState;
    if (parsed.version !== 1 || !Array.isArray(parsed.peers)) {
      return { ...EMPTY_ARCHIVE, updatedAt: new Date().toISOString() };
    }
    return { ...parsed, peers: parsed.peers.map(normalizePeerRecord) };
  } catch {
    return { ...EMPTY_ARCHIVE, updatedAt: new Date().toISOString() };
  }
}

export function writeArchive(state: PeerState): void {
  ensureHome();
  const next = { ...state, updatedAt: new Date().toISOString() };
  const target = archiveStatePath();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

export function readArchivedPeers(): PeerRecord[] {
  return readArchive().peers;
}

/**
 * Move the peers whose ids are in `ids` out of live state and into the archive,
 * stamping each with `archived`/`archivedAt`. Returns the ids actually moved and
 * any ids that matched no live peer. Idempotent for already-archived ids.
 */
export function archivePeersByIds(ids: string[]): { archived: string[]; missing: string[] } {
  const idSet = new Set(ids);
  const state = readState();
  const moving = state.peers.filter((peer) => idSet.has(peer.id));
  if (moving.length === 0) {
    return { archived: [], missing: ids };
  }
  const movedIds = new Set(moving.map((peer) => peer.id));
  const remaining = state.peers.filter((peer) => !movedIds.has(peer.id));
  const missing = ids.filter((id) => !movedIds.has(id));
  const archivedAt = new Date().toISOString();
  const stamped = moving.map((peer) => ({ ...peer, archived: true, archivedAt }));
  const archive = readArchive();
  const dedupedExisting = archive.peers.filter((peer) => !movedIds.has(peer.id));
  writeArchive({ ...archive, peers: [...stamped, ...dedupedExisting] });
  writeState({ ...state, peers: remaining });
  return { archived: moving.map((peer) => peer.id), missing };
}

/**
 * Move archived peers back into live state, clearing the archive flags. Returns
 * the ids restored and any ids that matched no archived peer.
 */
export function unarchivePeersByIds(ids: string[]): { restored: string[]; missing: string[] } {
  const idSet = new Set(ids);
  const archive = readArchive();
  const moving = archive.peers.filter((peer) => idSet.has(peer.id));
  if (moving.length === 0) {
    return { restored: [], missing: ids };
  }
  const movedIds = new Set(moving.map((peer) => peer.id));
  const remaining = archive.peers.filter((peer) => !movedIds.has(peer.id));
  const missing = ids.filter((id) => !movedIds.has(id));
  const state = readState();
  const restored = moving.map(({ archived: _archived, archivedAt: _archivedAt, ...rest }) => rest as PeerRecord);
  const dedupedExisting = state.peers.filter((peer) => !movedIds.has(peer.id));
  writeState({ ...state, peers: [...restored, ...dedupedExisting] });
  writeArchive({ ...archive, peers: remaining });
  return { restored: moving.map((peer) => peer.id), missing };
}
