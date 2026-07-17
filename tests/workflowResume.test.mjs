// tests/workflowResume.test.mjs
//
// SP1 wave 3 acceptance (§14 / v1 item 5): a killed workflow resumes from its
// journaled prefix — replaying completed ctx.agent() calls (zero re-spawns)
// and running only the remainder live — through the REAL SQLite journal and
// the REAL sandbox child, with fake leaf peers (no codex). Also covers the
// cross-process run lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "delamain-resume-"));
  process.env.CODEX_PEERS_HOME = dir;
  await mkdir(join(dir, "runs"), { recursive: true });
  return dir;
}

const SCRIPT = `export const meta = { name: "resume-demo" };
export default async function run(ctx) {
  const out = await ctx.pipeline(
    ["a", "b", "c", "d"],
    (f) => ctx.agent("review " + f, { schema: { type: "object" }, label: f }),
    (r, f) => ({ f, r }),
  );
  return { out: out.filter(Boolean) };
}
`;

// Fake leaf deps: spawnPeer records the target file; waitForPeer returns a
// distinct JSON result. `failAfter` makes the Nth+ leaves "fail" so we can
// simulate a partial (killed-ish) first run that only journals a prefix.
function fakeLeafDeps(home, store, opts = {}) {
  const spawned = [];
  let n = 0;
  return {
    spawned,
    deps: {
      spawnPeer: (o) => {
        n += 1;
        const id = `leaf-${n}-${o.name}`;
        spawned.push(o.name);
        return {
          id,
          repo: join(home, "wt", id),
          task: o.name,
          status: "starting",
          integrate: false,
          startedAt: "t",
          updatedAt: "t",
          logPath: join(home, "runs", `${id}.log`),
        };
      },
      waitForPeer: async ({ peerId }) => {
        const file = peerId.split("-").slice(2).join("-");
        const fail = opts.failFiles?.includes(file);
        return {
          peer: {
            id: peerId,
            repo: join(home, "wt", peerId),
            task: file,
            status: fail ? "failed" : "done",
            error: fail ? "simulated crash" : undefined,
            finalResult: fail ? "" : "```json\n" + JSON.stringify({ file, ok: true }) + "\n```",
            startedAt: "t",
            updatedAt: "t",
            logPath: join(home, "runs", `${peerId}.log`),
          },
          timedOut: false,
          elapsedMs: 1,
        };
      },
      resumePeer: () => {
        throw new Error("no schema retries in this test");
      },
      tokensForPeer: () => 0,
      killPeer: () => {},
      readAgentResultFile: () => undefined,
      removeAgentResultFile: () => {},
    },
  };
}

test("killed run resumes from the journaled prefix; only the remainder re-runs", async () => {
  const home = await makeHome();
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const store = await import(`../dist/store.js?cb=${Math.random()}`);

    const scriptPath = join(home, "wf.ts");
    await writeFile(scriptPath, SCRIPT, "utf8");
    const run = manager.spawnWorkflowRun({ repo: "/repo", scriptPath, timeoutMs: 30_000 });

    // Run 1: files c and d "fail" → the pipeline drops them to null, but a and b
    // complete and journal. (A stage throw on failure ends that item; a,b done.)
    const first = fakeLeafDeps(home, store, { failFiles: ["c", "d"] });
    const r1 = await manager.dispatchWorkflow(run.id, first.deps);
    assert.equal(r1.status, "done"); // pipeline tolerates failed items (null)
    // Journal captured the two successful calls.
    const journal1 = store.readAgentJournal(run.id);
    const journaledFiles = journal1.map((j) => JSON.parse(j.resultJson).file).sort();
    assert.deepEqual(journaledFiles, ["a", "b"]);
    assert.deepEqual(first.spawned.sort(), ["a", "b", "c", "d"]); // all four attempted

    // Resume: a,b replay from the journal (no re-spawn); c,d run live (now succeed).
    const second = fakeLeafDeps(home, store, {});
    const r2 = await manager.dispatchWorkflow(run.id, second.deps);
    assert.equal(r2.status, "done");
    assert.equal(r2.workflow.replayedAgents, 2, "a and b should replay from journal");
    assert.deepEqual(second.spawned.sort(), ["c", "d"], "only c and d re-run live on resume");
    assert.equal(r2.workflow.result.out.length, 4, "all four items present after resume");
    // Journal now complete.
    assert.equal(store.readAgentJournal(run.id).length, 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("identical re-dispatch replays 100% from the journal (zero spawns)", async () => {
  const home = await makeHome();
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const store = await import(`../dist/store.js?cb=${Math.random()}`);
    const scriptPath = join(home, "wf.ts");
    await writeFile(scriptPath, SCRIPT, "utf8");
    const run = manager.spawnWorkflowRun({ repo: "/repo", scriptPath });

    const first = fakeLeafDeps(home, store, {});
    await manager.dispatchWorkflow(run.id, first.deps);
    assert.equal(first.spawned.length, 4);

    const second = fakeLeafDeps(home, store, {});
    const r2 = await manager.dispatchWorkflow(run.id, second.deps);
    assert.equal(second.spawned.length, 0, "re-dispatch must not spawn anything");
    assert.equal(r2.workflow.replayedAgents, 4);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("acquireRunLock refuses a second holder while the owner pid is alive, and releases", async () => {
  const home = await makeHome();
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const release = manager.acquireRunLock("wf-lock-1");
    assert.ok(release, "first acquire should succeed");
    // Same-process owner (this pid) is alive → a second acquire is refused.
    assert.equal(manager.acquireRunLock("wf-lock-1"), null, "second acquire must be refused while held");
    release();
    // After release, it can be acquired again.
    const again = manager.acquireRunLock("wf-lock-1");
    assert.ok(again, "acquire should succeed after release");
    again();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resumeWorkflowRun refuses a still-active workflow", async () => {
  const home = await makeHome();
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const store = await import(`../dist/store.js?cb=${Math.random()}`);
    const run = manager.spawnWorkflowRun({ repo: "/repo", scriptPath: join(home, "wf.ts") });
    store.updatePeer(run.id, (p) => ({ ...p, status: "working" }));
    assert.throws(() => manager.resumeWorkflowRun(run.id), /still active/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
