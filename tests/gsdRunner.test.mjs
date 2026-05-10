// tests/gsdRunner.test.mjs
//
// Fake-shim integration tests for the dynamic-mode GSD runner.
// Pattern inspired by feat/gsd-sdk-runner branch's tests/gsdState.test.mjs;
// assertions are Phase 33-specific.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runGsdPhaseBatch } = await import("../dist/gsdRunner.js");

// Note: readStateDocument prefers `gsd-sdk query state-document` when on
// PATH; the current GSD CLI doesn't implement that subcommand so the
// direct file-read fallback is exercised here — which is what these tests
// assert against (the fake codex shim writes STATE.md directly).

async function setupFakeCodex(behaviourBody) {
  const binDir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const script = `#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  const dir = await mkdtemp(join(tmpdir(), "gsd-runner-repo-"));
  await mkdir(join(dir, ".planning"), { recursive: true });
  await writeFile(
    join(dir, ".planning", "STATE.md"),
    initialStateMd ?? `---\nstatus: in_progress\ncurrent_phase: 01-init\n---\n`,
    "utf8",
  );
  return dir;
}

function makeFakeDeps() {
  const log = [];
  const peers = new Map();
  return {
    log,
    peers,
    deps: {
      updatePeer: async (id, patch) => {
        const existing = peers.get(id) ?? {};
        const merged = { ...existing, ...patch, id };
        peers.set(id, merged);
        log.push({ kind: "update", patch });
        return merged;
      },
      appendLog: async (_peer, line) => {
        log.push({ kind: "log", line });
      },
    },
  };
}

test("runGsdPhaseBatch dynamic: completes all phases when codex advances STATE.md each time", async () => {
  const behaviour = `
const phases = ["02-task", "03-http"];
const idx = phases.indexOf(phaseId);
const isLast = idx === phases.length - 1;
writeFileSync(join(stateDir, "STATE.md"),
  isLast
    ? \`---\\nstatus: complete\\ncurrent_phase: \${phaseId}\\n---\\n\`
    : \`---\\nstatus: in_progress\\ncurrent_phase: \${phases[idx + 1]}\\n---\\n\`);
process.exit(0);
`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  const repo = await makeRepo();
  try {
    const { deps, peers } = makeFakeDeps();
    const initial = {
      id: "p1",
      repo,
      task: "test",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(repo, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: { planning_mode: "dynamic", selected_phases: ["02-task", "03-http"], cursor: 0 },
    };
    peers.set("p1", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_completed");
    assert.equal(final.gsdBatch.cursor, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("runGsdPhaseBatch dynamic: halts as gsd_failed when codex exits non-zero", async () => {
  const behaviour = `process.exit(7);`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  const repo = await makeRepo();
  try {
    const { deps, peers } = makeFakeDeps();
    const initial = {
      id: "p2",
      repo,
      task: "t",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(repo, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: { planning_mode: "dynamic", selected_phases: ["02-task"], cursor: 0 },
    };
    peers.set("p2", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_failed");
    assert.equal(final.exitCode, 7);
    assert.ok(final.lastEvent.includes("code 7"));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("runGsdPhaseBatch dynamic: halts when STATE.md did not advance after codex exit 0", async () => {
  // Fake codex exits 0 but does NOT update STATE.md (current_phase stays
  // at 01-init even though we just ran 02-task). The runner must detect this.
  const behaviour = `
writeFileSync(join(stateDir, "STATE.md"),
  \`---\\nstatus: in_progress\\ncurrent_phase: 01-init\\n---\\n\`);
process.exit(0);
`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  const repo = await makeRepo();
  try {
    const { deps, peers } = makeFakeDeps();
    const initial = {
      id: "p3",
      repo,
      task: "t",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(repo, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: { planning_mode: "dynamic", selected_phases: ["02-task"], cursor: 0 },
    };
    peers.set("p3", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_failed");
    assert.ok(final.lastEvent.includes("did not show completion"));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("runGsdPhaseBatch: refuses frozen mode with clear error pointing at plan 33-03", async () => {
  const { deps, peers } = makeFakeDeps();
  const initial = {
    id: "p4",
    repo: "/tmp/x",
    task: "t",
    status: "gsd_pending",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/tmp/p4.log",
    kind: "gsd_phase_batch",
    gsdBatch: { planning_mode: "frozen", selected_phases: ["02"], cursor: 0 },
  };
  peers.set("p4", initial);
  await assert.rejects(
    () => runGsdPhaseBatch(initial, deps),
    (err) => /frozen.*33-03/.test(err.message),
  );
});

test("runGsdPhaseBatch dynamic: cursor mid-batch resumes from cursor (does NOT replay completed phases)", async () => {
  const behaviour = `
const phases = ["02-a", "03-b", "04-c"];
const idx = phases.indexOf(phaseId);
const isLast = idx === phases.length - 1;
writeFileSync(join(stateDir, "STATE.md"),
  isLast
    ? \`---\\nstatus: complete\\ncurrent_phase: \${phaseId}\\n---\\n\`
    : \`---\\nstatus: in_progress\\ncurrent_phase: \${phases[idx + 1]}\\n---\\n\`);
process.exit(0);
`;
  const { bin, binDir } = await setupFakeCodex(behaviour);
  // Seed STATE.md to indicate cursor-position phase (03-b) as the active phase
  // (mid-batch resume — 02-a previously completed).
  const repo = await makeRepo(`---\nstatus: in_progress\ncurrent_phase: 03-b\n---\n`);
  try {
    const { deps, peers, log } = makeFakeDeps();
    const initial = {
      id: "p5",
      repo,
      task: "t",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(repo, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: {
        planning_mode: "dynamic",
        selected_phases: ["02-a", "03-b", "04-c"],
        cursor: 1, // resume at 03-b
      },
    };
    peers.set("p5", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_completed");
    assert.equal(final.gsdBatch.cursor, 3);

    // 02-a should NOT have been re-run: count gsd_running_phase transitions
    // — should be exactly 2 (for 03-b and 04-c), not 3.
    const phaseRunPatches = log.filter(
      (e) => e.kind === "update" && e.patch.status === "gsd_running_phase",
    );
    assert.equal(
      phaseRunPatches.length,
      2,
      `expected 2 gsd_running_phase transitions (03-b, 04-c); got ${phaseRunPatches.length}`,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
