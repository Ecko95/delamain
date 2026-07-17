// tests/workflowFanout.test.mjs
//
// SP1 wave 2 — ctx.parallel / ctx.pipeline / ctx.phase / ctx.budget semantics,
// exercised through the REAL sandbox child (in-child implementation + the
// async ctx bridge carrying many concurrent agent() calls with correct id
// correlation).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { executeWorkflowScript } = await import("../dist/workflow/sandbox.js");

async function writeScript(body) {
  const dir = await mkdtemp(join(tmpdir(), "wf-fanout-"));
  const path = join(dir, "workflow.ts");
  await writeFile(path, body, "utf8");
  return path;
}

function run(scriptPath, { onCall, budgetTotal = null, getBudgetSpent = () => 0 } = {}) {
  return executeWorkflowScript({
    scriptPath,
    seed: 7,
    startTimeMs: 1_700_000_000_000,
    budgetTotal,
    getBudgetSpent,
    onCall: onCall ?? (async () => null),
  }).result;
}

test("ctx.parallel runs all thunks concurrently and returns results in order", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "parallel-demo" };
export default async function run(ctx) {
  const results = await ctx.parallel([
    () => ctx.agent("a"),
    () => ctx.agent("b"),
    () => ctx.agent("c"),
  ]);
  return { results };
}
`);
  let concurrent = 0;
  let peak = 0;
  const result = await run(scriptPath, {
    onCall: async (method, args) => {
      if (method !== "agent") return null;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
      return `R:${args[0]}`;
    },
  });
  assert.deepEqual(result, { results: ["R:a", "R:b", "R:c"] });
  assert.equal(peak, 3, "all three agent bridge calls were in flight at once");
});

test("ctx.parallel turns a throwing thunk into null (never rejects)", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "parallel-throw" };
export default async function run(ctx) {
  const results = await ctx.parallel([
    () => ctx.agent("ok"),
    () => { throw new Error("boom"); },
    async () => { await ctx.agent("also-ok"); throw new Error("late"); },
  ]);
  return { results, filtered: results.filter(Boolean) };
}
`);
  const result = await run(scriptPath, { onCall: async (_m, a) => `R:${a[0]}` });
  assert.deepEqual(result.results, ["R:ok", null, null]);
  assert.deepEqual(result.filtered, ["R:ok"]);
});

test("ctx.pipeline streams each item through all stages; a stage throw drops that item to null", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "pipeline-demo" };
export default async function run(ctx) {
  const out = await ctx.pipeline(
    [1, 2, 3, 4],
    async (n) => { if (n === 3) throw new Error("skip 3"); return n * 10; },
    async (prev, item, i) => ({ prev, item, i }),
  );
  return { out };
}
`);
  const result = await run(scriptPath);
  assert.deepEqual(result.out, [
    { prev: 10, item: 1, i: 0 },
    { prev: 20, item: 2, i: 1 },
    null,
    { prev: 40, item: 4, i: 3 },
  ]);
});

test("ctx.phase() tags subsequent agents with the phase (passed through opts)", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "phase-demo" };
export default async function run(ctx) {
  ctx.phase("build");
  await ctx.agent("compile");
  await ctx.agent("test", { phase: "verify" }); // explicit overrides current
  ctx.phase("ship");
  await ctx.agent("release");
  return {};
}
`);
  const phases = [];
  await run(scriptPath, {
    onCall: async (method, args) => {
      if (method === "agent") phases.push(args[1]?.phase);
      return null;
    },
  });
  assert.deepEqual(phases, ["build", "verify", "ship"]);
});

test("ctx.budget mirrors the parent's live spend across replies", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "budget-demo" };
export default async function run(ctx) {
  const before = { total: ctx.budget.total, spent: ctx.budget.spent(), remaining: ctx.budget.remaining() };
  await ctx.agent("one");
  const mid = { spent: ctx.budget.spent(), remaining: ctx.budget.remaining() };
  await ctx.agent("two");
  const after = { spent: ctx.budget.spent(), remaining: ctx.budget.remaining() };
  return { before, mid, after };
}
`);
  let spent = 0;
  const result = await run(scriptPath, {
    budgetTotal: 1000,
    getBudgetSpent: () => spent,
    onCall: async (method) => {
      if (method === "agent") spent += 30;
      return null;
    },
  });
  assert.deepEqual(result.before, { total: 1000, spent: 0, remaining: 1000 });
  assert.deepEqual(result.mid, { spent: 30, remaining: 970 });
  assert.deepEqual(result.after, { spent: 60, remaining: 940 });
});

test("many concurrent agent() calls keep correct id-correlation through the bridge", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "id-correlation" };
export default async function run(ctx) {
  const results = await ctx.parallel(
    Array.from({ length: 8 }, (_, i) => () => ctx.agent("item-" + i))
  );
  return { results };
}
`);
  const result = await run(scriptPath, {
    // Reply out of order (random-ish delay) to stress id correlation.
    onCall: async (method, args) => {
      if (method !== "agent") return null;
      const n = Number(String(args[0]).split("-")[1]);
      await new Promise((r) => setTimeout(r, (8 - n) * 3));
      return `done-${n}`;
    },
  });
  assert.deepEqual(
    result.results,
    Array.from({ length: 8 }, (_, i) => `done-${i}`),
  );
});
