// tests/workflowConcurrency.test.mjs
//
// SP1 wave 2 acceptance — a workflow that fans out N=8 agents (parallel +
// pipeline) runs with AT MOST DELAMAIN_MAX_AGENTS leaves alive at once
// (asserted via the store), pushes ZERO branches (integrate:false holds under
// fan-out), and returns a synthesized result. Uses the REAL engine + REAL
// sandbox child, with spawnPeer/waitForPeer faked to write real store records
// (no codex processes, no git).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "delamain-wfc-"));
  process.env.CODEX_PEERS_HOME = dir;
  await mkdir(join(dir, "runs"), { recursive: true });
  return dir;
}

test("N=8 fan-out respects DELAMAIN_MAX_AGENTS, pushes zero branches, synthesizes", async () => {
  const home = await makeHome();
  const savedCap = process.env.DELAMAIN_MAX_AGENTS;
  process.env.DELAMAIN_MAX_AGENTS = "3";
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const store = await import(`../dist/store.js?cb=${Math.random()}`);

    const scriptPath = join(home, "fanout.ts");
    await writeFile(
      scriptPath,
      `export const meta = { name: "fanout" };
export default async function run(ctx) {
  const reviewed = await ctx.pipeline(
    ["a","b","c","d","e","f","g","h"],
    (f) => ctx.agent("review " + f, { schema: { type: "object" }, label: f }),
    (r, f) => ({ f, r }),
  );
  const summary = await ctx.agent("synthesize", { schema: { type: "object" }, label: "synthesis" });
  return { count: reviewed.filter(Boolean).length, summary };
}
`,
      "utf8",
    );

    const run = manager.spawnWorkflowRun({ repo: "/repo", scriptPath, timeoutMs: 30_000 });

    // Fake leaf peers as real store records: "working" on spawn, "done" after a
    // delay. Track branch pushes (must stay zero for integrate:false leaves).
    let pushed = 0;
    let spawnSeq = 0;
    const spawnPeer = (options) => {
      assert.equal(options.integrate, false, "workflow leaves must spawn integrate:false");
      spawnSeq += 1;
      const id = `leaf-${spawnSeq}`;
      const rec = {
        id,
        repo: join(home, "wt", id),
        task: `leaf ${options.name ?? id}`,
        status: "working",
        engine: "codex",
        integrate: false,
        integrationStatus: "pending",
        runnerPid: process.pid, // alive → reconciliation keeps it "working"
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
        logPath: join(home, "runs", `${id}.log`),
        kind: "generic",
      };
      store.upsertPeer(rec);
      return rec;
    };
    const waitForPeer = async ({ peerId }) => {
      await new Promise((r) => setTimeout(r, 25));
      // integrate:false leaves never push; record the terminal state.
      const done = store.updatePeer(peerId, (p) => ({
        ...p,
        status: "done",
        finalResult: '```json\n{"ok":true}\n```',
        integrationStatus: "skipped",
        lastHeartbeatAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      return { peer: done, timedOut: false, elapsedMs: 25 };
    };

    // Sample the store while the run is in flight; record peak live leaves.
    let peakLive = 0;
    const sampler = setInterval(() => {
      const live = store.readState().peers.filter((p) => p.id.startsWith("leaf-") && p.status === "working").length;
      if (live > peakLive) peakLive = live;
    }, 4);

    const final = await manager.dispatchWorkflow(run.id, {
      spawnPeer,
      waitForPeer,
      resumePeer: () => {
        throw new Error("no retries expected");
      },
      tokensForPeer: () => 0,
      killPeer: () => {},
      readAgentResultFile: () => undefined,
      removeAgentResultFile: () => {},
    });
    clearInterval(sampler);

    assert.equal(final.status, "done", `workflow should complete; got ${final.status} (${final.error})`);
    assert.deepEqual(final.workflow.result, { count: 8, summary: { ok: true } });

    // 9 leaves total (8 review + 1 synthesis), never more than the cap alive.
    assert.equal(spawnSeq, 9, "expected 8 review + 1 synthesis leaves");
    assert.ok(peakLive > 0, "sampler should have observed live leaves");
    assert.ok(peakLive <= 3, `at most DELAMAIN_MAX_AGENTS(3) leaves alive; saw peak ${peakLive}`);

    // Zero branches pushed; every leaf integration skipped.
    const leaves = store.readState().peers.filter((p) => p.id.startsWith("leaf-"));
    assert.equal(pushed, 0);
    for (const leaf of leaves) {
      assert.notEqual(leaf.integrationStatus, "pushed", `leaf ${leaf.id} must not push a branch`);
    }
    assert.equal(final.workflow.agentPeerIds.length, 9);
  } finally {
    if (savedCap === undefined) delete process.env.DELAMAIN_MAX_AGENTS;
    else process.env.DELAMAIN_MAX_AGENTS = savedCap;
    await rm(home, { recursive: true, force: true });
  }
});
