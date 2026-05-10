// tests/gsdRunnerFrozen.test.mjs
//
// Frozen-mode runner tests: gate-pass happy path, gate-fail halt with
// artifact emission, malformed-contract setup-error path, no-codex-call
// invariant on halt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runGsdPhaseBatch } = await import("../dist/gsdRunner.js");

async function setupFakeCodex(behaviour) {
  const binDir = await mkdtemp(join(tmpdir(), "fake-codex-frozen-"));
  const script = `#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const cwdIdx = argv.indexOf("--cwd");
const repo = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
// Frozen-mode args: ... -- /gsd-execute-phase <phaseId> --no-transition
const dashDash = argv.indexOf("--");
const phaseId = dashDash >= 0 && argv[dashDash + 1] === "/gsd-execute-phase" ? argv[dashDash + 2] : "?";
appendFileSync(join(repo, ".fake-codex-invocations.log"), phaseId + "\\n");
const stateDir = join(repo, ".planning");
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
${behaviour}
`;
  const bin = join(binDir, "codex");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  return { bin, binDir };
}

async function makeRepoWithContract(phaseId, contractEntries, artifactFiles) {
  const dir = await mkdtemp(join(tmpdir(), "gsd-runner-frozen-repo-"));
  await mkdir(join(dir, ".planning", "phases", phaseId), { recursive: true });
  const numericPrefix = phaseId.match(/^(\d+)/)[1];
  await writeFile(
    join(dir, ".planning", "phases", phaseId, `${numericPrefix}-FROZEN-CONTRACT.json`),
    JSON.stringify({ phase_id: phaseId, contracts: contractEntries }, null, 2),
    "utf8",
  );
  for (const [rel, content] of Object.entries(artifactFiles ?? {})) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  // Seed an in_progress STATE.md so the runner starts with something parseable.
  await writeFile(
    join(dir, ".planning", "STATE.md"),
    `---\nstatus: in_progress\ncurrent_phase: 00-init\n---\n`,
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
        log.push({ kind: "update", status: patch.status, lastEvent: patch.lastEvent });
        return merged;
      },
      appendLog: async (_peer, line) => {
        log.push({ kind: "log", line });
      },
    },
  };
}

test("frozen mode: gate PASS leads to gsd_running_phase + codex invocation", async () => {
  // Hand-craft a contract that gateFrozenPhase will pass: file_sha256 against
  // a known artifact whose sha matches.
  const { createHash } = await import("node:crypto");
  const content = "export const x = 1;\n";
  const sha = createHash("sha256").update(content).digest("hex");
  const repo = await makeRepoWithContract(
    "02-foo",
    [
      {
        dependency_id: "src",
        artifact_path: "src/x.ts",
        extractor: "file_sha256_v1",
        expected_sha256: sha,
        expected_normalized: null,
      },
    ],
    { "src/x.ts": content },
  );
  // Fake codex marks STATE.md complete on exit 0.
  const { bin, binDir } = await setupFakeCodex(`
writeFileSync(join(stateDir, "STATE.md"),
  \`---\\nstatus: complete\\ncurrent_phase: \${phaseId}\\n---\\n\`);
process.exit(0);
`);
  try {
    const { deps, peers, log } = makeFakeDeps();
    const initial = {
      id: "p1",
      repo,
      task: "t",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(repo, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: { planning_mode: "frozen", selected_phases: ["02-foo"], cursor: 0 },
    };
    peers.set("p1", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_completed");
    const statuses = log.filter((e) => e.kind === "update").map((e) => e.status);
    assert.ok(statuses.includes("gsd_running_gate_check"));
    assert.ok(statuses.includes("gsd_running_phase"));
    const invocations = (await readFile(join(repo, ".fake-codex-invocations.log"), "utf8"))
      .trim()
      .split("\n");
    assert.deepEqual(invocations, ["02-foo"]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("frozen mode: gate FAIL leads to gsd_halted_on_gate_failure + artifact + no codex call", async () => {
  // Contract expects sha that won't match the actual file.
  const repo = await makeRepoWithContract(
    "02-foo",
    [
      {
        dependency_id: "src",
        artifact_path: "src/x.ts",
        extractor: "file_sha256_v1",
        expected_sha256: "a".repeat(64),
        expected_normalized: null,
      },
    ],
    { "src/x.ts": "different content\n" },
  );
  const { bin, binDir } = await setupFakeCodex(`process.exit(99); // should never run`);
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
      gsdBatch: { planning_mode: "frozen", selected_phases: ["02-foo"], cursor: 0 },
    };
    peers.set("p2", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_halted_on_gate_failure");
    let invocations = "";
    try {
      invocations = await readFile(join(repo, ".fake-codex-invocations.log"), "utf8");
    } catch {}
    assert.equal(invocations.trim(), "", "codex must not be invoked when gate fails");
    const artifactPath = join(repo, ".planning", "dispatch", "02-foo-GATE-FAILURE.json");
    const onDisk = JSON.parse(await readFile(artifactPath, "utf8"));
    assert.equal(onDisk.gate_status, "FAILURE");
    assert.equal(onDisk.dependency_id, "src");
    assert.equal(onDisk.expected_sha256, "a".repeat(64));
    assert.ok(Array.isArray(onDisk.all_mismatches));
    assert.equal(onDisk.all_mismatches.length, 1);
    assert.equal(onDisk.dispatched_by, "codex-peers-gsd-runner");
    assert.equal(onDisk.planning_mode, "frozen");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("frozen mode: multi-mismatch contract emits all_mismatches.length === 2 in the artifact", async () => {
  const repo = await makeRepoWithContract(
    "02-foo",
    [
      {
        dependency_id: "src-a",
        artifact_path: "src/a.ts",
        extractor: "file_sha256_v1",
        expected_sha256: "a".repeat(64),
        expected_normalized: null,
      },
      {
        dependency_id: "src-b",
        artifact_path: "src/b.ts",
        extractor: "file_sha256_v1",
        expected_sha256: "b".repeat(64),
        expected_normalized: null,
      },
    ],
    { "src/a.ts": "drift a\n", "src/b.ts": "drift b\n" },
  );
  const { bin, binDir } = await setupFakeCodex(`process.exit(0);`);
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
      gsdBatch: { planning_mode: "frozen", selected_phases: ["02-foo"], cursor: 0 },
    };
    peers.set("p3", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_halted_on_gate_failure");
    const onDisk = JSON.parse(
      await readFile(join(repo, ".planning", "dispatch", "02-foo-GATE-FAILURE.json"), "utf8"),
    );
    assert.equal(onDisk.all_mismatches.length, 2);
    assert.deepEqual(
      new Set(onDisk.all_mismatches.map((m) => m.dependency_id)),
      new Set(["src-a", "src-b"]),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("frozen mode: malformed FROZEN-CONTRACT.json → gsd_failed (NOT gsd_halted_on_gate_failure)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gsd-runner-bad-contract-"));
  await mkdir(join(dir, ".planning", "phases", "02-foo"), { recursive: true });
  await writeFile(
    join(dir, ".planning", "phases", "02-foo", "02-FROZEN-CONTRACT.json"),
    "{not valid json",
    "utf8",
  );
  const { bin, binDir } = await setupFakeCodex(`process.exit(0);`);
  try {
    const { deps, peers } = makeFakeDeps();
    const initial = {
      id: "p4",
      repo: dir,
      task: "t",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(dir, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: { planning_mode: "frozen", selected_phases: ["02-foo"], cursor: 0 },
    };
    peers.set("p4", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_failed", "malformed contract is a setup error, not a mismatch halt");
    assert.ok(
      final.lastEvent.includes("malformed") || final.lastEvent.includes("gateFrozenPhase threw"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});

test("frozen mode: phase with no FROZEN-CONTRACT.json trivially passes the gate and proceeds", async () => {
  // gateFrozenPhase returns pass:true with empty checks when the contract
  // file doesn't exist (per Phase 32-04 Task 2). The runner should treat
  // this as gate-pass and call codex normally.
  const dir = await mkdtemp(join(tmpdir(), "gsd-runner-no-contract-"));
  await mkdir(join(dir, ".planning"), { recursive: true });
  await writeFile(
    join(dir, ".planning", "STATE.md"),
    `---\nstatus: in_progress\ncurrent_phase: 00-init\n---\n`,
    "utf8",
  );
  const { bin, binDir } = await setupFakeCodex(`
writeFileSync(join(stateDir, "STATE.md"),
  \`---\\nstatus: complete\\ncurrent_phase: \${phaseId}\\n---\\n\`);
process.exit(0);
`);
  try {
    const { deps, peers } = makeFakeDeps();
    const initial = {
      id: "p5",
      repo: dir,
      task: "t",
      status: "gsd_pending",
      startedAt: "t",
      updatedAt: "t",
      logPath: join(dir, "peer.log"),
      kind: "gsd_phase_batch",
      gsdBatch: { planning_mode: "frozen", selected_phases: ["05-no-contract"], cursor: 0 },
    };
    peers.set("p5", initial);
    const final = await runGsdPhaseBatch(initial, deps, { codexBin: bin });
    assert.equal(final.status, "gsd_completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
});
