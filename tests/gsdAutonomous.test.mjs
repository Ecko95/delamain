// tests/gsdAutonomous.test.mjs
//
// SP1 wave 7 — autonomous GSD on the engine: the gsd.ts preset over the proven
// phase loop. Covers stuck-detection (one diagnostic retry), the hard wall-clock
// ceiling, lifecycle event emission, and deriveState — all with the fake-codex
// shim pattern from gsdRunner.test.mjs (no real codex).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runAutonomousGsd, deriveState } = await import("../dist/workflow/gsd.js");

async function setupFakeCodex(behaviourBody) {
  const binDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const script = `#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const cwdIdx = argv.indexOf("--cwd");
const repo = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
const onlyIdx = argv.indexOf("--only");
const phaseId = onlyIdx >= 0 ? argv[onlyIdx + 1] : argv[argv.length - 1];
const stateDir = join(repo, ".planning");
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
${behaviourBody}
`;
  const bin = join(binDir, "codex");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { bin, binDir };
}

async function makeRepo(initialStateMd) {
  const dir = await mkdtemp(join(tmpdir(), "gsd-auto-repo-"));
  await mkdir(join(dir, ".planning"), { recursive: true });
  await writeFile(join(dir, ".planning", "STATE.md"), initialStateMd ?? `---\nstatus: in_progress\ncurrent_phase: 01-init\n---\n`, "utf8");
  return dir;
}

function makeFakeDeps() {
  const peers = new Map();
  return {
    peers,
    deps: {
      updatePeer: async (id, patch) => {
        const merged = { ...(peers.get(id) ?? {}), ...patch, id };
        peers.set(id, merged);
        return merged;
      },
      appendLog: async () => {},
    },
  };
}

function batch(phases) {
  return { planning_mode: "dynamic", selected_phases: phases, cursor: 0 };
}

test("deriveState advances the cursor past phases STATE.md marks complete", async () => {
  const repo = await makeRepo(`---\nstatus: complete\ncurrent_phase: 01-init\n---\n`);
  try {
    const d = await deriveState(repo, ["01-init", "02-task"]);
    assert.equal(d.cursor, 1);
    assert.equal(d.nextPhase, "02-task");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("deriveState with missing STATE.md starts at the first phase", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gsd-nostate-"));
  try {
    const d = await deriveState(dir, ["01-init"]);
    assert.equal(d.cursor, 0);
    assert.equal(d.nextPhase, "01-init");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stuck-detection: a phase that doesn't advance on the first try gets ONE retry, then completes", async () => {
  // The fake advances STATE.md to complete only on its 2nd invocation for a phase.
  const behaviour = `
const marker = join(stateDir, ".attempts");
let n = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
n += 1;
writeFileSync(marker, String(n));
if (n >= 2) {
  writeFileSync(join(stateDir, "STATE.md"), \`---\\nstatus: complete\\ncurrent_phase: 02-task\\n---\\n\`);
} else {
  writeFileSync(join(stateDir, "STATE.md"), \`---\\nstatus: in_progress\\ncurrent_phase: 01-init\\n---\\n\`);
}
process.exit(0);
`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  const repo = await makeRepo();
  try {
    const { deps, peers } = makeFakeDeps();
    const events = [];
    const peer = { id: "auto-1", repo, task: "t", status: "gsd_pending", startedAt: "t", updatedAt: "t", logPath: join(repo, "p.log"), kind: "gsd_phase_batch", gsdBatch: batch(["02-task"]) };
    peers.set(peer.id, peer);
    const final = await runAutonomousGsd(peer, deps, { codexBin: bin, emitEvent: (type, payload) => events.push({ type, payload }) });
    assert.equal(final.status, "gsd_completed", `expected completion after the diagnostic retry; got ${final.status} (${final.lastEvent})`);
    assert.ok(events.some((e) => e.type === "phase_retry"), "a phase_retry event should be emitted");
    assert.equal(events.at(-1).type, "workflow_end");
    assert.equal(events.at(-1).payload.status, "gsd_completed");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("stuck-detection: still not advancing after the retry halts as gsd_failed (after 2 attempts)", async () => {
  const behaviour = `
writeFileSync(join(stateDir, "STATE.md"), \`---\\nstatus: in_progress\\ncurrent_phase: 01-init\\n---\\n\`);
process.exit(0);
`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  const repo = await makeRepo();
  try {
    const { deps, peers } = makeFakeDeps();
    const peer = { id: "auto-2", repo, task: "t", status: "gsd_pending", startedAt: "t", updatedAt: "t", logPath: join(repo, "p.log"), kind: "gsd_phase_batch", gsdBatch: batch(["02-task"]) };
    peers.set(peer.id, peer);
    const final = await runAutonomousGsd(peer, deps, { codexBin: bin, emitEvent: () => {} });
    assert.equal(final.status, "gsd_failed");
    assert.ok(final.lastEvent.includes("after 2 attempts"), `expected 'after 2 attempts' in: ${final.lastEvent}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("hard timeout halts the batch before starting a later phase", async () => {
  // Fake advances every phase; a now() shim jumps past the ceiling before phase 2.
  const behaviour = `
const phases = ["01-a", "02-b"];
const idx = phases.indexOf(phaseId);
const next = idx + 1 < phases.length ? phases[idx + 1] : phaseId;
writeFileSync(join(stateDir, "STATE.md"), \`---\\nstatus: \${idx + 1 >= phases.length ? "complete" : "in_progress"}\\ncurrent_phase: \${idx + 1 >= phases.length ? phaseId : next}\\n---\\n\`);
process.exit(0);
`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  const repo = await makeRepo();
  try {
    const { deps, peers } = makeFakeDeps();
    const peer = { id: "auto-3", repo, task: "t", status: "gsd_pending", startedAt: "t", updatedAt: "t", logPath: join(repo, "p.log"), kind: "gsd_phase_batch", gsdBatch: batch(["01-a", "02-b"]) };
    peers.set(peer.id, peer);
    // now() calls: batchStart, before-phase-0, before-phase-1 → jump on the 3rd.
    const seq = [0, 0, 100000];
    let k = 0;
    const now = () => seq[Math.min(k++, seq.length - 1)];
    const final = await runAutonomousGsd(peer, deps, { codexBin: bin, hardTimeoutMs: 1000, now, emitEvent: () => {} });
    assert.equal(final.status, "gsd_failed");
    assert.ok(final.lastEvent.includes("hard timeout"), `expected hard timeout halt, got: ${final.lastEvent}`);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
