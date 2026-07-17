// tests/workflowJail.test.mjs
//
// SP1 wave 2 — OS-jail containment (spec §7). Reuses the Wave-1 vm escape
// (ctx.log.constructor.constructor → host process) and proves that even with
// host `process` in hand the workload cannot (a) open a network socket,
// (b) read a file outside its worktree/scratch, or (c) exec a binary — each
// fails at the kernel. On a host missing a jail primitive, the degraded-mode
// warning is emitted instead; both paths are asserted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await import("../dist/workflow/sandbox.js");
const jail = await import("../dist/workflow/jail.js");

// The escape: get host process, then use getBuiltinModule (Node 22+) to reach
// real fs/net/child_process and attempt the forbidden syscalls.
const ESCAPE_SCRIPT = (secretPath) => `
export const meta = { name: "escape" };
export default async function run(ctx) {
  const proc = ctx.log.constructor.constructor("return process")();
  const out = { reachedProcess: typeof proc === "object" };
  const fs = proc.getBuiltinModule("fs");
  try { out.readOutside = fs.readFileSync(${JSON.stringify(secretPath)}, "utf8"); }
  catch (e) { out.readOutside = e.code || String(e).slice(0, 24); }
  const net = proc.getBuiltinModule("net");
  await new Promise((res) => {
    const s = net.connect(53, "1.1.1.1");
    s.on("error", (e) => { out.socket = e.code || "ERR"; res(); });
    s.on("connect", () => { out.socket = "CONNECTED"; res(); });
  });
  const cp = proc.getBuiltinModule("child_process");
  try { cp.execFileSync("/bin/echo", ["pwned"]); out.exec = "RAN"; }
  catch (e) { out.exec = e.code || String(e).slice(0, 24); }
  return out;
}
`;

async function runEscape(env) {
  const dir = await mkdtemp(join(tmpdir(), "wf-jail-"));
  const secret = join(dir, "tenant-secret.txt");
  const script = join(dir, "escape.ts");
  await writeFile(secret, "TOP SECRET", "utf8");
  await writeFile(script, ESCAPE_SCRIPT(secret), "utf8");
  const warnings = [];
  const saved = process.env.DELAMAIN_SANDBOX_NO_JAIL;
  if (env.noJail) process.env.DELAMAIN_SANDBOX_NO_JAIL = "1";
  else delete process.env.DELAMAIN_SANDBOX_NO_JAIL;
  try {
    const result = await sandbox
      .executeWorkflowScript({
        scriptPath: script,
        seed: 1,
        startTimeMs: 1_700_000_000_000,
        budgetTotal: null,
        getBudgetSpent: () => 0,
        onWarning: (m) => warnings.push(m),
        onCall: async () => null,
      })
      .result;
    return { result, warnings };
  } finally {
    if (saved === undefined) delete process.env.DELAMAIN_SANDBOX_NO_JAIL;
    else process.env.DELAMAIN_SANDBOX_NO_JAIL = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

test("jailed: escaped script cannot socket, read-outside, or exec (kernel-level)", async (t) => {
  const probe = jail.probeJail();
  if (!probe.supported || probe.degraded.length > 0) {
    t.skip(`jail not fully available on this host (${probe.reason ?? "degraded"}); see degraded-mode test`);
    return;
  }
  const { result } = await runEscape({ noJail: false });
  assert.equal(result.reachedProcess, true, "escape reached host process (vm is not the boundary)");
  assert.equal(result.readOutside, "EACCES", "Landlock must deny reading outside the worktree/scratch");
  assert.equal(result.socket, "EPERM", "seccomp must deny opening a network socket");
  assert.equal(result.exec, "EPERM", "Landlock must deny exec of a binary");
});

test("degraded mode (DELAMAIN_SANDBOX_NO_JAIL=1): loud warning, no kernel containment", async () => {
  const { result, warnings } = await runEscape({ noJail: true });
  assert.ok(
    warnings.some((w) => /SANDBOX DEGRADED/.test(w) && /trusted scripts only/.test(w)),
    `expected a loud degraded-mode warning, got: ${JSON.stringify(warnings)}`,
  );
  // With no jail the escape succeeds — proving the jail (not node:vm) is the
  // boundary that stops it in the jailed test above.
  assert.equal(result.reachedProcess, true);
  assert.equal(result.readOutside, "TOP SECRET");
});

test("probeJail reports the layers active on this host", () => {
  const probe = jail.probeJail();
  assert.equal(typeof probe.supported, "boolean");
  assert.ok(probe.layers && typeof probe.layers.landlock === "boolean");
  assert.ok(Array.isArray(probe.degraded));
});

test("jail plan resolves node's real ELF interpreter and grants it EXECUTE", async (t) => {
  if (process.platform !== "linux" || !jail.resolveJailBinary()) {
    t.skip("no jail on this host");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "wf-jail-plan-"));
  try {
    const plan = jail.buildJailPlan({ childPath: process.execPath, scratchDir: dir });
    assert.equal(plan.available, true, `plan should be available on a capable host: ${plan.reason ?? ""}`);
    const execList = plan.env.DELAMAIN_JAIL_EXEC.split(":");
    // node itself is always exec-granted; on a dynamically-linked node the ELF
    // loader is resolved from PT_INTERP and included (not a hard-coded guess).
    assert.ok(execList.some((p) => p.includes("node")), "node binary must be exec-granted");
    assert.ok(
      execList.some((p) => /ld-|ld\.so|ld-linux/.test(p)),
      `dynamic loader should be resolved into the exec list, got: ${plan.env.DELAMAIN_JAIL_EXEC}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
