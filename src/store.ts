// src/store.ts
//
// SP1 wave 3 — peer/workflow state on SQLite (node:sqlite, built-in on Node
// 24; no native dep). Replaces the previous whole-file read-modify-write on
// state.json, which lost updates when the workflow runner and N detached leaf
// runners wrote concurrently (design §8).
//
// The public API (readState/readStateFile/writeState/updatePeer/upsertPeer/
// getPeer/ensureHome) is byte-for-byte the same shape callers relied on, so
// peerManager/gsdRunner/cli/mcp/dashboard are untouched. Internally:
//   - each peer is one row (id PK + full JSON blob), so single-peer writes are
//     independent — no cross-peer clobbering;
//   - every mutation runs in its own IMMEDIATE transaction; WAL + busy_timeout
//     serialize multi-process writers with no lost updates;
//   - a one-time migration imports any existing state.json (kept as .bak).

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { peersHome, stateDbPath, statePath } from "./paths.js";
import { normalizePeerRecord } from "./types.js";
import type { PeerRecord, PeerState } from "./types.js";

const STATE_VERSION = 1;

export function ensureHome(): void {
  mkdirSync(peersHome(), { recursive: true });
  mkdirSync(dirname(stateDbPath()), { recursive: true });
  db();
}

// One cached connection per DB path. Tests switch CODEX_PEERS_HOME between
// cases (and re-import with a cache-buster), so key by the resolved path and
// re-open when it changes rather than assuming a single global home.
let cached: { path: string; handle: DatabaseSync } | undefined;

function db(): DatabaseSync {
  const path = stateDbPath();
  if (cached && cached.path === path) {
    return cached.handle;
  }
  mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA busy_timeout = 5000");
  handle.exec("PRAGMA foreign_keys = ON");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id         TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      status     TEXT,
      kind       TEXT,
      seq        INTEGER NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  handle.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES('version', ?)").run(String(STATE_VERSION));
  cached = { path, handle };
  migrateLegacyStateJson(handle);
  return handle;
}

/** One-time import of a pre-wave-3 state.json into the DB. Idempotent. */
function migrateLegacyStateJson(handle: DatabaseSync): void {
  const legacy = statePath();
  const alreadyMigrated = handle.prepare("SELECT value FROM meta WHERE key = 'migrated_state_json'").get() as
    | { value: string }
    | undefined;
  if (alreadyMigrated || !existsSync(legacy)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(legacy, "utf8")) as PeerState;
    if (parsed && Array.isArray(parsed.peers)) {
      const insert = handle.prepare(
        "INSERT OR REPLACE INTO peers(id, json, status, kind, seq, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
      );
      handle.exec("BEGIN IMMEDIATE");
      try {
        let seq = 1;
        // Preserve original array order (newest-first): last element lowest seq.
        for (let i = parsed.peers.length - 1; i >= 0; i -= 1) {
          const peer = normalizePeerRecord(parsed.peers[i]);
          insert.run(peer.id, JSON.stringify(peer), peer.status ?? null, peer.kind ?? null, seq, peer.updatedAt ?? null);
          seq += 1;
        }
        handle.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('migrated_state_json', ?)").run(new Date().toISOString());
        handle.exec("COMMIT");
      } catch (err) {
        handle.exec("ROLLBACK");
        throw err;
      }
      // Keep the original as a backup rather than deleting it.
      try {
        renameSync(legacy, `${legacy}.bak`);
      } catch {
        /* backup best-effort */
      }
    }
  } catch {
    // A malformed legacy file shouldn't wedge the DB; mark migrated so we don't
    // retry every open, and start fresh.
    handle.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('migrated_state_json', ?)").run(`skipped:${new Date().toISOString()}`);
  }
}

function nextSeq(handle: DatabaseSync): number {
  const row = handle.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM peers").get() as { n: number };
  return row.n;
}

function rowToPeer(row: { json: string }): PeerRecord {
  return normalizePeerRecord(JSON.parse(row.json) as PeerRecord);
}

export function readState(): PeerState {
  ensureHome();
  try {
    return readStateFile();
  } catch {
    return { version: STATE_VERSION, updatedAt: new Date().toISOString(), peers: [] };
  }
}

export function readStateFile(): PeerState {
  ensureHome();
  const handle = db();
  const rows = handle.prepare("SELECT json FROM peers ORDER BY seq DESC").all() as Array<{ json: string }>;
  const versionRow = handle.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | undefined;
  const version = versionRow ? Number(versionRow.value) : STATE_VERSION;
  if (version !== STATE_VERSION) {
    throw new Error("Invalid delamain state DB version");
  }
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    peers: rows.map(rowToPeer),
  };
}

/**
 * Replace the entire peer set atomically. Kept for the (infrequent) bulk
 * callers — sweep's archive/prune and tests — that compute a whole new list.
 * Per-peer hot writes go through updatePeer/upsertPeer instead.
 */
export function writeState(state: PeerState): void {
  const handle = db();
  const insert = handle.prepare(
    "INSERT OR REPLACE INTO peers(id, json, status, kind, seq, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
  );
  handle.exec("BEGIN IMMEDIATE");
  try {
    handle.exec("DELETE FROM peers");
    // First array element is newest → highest seq so ORDER BY seq DESC restores it.
    let seq = state.peers.length;
    for (const peer of state.peers) {
      insert.run(peer.id, JSON.stringify(peer), peer.status ?? null, peer.kind ?? null, seq, peer.updatedAt ?? null);
      seq -= 1;
    }
    handle.exec("COMMIT");
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Atomically read-modify-write a single peer inside one IMMEDIATE transaction,
 * so concurrent writers to different peers never collide and concurrent writers
 * to the same peer are serialized (no lost updates — the wave-3 keystone).
 */
export function updatePeer(peerId: string, updater: (peer: PeerRecord) => PeerRecord): PeerRecord | undefined {
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const row = handle.prepare("SELECT json, seq FROM peers WHERE id = ?").get(peerId) as
      | { json: string; seq: number }
      | undefined;
    if (!row) {
      handle.exec("COMMIT");
      return undefined;
    }
    const updated = updater(rowToPeer(row));
    handle
      .prepare("UPDATE peers SET json = ?, status = ?, kind = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(updated), updated.status ?? null, updated.kind ?? null, updated.updatedAt ?? null, peerId);
    handle.exec("COMMIT");
    return updated;
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }
}

/** Insert or move-to-front a peer (mirrors the old unshift-newest semantics). */
export function upsertPeer(peer: PeerRecord): void {
  const handle = db();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const seq = nextSeq(handle);
    handle
      .prepare("INSERT OR REPLACE INTO peers(id, json, status, kind, seq, updated_at) VALUES(?, ?, ?, ?, ?, ?)")
      .run(peer.id, JSON.stringify(peer), peer.status ?? null, peer.kind ?? null, seq, peer.updatedAt ?? null);
    handle.exec("COMMIT");
  } catch (err) {
    handle.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Get a peer by exact id or id-prefix, newest match first — the same result
 * the old `peers.find(p => p.id === id || p.id.startsWith(id))` gave over the
 * newest-first array (startsWith already covers the exact case).
 */
export function getPeer(peerId: string): PeerRecord | undefined {
  const handle = db();
  const like = `${peerId.replace(/[\\%_]/g, "\\$&")}%`;
  const row = handle
    .prepare("SELECT json FROM peers WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 1")
    .get(peerId, like) as { json: string } | undefined;
  return row ? rowToPeer(row) : undefined;
}
