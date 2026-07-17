// tests/workflowEvents.test.mjs
//
// SP1 wave 4 — the event stream + lightweight surface: events land durably in
// SQLite AND the tailable jsonl, ordered per workflow; list_workflows and
// workflow_events (with a since-filter) read them back. Real store + real
// sandbox child, fake leaf peers (no codex).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "delamain-events-"));
  process.env.CODEX_PEERS_HOME = dir;
  await mkdir(join(dir, "runs"), { recursive: true });
  return dir;
}

const SCRIPT = `export const meta = { name: "events-demo" };
export default async function run(ctx) {
  ctx.phase("review");
  const out = await ctx.parallel([
    () => ctx.agent("a", { schema: { type: "object" }, label: "a" }),
    () => ctx.agent("b", { schema: { type: "object" }, label: "b" }),
  ]);
  return { out: out.filter(Boolean).length };
}
`;

function fakeLeafDeps(home) {
  let n = 0;
  return {
    spawnPeer: (o) => {
      n += 1;
      const id = `leaf-${n}-${o.name}`;
      return { id, repo: join(home, "wt", id), task: o.name, status: "starting", integrate: false, startedAt: "t", updatedAt: "t", logPath: join(home, "runs", `${id}.log`) };
    },
    waitForPeer: async ({ peerId }) => ({
      peer: { id: peerId, repo: join(home, "wt", peerId), task: "t", status: "done", finalResult: '```json\n{"ok":true}\n```', startedAt: "t", updatedAt: "t", logPath: join(home, "runs", `${peerId}.log`) },
      timedOut: false,
      elapsedMs: 1,
    }),
    resumePeer: () => { throw new Error("no retries"); },
    tokensForPeer: () => 0,
    killPeer: () => {},
    readAgentResultFile: () => undefined,
    removeAgentResultFile: () => {},
  };
}

test("a workflow run emits a durable + tailable event stream, queryable via the surface", async () => {
  const home = await makeHome();
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const store = await import(`../dist/store.js?cb=${Math.random()}`);

    const scriptPath = join(home, "wf.ts");
    await writeFile(scriptPath, SCRIPT, "utf8");
    const run = manager.spawnWorkflowRun({ repo: "/repo", scriptPath, timeoutMs: 30_000 });
    const final = await manager.dispatchWorkflow(run.id, fakeLeafDeps(home));
    assert.equal(final.status, "done");

    // Durable SQLite events, ordered by seq.
    const events = store.readWorkflowEvents(run.id);
    const types = events.map((e) => e.type);
    assert.equal(types[0], "workflow_start");
    assert.equal(types[types.length - 1], "workflow_end");
    assert.ok(types.includes("phase_start"));
    assert.equal(types.filter((t) => t === "agent_spawn").length, 2);
    assert.equal(types.filter((t) => t === "agent_done").length, 2);
    // seq is strictly increasing.
    for (let i = 1; i < events.length; i += 1) assert.ok(events[i].seq > events[i - 1].seq);

    // since-filter tails only newer events.
    const tail = store.readWorkflowEvents(run.id, events[0].seq);
    assert.equal(tail.length, events.length - 1);
    assert.equal(tail[0].seq, events[1].seq);

    // Tailable jsonl fallback got the same events.
    const jsonlPath = join(home, "events.jsonl");
    assert.ok(existsSync(jsonlPath), "events.jsonl should exist");
    const lines = (await readFile(jsonlPath, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(lines.filter((e) => e.workflowId === run.id).map((e) => e.type)[0], "workflow_start");

    // manager helpers + surface.
    const list = manager.listWorkflows();
    assert.ok(list.some((p) => p.id === run.id));
    const viaManager = manager.workflowEvents(run.id, 0);
    assert.equal(viaManager.length, events.length);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP list_workflows and workflow_events expose the run", async () => {
  const home = await makeHome();
  try {
    const manager = await import(`../dist/workflow/manager.js?cb=${Math.random()}`);
    const mcp = await import(`../dist/mcpServer.js?cb=${Math.random()}`);
    const scriptPath = join(home, "wf.ts");
    await writeFile(scriptPath, SCRIPT, "utf8");
    const run = manager.spawnWorkflowRun({ repo: "/repo", scriptPath });
    await manager.dispatchWorkflow(run.id, fakeLeafDeps(home));

    const listed = JSON.parse((await mcp.callTool("list_workflows", {})).content[0].text);
    assert.ok(listed.some((w) => w.workflow_id === run.id && w.workflow_status === "done"));

    const evResult = JSON.parse((await mcp.callTool("workflow_events", { workflow_id: run.id })).content[0].text);
    assert.equal(evResult.workflow_id, run.id);
    assert.equal(evResult.events[0].type, "workflow_start");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
