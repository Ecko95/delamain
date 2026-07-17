// tests/sqliteStore.test.mjs
//
// SP1 wave 3 — the SQLite state store behind the unchanged store.ts API:
// CRUD/order parity, one-time state.json migration, and the keystone property
// (design §8): concurrent MULTI-PROCESS writers lose NO updates, where the old
// whole-file read-modify-write did.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "delamain-sqlite-"));
  process.env.CODEX_PEERS_HOME = dir;
  await mkdir(join(dir, "runs"), { recursive: true });
  return dir;
}

async function importStore() {
  return import(`../dist/store.js?cb=${Math.random()}`);
}

function peer(id, extra = {}) {
  return {
    id,
    repo: "/repo",
    task: `task ${id}`,
    status: "starting",
    startedAt: "t",
    updatedAt: "t",
    logPath: `/tmp/${id}.log`,
    ...extra,
  };
}

test("CRUD + ordering parity with the old store API", async () => {
  const home = await makeHome();
  try {
    const store = await importStore();
    assert.deepEqual(store.readState().peers, []);

    store.upsertPeer(peer("aaaa1111"));
    store.upsertPeer(peer("bbbb2222"));
    // Newest-first ordering preserved (upsert = unshift).
    assert.deepEqual(store.readState().peers.map((p) => p.id), ["bbbb2222", "aaaa1111"]);

    // getPeer by exact id and by prefix (newest match).
    assert.equal(store.getPeer("aaaa1111").id, "aaaa1111");
    assert.equal(store.getPeer("bbbb").id, "bbbb2222");
    assert.equal(store.getPeer("nope"), undefined);

    // updatePeer is a targeted row RMW.
    const updated = store.updatePeer("aaaa1111", (p) => ({ ...p, status: "done", updatedAt: "t2" }));
    assert.equal(updated.status, "done");
    assert.equal(store.getPeer("aaaa1111").status, "done");
    assert.equal(store.updatePeer("missing", (p) => p), undefined);

    // writeState replaces the whole set atomically (sweep/admin path).
    store.writeState({ version: 1, updatedAt: "t", peers: [peer("cccc3333")] });
    assert.deepEqual(store.readState().peers.map((p) => p.id), ["cccc3333"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("one-time state.json migration imports peers and backs up the file", async () => {
  const home = await makeHome();
  try {
    const legacy = join(home, "state.json");
    await writeFile(
      legacy,
      JSON.stringify({
        version: 1,
        updatedAt: "t",
        peers: [peer("dddd4444", { status: "done" }), peer("eeee5555")],
      }),
      "utf8",
    );
    const store = await importStore();
    const state = store.readState();
    assert.deepEqual(state.peers.map((p) => p.id), ["dddd4444", "eeee5555"]);
    assert.equal(store.getPeer("dddd4444").status, "done");
    // Original preserved as a backup, not deleted.
    assert.ok(existsSync(`${legacy}.bak`), "state.json should be renamed to .bak");
    assert.ok(!existsSync(legacy), "state.json should no longer be the live source");
    // Re-open doesn't re-migrate (idempotent).
    const store2 = await importStore();
    assert.equal(store2.readState().peers.length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent multi-process writers lose NO updates (the §8 keystone)", async () => {
  const home = await makeHome();
  const WORKERS = 6;
  const INCREMENTS = 40;
  try {
    const store = await importStore();
    // A shared peer whose counter every worker increments, plus a per-worker
    // distinct peer to prove no inserts are dropped either.
    store.upsertPeer(peer("shared", { counter: 0 }));

    const workerSrc = join(home, "worker.mjs");
    await writeFile(
      workerSrc,
      `
const store = await import(${JSON.stringify("../".repeat(0) + process.cwd() + "/dist/store.js")});
const w = process.env.WORKER_ID;
const N = Number(process.env.INCREMENTS);
store.upsertPeer({ id: "w" + w, repo: "/r", task: "t", status: "done", startedAt: "t", updatedAt: "t", logPath: "/l" });
for (let i = 0; i < N; i++) {
  store.updatePeer("shared", (p) => ({ ...p, counter: (p.counter || 0) + 1, updatedAt: new Date().toISOString() }));
}
process.exit(0);
`,
      "utf8",
    );

    await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        new Promise((resolve, reject) => {
          const child = fork(workerSrc, [], {
            env: { ...process.env, CODEX_PEERS_HOME: home, WORKER_ID: String(i), INCREMENTS: String(INCREMENTS) },
            stdio: "ignore",
          });
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker ${i} exit ${code}`))));
          child.on("error", reject);
        }),
      ),
    );

    const fresh = await importStore();
    const shared = fresh.getPeer("shared");
    assert.equal(
      shared.counter,
      WORKERS * INCREMENTS,
      `expected ${WORKERS * INCREMENTS} increments with no lost updates, got ${shared.counter}`,
    );
    // Every worker's distinct insert also landed.
    for (let i = 0; i < WORKERS; i += 1) {
      assert.ok(fresh.getPeer(`w${i}`), `worker ${i}'s peer row is missing`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
