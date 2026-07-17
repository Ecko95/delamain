// tests/workflowSandbox.test.mjs
//
// SP1 wave 1 sandbox tests: the async ctx bridge round-trips with id
// correlation, determinism shims hold, the AST gate rejects
// require/import/process/eval, the vm global exposes no Node capabilities,
// and kill() terminates a hung script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { executeWorkflowScript, validateWorkflowSource, WorkflowSourceRejectedError } = await import(
  "../dist/workflow/sandbox.js"
);

async function writeScript(body) {
  const dir = await mkdtemp(join(tmpdir(), "wf-sandbox-"));
  const path = join(dir, "workflow.ts");
  await writeFile(path, body, "utf8");
  return path;
}

function run(scriptPath, { onCall, seed = 7, startTimeMs = 1_700_000_000_000 } = {}) {
  return executeWorkflowScript({
    scriptPath,
    seed,
    startTimeMs,
    budgetTotal: null,
    getBudgetSpent: () => 0,
    onCall: onCall ?? (async () => null),
  });
}

test("ctx bridge round-trips agent calls with id correlation and streams logs", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "bridge-demo" };
export default async function run(ctx) {
  ctx.log("starting");
  const [a, b] = await Promise.all([
    ctx.agent("first prompt", { label: "one" }),
    ctx.agent("second prompt"),
  ]);
  console.log("both done");
  return { a, b };
}
`);
  const calls = [];
  const execution = run(scriptPath, {
    onCall: async (method, args) => {
      calls.push({ method, args });
      if (method === "agent") {
        return { echo: args[0] };
      }
      return null;
    },
  });
  const result = await execution.result;
  assert.deepEqual(result, { a: { echo: "first prompt" }, b: { echo: "second prompt" } });
  const agents = calls.filter((c) => c.method === "agent");
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0].args[1], { label: "one" });
  const logs = calls.filter((c) => c.method === "log").map((c) => c.args[0]);
  assert.ok(logs.includes("starting"));
  assert.ok(logs.includes("both done"));
});

test("a bridge error rejects only the matching pending call", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "bridge-errors" };
export default async function run(ctx) {
  let failed = "no";
  try {
    await ctx.agent("explode");
  } catch (error) {
    failed = String(error && error.message || error);
  }
  const ok = await ctx.agent("succeed");
  return { failed, ok };
}
`);
  const execution = run(scriptPath, {
    onCall: async (method, args) => {
      if (args[0] === "explode") throw new Error("agent blew up");
      return "fine";
    },
  });
  assert.deepEqual(await execution.result, { failed: "agent blew up", ok: "fine" });
});

test("determinism shims: seeded Math.random and fixed Date across runs", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "determinism" };
export default async function run(ctx) {
  return {
    randoms: [Math.random(), Math.random(), Math.random()],
    now: Date.now(),
    isoNoArg: new Date().toISOString(),
    isoExplicit: new Date(123456789).toISOString(),
  };
}
`);
  const first = await run(scriptPath, { seed: 99, startTimeMs: 1_700_000_000_000 }).result;
  const second = await run(scriptPath, { seed: 99, startTimeMs: 1_700_000_000_000 }).result;
  assert.deepEqual(first, second);
  assert.equal(first.now, 1_700_000_000_000);
  assert.equal(first.isoNoArg, new Date(1_700_000_000_000).toISOString());
  assert.equal(first.isoExplicit, new Date(123456789).toISOString());
  const third = await run(scriptPath, { seed: 100, startTimeMs: 1_700_000_000_000 }).result;
  assert.notDeepEqual(third.randoms, first.randoms);
});

test("AST gate rejects require / static import / dynamic import / process / eval", () => {
  const cases = [
    'export const meta={name:"x"}; export default async function run(ctx){ const fs = require("node:fs"); }',
    'import fs from "node:fs";\nexport const meta={name:"x"}; export default async function run(ctx){}',
    'export const meta={name:"x"}; export default async function run(ctx){ await import("node:fs"); }',
    'export const meta={name:"x"}; export default async function run(ctx){ return process.env; }',
    'export const meta={name:"x"}; export default async function run(ctx){ eval("1+1"); }',
  ];
  for (const source of cases) {
    assert.throws(() => validateWorkflowSource(source), WorkflowSourceRejectedError, source.slice(0, 40));
  }
});

test("vm global exposes no fs/shell/net capability (only ctx + console + intrinsics)", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "capability-probe" };
export default async function run(ctx) {
  return {
    requireType: typeof globalThis["req" + "uire"],
    processType: typeof globalThis["pro" + "cess"],
    fetchType: typeof globalThis.fetch,
    setTimeoutType: typeof globalThis.setTimeout,
    bufferType: typeof globalThis.Buffer,
    workerType: typeof globalThis.Worker,
    ctxType: typeof ctx.agent,
  };
}
`);
  const result = await run(scriptPath).result;
  assert.deepEqual(result, {
    requireType: "undefined",
    processType: "undefined",
    fetchType: "undefined",
    setTimeoutType: "undefined",
    bufferType: "undefined",
    workerType: "undefined",
    ctxType: "function",
  });
});

test("script throw rejects the execution with the script error", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "thrower" };
export default async function run(ctx) {
  throw new Error("deliberate script failure");
}
`);
  await assert.rejects(run(scriptPath).result, /deliberate script failure/);
});

test("a script without meta or default run is refused", async () => {
  const noMeta = await writeScript(`export default async function run(ctx) { return 1; }`);
  await assert.rejects(run(noMeta).result, /export const meta/);
  const noRun = await writeScript(`export const meta = { name: "n" };`);
  await assert.rejects(run(noRun).result, /export default async function run/);
});

test("kill() terminates a hung script (the engine's timeout path)", async () => {
  const scriptPath = await writeScript(`
export const meta = { name: "hang" };
export default async function run(ctx) {
  await new Promise(() => {});
}
`);
  const execution = run(scriptPath);
  const pending = assert.rejects(execution.result, /killed \(forced-timeout\)/);
  setTimeout(() => execution.kill("forced-timeout"), 100);
  await pending;
});
