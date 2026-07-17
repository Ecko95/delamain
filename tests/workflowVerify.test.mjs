// tests/workflowVerify.test.mjs
//
// SP1 wave 5 — ctx.verify (adversarial jury) through the REAL sandbox child.
// The parent onCall fakes juror agents by returning a verdict; we assert the
// majority-survive tally, engine/lens rotation, and null-juror tolerance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { executeWorkflowScript } = await import("../dist/workflow/sandbox.js");

async function writeScript(body) {
  const dir = await mkdtemp(join(tmpdir(), "wf-verify-"));
  const path = join(dir, "workflow.ts");
  await writeFile(path, body, "utf8");
  return path;
}

function run(scriptPath, onCall) {
  return executeWorkflowScript({
    scriptPath,
    seed: 3,
    startTimeMs: 1_700_000_000_000,
    budgetTotal: null,
    getBudgetSpent: () => 0,
    onCall,
  }).result;
}

const VERIFY_SCRIPT = (opts) => `
export const meta = { name: "verify-demo" };
export default async function run(ctx) {
  return await ctx.verify("store.ts loses updates under concurrency", ${JSON.stringify(opts)});
}
`;

test("verify survives when a minority refutes (default 3 jurors)", async () => {
  const scriptPath = await writeScript(VERIFY_SCRIPT({}));
  let n = 0;
  const result = await run(scriptPath, async (method) => {
    if (method !== "agent") return null;
    n += 1;
    // 1 of 3 refutes → survives.
    return { refuted: n === 1, reason: `juror ${n}` };
  });
  assert.equal(result.jurors, 3);
  assert.equal(result.refutedCount, 1);
  assert.equal(result.survived, true);
});

test("verify is killed when a strict majority refutes", async () => {
  const scriptPath = await writeScript(VERIFY_SCRIPT({ jurors: 3 }));
  let n = 0;
  const result = await run(scriptPath, async (method) => {
    if (method !== "agent") return null;
    n += 1;
    return { refuted: n <= 2, reason: `juror ${n}` }; // 2 of 3 refute
  });
  assert.equal(result.refutedCount, 2);
  assert.equal(result.survived, false);
});

test("verify rotates engines and lenses across jurors", async () => {
  const scriptPath = await writeScript(VERIFY_SCRIPT({ jurors: 4, lens: ["correctness", "security"], engines: ["codex", "cursor"] }));
  const seenEngines = [];
  const seenPrompts = [];
  await run(scriptPath, async (method, args) => {
    if (method !== "agent") return null;
    seenPrompts.push(args[0]);
    seenEngines.push(args[1]?.engine);
    return { refuted: false, reason: "ok" };
  });
  // 4 jurors alternate codex/cursor and correctness/security.
  assert.deepEqual(seenEngines, ["codex", "cursor", "codex", "cursor"]);
  assert.ok(seenPrompts.some((p) => p.includes("correctness")));
  assert.ok(seenPrompts.some((p) => p.includes("security")));
  assert.ok(seenPrompts.every((p) => /REFUTE/.test(p)), "jurors are adversarial");
});

test("a juror that can't vote (throws) is dropped from the tally, not fatal", async () => {
  const scriptPath = await writeScript(VERIFY_SCRIPT({ jurors: 3 }));
  let n = 0;
  const result = await run(scriptPath, async (method) => {
    if (method !== "agent") return null;
    n += 1;
    if (n === 2) throw new Error("juror 2 died");
    return { refuted: false, reason: "ok" };
  });
  assert.equal(result.jurors, 2, "the dead juror is dropped");
  assert.equal(result.survived, true);
});

test("loop-until-dry example terminates on consecutive dry rounds (fake finders)", async () => {
  const scriptPath = "/srv/gits/repos/delamain/examples/workflows/loop-until-dry.ts";
  let agentCalls = 0;
  const result = await run(scriptPath, async (method) => {
    if (method !== "agent") return null;
    agentCalls += 1;
    // Every finder returns zero bugs → two dry rounds → terminate before maxRounds.
    return { bugs: [] };
  });
  assert.equal(result.confirmed, 0);
  // 2 dry rounds × 3 finders = 6 finder calls, no jurors (nothing fresh to verify).
  assert.equal(agentCalls, 6);
});

test("loop-until-dry confirms a fresh finding via the jury, then goes dry", async () => {
  const scriptPath = "/srv/gits/repos/delamain/examples/workflows/loop-until-dry.ts";
  let round = 0;
  let jurorCalls = 0;
  const result = await run(scriptPath, async (method, args) => {
    if (method !== "agent") return null;
    const prompt = args[0];
    if (/REFUTE/.test(prompt)) { jurorCalls += 1; return { refuted: false, reason: "holds" }; }
    // Finder: round 1 finds one bug, later rounds find nothing.
    round += 1;
    if (round <= 3) return { bugs: round === 1 ? [{ file: "src/x.ts", summary: "leak" }] : [] };
    return { bugs: [] };
  });
  assert.equal(result.confirmed, 1);
  assert.equal(jurorCalls, 3, "one fresh finding → 3 jurors");
});
