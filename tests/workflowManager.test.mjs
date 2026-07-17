// tests/workflowManager.test.mjs
//
// SP1 wave 1 — spawnWorkflowRun / dispatchWorkflow / workflowStatus against
// the real store (temp CODEX_PEERS_HOME) with fake peer deps and a fake
// sandbox executor (no processes). Mirrors spawnGsdPhaseBatch.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "delamain-wf-test-"));
  process.env.CODEX_PEERS_HOME = dir;
  await mkdir(join(dir, "runs"), { recursive: true });
  return dir;
}

async function importManager() {
  return import(`../dist/workflow/manager.js?cb=${Math.random()}`);
}

async function importStore() {
  return import(`../dist/store.js?cb=${Math.random()}`);
}

function fakeEngineDeps({ script } = {}) {
  return {
    spawnPeer: () => {
      throw new Error("no peers in this test");
    },
    waitForPeer: async () => {
      throw new Error("no peers in this test");
    },
    resumePeer: () => {
      throw new Error("no peers in this test");
    },
    killPeer: () => {},
    readAgentResultFile: () => undefined,
    removeAgentResultFile: () => {},
    appendLog: async () => {},
    executeScript: script ?? (() => ({ result: Promise.resolve({ ok: true }), kill: () => {} })),
    now: () => Date.now(),
  };
}

test("spawnWorkflowRun persists a workflow_run record without spawning anything", async () => {
  const home = await makeHome();
  try {
    const { spawnWorkflowRun } = await importManager();
    const { getPeer } = await importStore();
    const run = spawnWorkflowRun({ repo: "/some/repo", scriptPath: "/tmp/demo.ts", timeoutMs: 5000, name: "demo" });
    assert.equal(run.kind, "workflow_run");
    assert.equal(run.status, "starting");
    assert.equal(run.workflow.status, "pending");
    assert.equal(run.workflow.timeoutMs, 5000);
    assert.deepEqual(run.workflow.agentPeerIds, []);
    assert.equal(typeof run.workflow.seed, "number");
    assert.equal(typeof run.workflow.startTimeMs, "number");
    assert.equal(run.runnerPid, undefined);
    const persisted = getPeer(run.id);
    assert.equal(persisted.workflow.scriptPath, "/tmp/demo.ts");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatchWorkflow drives the record to done and persists the result", async () => {
  const home = await makeHome();
  try {
    const manager = await importManager();
    const run = manager.spawnWorkflowRun({ repo: "/some/repo", scriptPath: "/tmp/demo.ts" });
    const final = await manager.dispatchWorkflow(run.id, fakeEngineDeps());
    assert.equal(final.status, "done");
    assert.equal(final.workflow.status, "done");
    assert.deepEqual(final.workflow.result, { ok: true });
    assert.ok(final.finishedAt);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatchWorkflow dedupes by id and _awaitWorkflowRun returns the same promise", async () => {
  const home = await makeHome();
  try {
    const manager = await importManager();
    const run = manager.spawnWorkflowRun({ repo: "/r", scriptPath: "/tmp/demo.ts" });
    let executions = 0;
    const deps = fakeEngineDeps({
      script: () => {
        executions += 1;
        return { result: Promise.resolve(executions), kill: () => {} };
      },
    });
    const first = manager.dispatchWorkflow(run.id, deps);
    const second = manager.dispatchWorkflow(run.id, deps);
    assert.equal(first, second);
    assert.equal(manager._awaitWorkflowRun(run.id), first);
    await first;
    assert.equal(executions, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a workflow with timeoutMs halts when the (fake) script hangs", async () => {
  const home = await makeHome();
  try {
    const manager = await importManager();
    const run = manager.spawnWorkflowRun({ repo: "/r", scriptPath: "/tmp/hang.ts", timeoutMs: 80 });
    let killedChild = false;
    const final = await manager.dispatchWorkflow(
      run.id,
      fakeEngineDeps({
        script: () => ({
          result: new Promise(() => {}),
          kill: () => {
            killedChild = true;
          },
        }),
      }),
    );
    assert.equal(final.status, "halted");
    assert.equal(final.workflow.status, "halted");
    assert.ok(killedChild);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dispatchWorkflow refuses non-workflow peers and unknown ids", async () => {
  const home = await makeHome();
  try {
    const manager = await importManager();
    const { upsertPeer } = await importStore();
    upsertPeer({
      id: "generic1",
      repo: "/r",
      task: "t",
      status: "done",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(home, "runs", "x.log"),
    });
    assert.throws(() => manager.dispatchWorkflow("generic1"), /not a workflow_run/);
    assert.throws(() => manager.dispatchWorkflow("nope"), /unknown workflow/);
    assert.throws(() => manager.workflowStatus("generic1"), /not a workflow_run/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("workflow_run records are exempt from frozen reconciliation", async () => {
  const home = await makeHome();
  try {
    const manager = await importManager();
    const { listPeers } = await import(`../dist/peerManager.js?cb=${Math.random()}`);
    const { updatePeer } = await importStore();
    const run = manager.spawnWorkflowRun({ repo: "/r", scriptPath: "/tmp/demo.ts" });
    // Simulate an in-flight run with a long-stale heartbeat and dead pids.
    updatePeer(run.id, (current) => ({
      ...current,
      status: "working",
      runnerPid: 999999,
      lastHeartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
    }));
    const seen = listPeers().find((p) => p.id === run.id);
    assert.equal(seen.status, "working", "workflow_run must not be flipped to frozen");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("buildWorkflowRunnerArgv mirrors the run-peer argv seam", async () => {
  const { buildWorkflowRunnerArgv } = await importManager();
  const argv = buildWorkflowRunnerArgv({ workflowId: "abc123" });
  assert.ok(argv[0].endsWith("index.js"));
  assert.equal(argv[1], "run-workflow-runner");
  assert.deepEqual(argv.slice(2), ["--workflow-id", "abc123"]);
});

test("end-to-end through the REAL sandbox: fake agent, real child process", async () => {
  const home = await makeHome();
  try {
    const manager = await importManager();
    const scriptPath = join(home, "wf.ts");
    await writeFile(
      scriptPath,
      `export const meta = { name: "e2e" };
export default async function run(ctx) {
  const r = await ctx.agent("probe", { schema: { type: "object" } });
  return { got: r };
}
`,
      "utf8",
    );
    const run = manager.spawnWorkflowRun({ repo: "/r", scriptPath, timeoutMs: 20_000 });
    const deps = fakeEngineDeps();
    // Real executeScript (default) but a fake agent bridge: override the peer
    // deps used by ctx.agent so no codex process is involved.
    delete deps.executeScript;
    deps.spawnPeer = () => ({
      id: "leafX",
      repo: "/wt",
      task: "probe",
      status: "starting",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(home, "runs", "leaf.log"),
    });
    deps.waitForPeer = async () => ({
      peer: {
        id: "leafX",
        repo: "/wt",
        task: "probe",
        status: "done",
        finalResult: '```json\n{"answer": 42}\n```',
        startedAt: "t",
        updatedAt: "t",
        logPath: join(home, "runs", "leaf.log"),
      },
      timedOut: false,
      elapsedMs: 1,
    });
    const final = await manager.dispatchWorkflow(run.id, deps);
    assert.equal(final.workflow.status, "done");
    assert.deepEqual(final.workflow.result, { got: { answer: 42 } });
    assert.deepEqual(final.workflow.agentPeerIds, ["leafX"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
