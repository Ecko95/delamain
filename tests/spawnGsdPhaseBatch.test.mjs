// tests/spawnGsdPhaseBatch.test.mjs
//
// Phase 33 plan 01 — end-to-end coverage of spawnGsdPhaseBatch.
//
// Notes on test harness:
//   The project's state layer (`src/store.ts`) reads the peers home dir from
//   process.env.CODEX_PEERS_HOME at call time, so each test sets a unique
//   tmpdir before invoking the manager. Module-level imports stay the same;
//   only the env var changes between tests. (Deviation from the plan's
//   class-based `new PeerManager({ stateDir, logDir })` template: the
//   existing project uses module-level functions, not a class.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "codex-peers-test-"));
  process.env.CODEX_PEERS_HOME = dir;
  // Pre-create runs dir so the spawn helper's writeFileSync succeeds.
  await mkdir(join(dir, "runs"), { recursive: true });
  return dir;
}

async function importManager() {
  const mod = await import(`../dist/peerManager.js?cb=${Math.random()}`);
  return mod;
}

async function importStore() {
  const mod = await import(`../dist/store.js?cb=${Math.random()}`);
  return mod;
}

test("spawnGsdPhaseBatch creates a peer with kind=gsd_phase_batch and status=gsd_pending", async () => {
  const dir = await makeHome();
  try {
    const mgr = await importManager();
    const peer = mgr.spawnGsdPhaseBatch({
      repo: "/tmp/example",
      gsdBatch: {
        planning_mode: "frozen",
        selected_phases: ["02-task-service", "03-http-integration"],
        cursor: 0,
      },
    });
    assert.equal(peer.kind, "gsd_phase_batch");
    assert.equal(peer.status, "gsd_pending");
    assert.equal(peer.gsdBatch.planning_mode, "frozen");
    assert.equal(peer.gsdBatch.cursor, 0);
    assert.deepEqual(peer.gsdBatch.selected_phases, [
      "02-task-service",
      "03-http-integration",
    ]);
    assert.ok(peer.task.includes("frozen"), `task included planning_mode: ${peer.task}`);
    assert.ok(peer.task.includes("02-task-service"));
    assert.ok(typeof peer.logPath === "string" && peer.logPath.length > 0);
    assert.ok(existsSync(peer.logPath), "log file touched on disk");
  } finally {
    delete process.env.CODEX_PEERS_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

test("spawnGsdPhaseBatch with dynamic mode and milestone tag", async () => {
  const dir = await makeHome();
  try {
    const mgr = await importManager();
    const peer = mgr.spawnGsdPhaseBatch({
      repo: "/tmp/example2",
      name: "demo-peer",
      gsdBatch: {
        planning_mode: "dynamic",
        selected_phases: ["05-foo"],
        milestone: "v8.0",
        cursor: 0,
      },
    });
    assert.equal(peer.kind, "gsd_phase_batch");
    assert.equal(peer.status, "gsd_pending");
    assert.equal(peer.name, "demo-peer");
    assert.equal(peer.gsdBatch.milestone, "v8.0");
    assert.equal(peer.gsdBatch.planning_mode, "dynamic");
  } finally {
    delete process.env.CODEX_PEERS_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

test("spawnGsdPhaseBatch persists to disk and listPeers returns the record", async () => {
  const dir = await makeHome();
  try {
    const mgr = await importManager();
    const peer = mgr.spawnGsdPhaseBatch({
      repo: "/tmp/x",
      gsdBatch: { planning_mode: "dynamic", selected_phases: ["05-foo"], cursor: 0 },
    });
    const peers = mgr.listPeers();
    const reloaded = peers.find((p) => p.id === peer.id);
    assert.ok(reloaded, "spawned peer should be visible via listPeers");
    assert.equal(reloaded.kind, "gsd_phase_batch");
    assert.equal(reloaded.gsdBatch.planning_mode, "dynamic");
    assert.equal(reloaded.status, "gsd_pending");
  } finally {
    delete process.env.CODEX_PEERS_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy state.json without kind field loads as kind=generic via normalization", async () => {
  const dir = await makeHome();
  try {
    // Manually write a state.json without the kind field, simulating
    // pre-Phase-33 on-disk state.
    const statePath = join(dir, "state.json");
    const legacy = {
      version: 1,
      updatedAt: "2026-05-09T00:00:00Z",
      peers: [
        {
          id: "legacy1",
          repo: "/tmp/legacy",
          task: "old task",
          status: "done",
          startedAt: "2026-05-09T00:00:00Z",
          updatedAt: "2026-05-09T00:00:00Z",
          logPath: "/tmp/legacy.log",
          // no kind field
        },
      ],
    };
    await writeFile(statePath, JSON.stringify(legacy, null, 2), "utf8");

    const store = await importStore();
    const state = store.readState();
    const peer = state.peers.find((p) => p.id === "legacy1");
    assert.ok(peer, "legacy peer should be present in state");
    assert.equal(
      peer.kind,
      "generic",
      "missing kind on disk must normalize to 'generic'",
    );
    assert.equal(peer.status, "done");
  } finally {
    delete process.env.CODEX_PEERS_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});

test("listPeers does not reconcile gsd_phase_batch peers as 'frozen' (no runner pid expected)", async () => {
  const dir = await makeHome();
  try {
    const mgr = await importManager();
    const peer = mgr.spawnGsdPhaseBatch({
      repo: "/tmp/x",
      gsdBatch: {
        planning_mode: "dynamic",
        selected_phases: ["05-foo"],
        cursor: 0,
      },
    });
    // listPeers runs through reconciledPeer. For a GSD peer with no
    // runnerPid/codexPid, the generic-peer path would have flipped status to
    // "frozen". The Phase 33 early-return must skip that.
    const peers = mgr.listPeers();
    const reloaded = peers.find((p) => p.id === peer.id);
    assert.ok(reloaded);
    assert.equal(reloaded.status, "gsd_pending");
    assert.notEqual(reloaded.status, "frozen");
  } finally {
    delete process.env.CODEX_PEERS_HOME;
    await rm(dir, { recursive: true, force: true });
  }
});
