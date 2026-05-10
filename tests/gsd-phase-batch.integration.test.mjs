// tests/gsd-phase-batch.integration.test.mjs
//
// Phase 33 end-to-end integration test. Spawns a real gsd_phase_batch
// peer (via the peerManager module's spawn + dispatch functions) against
// the Phase 31 fixture's pass-control-v1 and kill-test-v1 tags, exercising
// the full stack:
//
//   spawnGsdPhaseBatch + dispatchGsdPeer
//     → runGsdPhaseBatch (33-02 dynamic + 33-03 frozen)
//       → gateFrozenPhase (Phase 32)
//         → halt-on-failure artifact emission (33-03)
//
// READ-ONLY fixture invariant: tests work against `git clone --no-local`
// temp clones. A suite-level before/after guard snapshots the user's
// fixture HEAD + branch + dirty state and asserts no drift at suite end.
//
// Pattern parallels Phase 32-04's gate.integration.test.ts but operates
// at the peer-manager / runner layer.
//
// Adaptation notes vs the plan template:
// - peerManager exposes functional exports (not a `PeerManager` class),
//   so the test sets process.env.CODEX_PEERS_HOME for isolated state and
//   imports the functions directly.
// - Phase 32-04's Option-A reconciliation is `reExpectSurface` only — the
//   fixture's surface contracts already point at the .ts source; only
//   the normalized form needs recomputing (Phase 31's regex vs Phase 32's
//   tree-sitter form).
// - Phase 31 fixture quirk: `src/task-service.ts` is absent from both
//   tags, so phase 03's gate fails with "artifact missing". Test 1 thus
//   verifies the runner halts at phase 03 with gsd_halted_on_gate_failure
//   (matching Phase 32-04 behaviour) — phase 02 is the only codex-invoked
//   phase in the happy-path test. The user's directive: "halts cleanly on
//   missing-artifact contract for phase 03 per Phase 32-04's reframing".

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// Provision an isolated peers home BEFORE importing peerManager so its
// internal state dir resolves under our control.
const PEERS_HOME = await mkdtemp(join(tmpdir(), "peer-mgr-33-05-home-"));
process.env.CODEX_PEERS_HOME = PEERS_HOME;

const {
  spawnGsdPhaseBatch,
  dispatchGsdPeer,
  _awaitGsdRunner,
} = await import("../dist/peerManager.js");
const { extractTsExportSurface } = await import(
  "../dist/frozen-gate/extractors/index.js"
);

const FIXTURE_REPO = join(homedir(), "dev", "fixtures", "frozen-batch");

// --- Fixture invariant guards ---------------------------------------------

let fixturePreSha;
let fixturePreBranch;
let fixturePreDirty;

before(async () => {
  const exists = await stat(FIXTURE_REPO).then(() => true, () => false);
  if (!exists) {
    throw new Error(
      `Phase 33-05 integration test requires Phase 31 fixture at ${FIXTURE_REPO}. Aborting — install fixture or run Phase 31 setup.`,
    );
  }
  fixturePreSha = spawnSync("git", ["-C", FIXTURE_REPO, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  fixturePreBranch = spawnSync(
    "git",
    ["-C", FIXTURE_REPO, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" },
  ).stdout.trim();
  fixturePreDirty = spawnSync("git", ["-C", FIXTURE_REPO, "status", "-s"], {
    encoding: "utf8",
  }).stdout.trim();

  // Sanity: both pinned tags must be present (Rule 4 — surface loudly).
  const tags = spawnSync(
    "git",
    ["-C", FIXTURE_REPO, "tag", "--list", "pass-control-v1", "kill-test-v1"],
    { encoding: "utf8" },
  ).stdout.trim();
  for (const tag of ["pass-control-v1", "kill-test-v1"]) {
    if (!tags.split(/\r?\n/).includes(tag)) {
      throw new Error(
        `Phase 33-05 integration test requires tag ${tag} on ${FIXTURE_REPO}. Found tags: ${tags}`,
      );
    }
  }
});

after(async () => {
  const postSha = spawnSync(
    "git",
    ["-C", FIXTURE_REPO, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).stdout.trim();
  const postBranch = spawnSync(
    "git",
    ["-C", FIXTURE_REPO, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" },
  ).stdout.trim();
  const postDirty = spawnSync(
    "git",
    ["-C", FIXTURE_REPO, "status", "-s"],
    { encoding: "utf8" },
  ).stdout.trim();
  assert.equal(
    postSha,
    fixturePreSha,
    "fixture HEAD must not change across the suite",
  );
  assert.equal(postBranch, fixturePreBranch, "fixture branch must not change");
  assert.equal(
    postDirty,
    fixturePreDirty,
    "fixture working tree must not change",
  );
  await rm(PEERS_HOME, { recursive: true, force: true });
});

// --- Helpers (mirror Phase 32-04's pattern) -------------------------------

async function cloneFixtureAt(tag) {
  const dir = await mkdtemp(join(tmpdir(), `frozen-batch-33-05-${tag}-`));
  let r = spawnSync(
    "git",
    ["clone", "--no-local", "--quiet", FIXTURE_REPO, dir],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    r = spawnSync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--no-local",
        "--quiet",
        FIXTURE_REPO,
        dir,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(`git clone --no-local failed: ${r.stderr || r.stdout}`);
    }
  }
  const co = spawnSync("git", ["-C", dir, "checkout", "--quiet", tag], {
    encoding: "utf8",
  });
  if (co.status !== 0) {
    throw new Error(`git checkout ${tag} failed: ${co.stderr || co.stdout}`);
  }
  return dir;
}

/**
 * Phase 32-04 Option-A reconciliation: recompute expected_sha256 +
 * expected_normalized for a surface contract using Phase 32's tree-sitter
 * extractor against `canonicalRepo`/`canonicalSourcePath`.
 */
async function reExpectSurface(
  targetRepo,
  phaseId,
  dependencyId,
  canonicalRepo,
  canonicalSourcePath,
) {
  const surface = await extractTsExportSurface(
    canonicalRepo,
    canonicalSourcePath,
  );
  const numericPrefix = phaseId.match(/^(\d+)/)[1];
  const contractPath = join(
    targetRepo,
    ".planning",
    "phases",
    phaseId,
    `${numericPrefix}-FROZEN-CONTRACT.json`,
  );
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  for (const c of contract.contracts) {
    if (c.dependency_id === dependencyId) {
      c.expected_sha256 = surface.sha256;
      c.expected_normalized = surface.normalized;
    }
  }
  await writeFile(
    contractPath,
    JSON.stringify(contract, null, 2) + "\n",
    "utf8",
  );
}

async function seedStateMd(repo, currentPhase) {
  await mkdir(join(repo, ".planning"), { recursive: true });
  await writeFile(
    join(repo, ".planning", "STATE.md"),
    `---\nstatus: in_progress\ncurrent_phase: ${currentPhase}\n---\n`,
    "utf8",
  );
}

async function setupFakeCodexShim(behaviour) {
  const binDir = await mkdtemp(join(tmpdir(), "fake-codex-33-05-"));
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

// --- Test 1: pass-control happy-path-with-fixture-quirk -------------------
//
// Drives a frozen-mode batch [02-task-service, 03-http-integration]
// against pass-control-v1. Phase 02's gate passes after reExpectSurface;
// the fake-codex shim advances STATE.md to mark phase 02 complete; the
// runner advances to phase 03; phase 03's gate FAILS because the fixture
// is missing src/task-service.ts (artifact missing) — runner halts at
// phase 03 with gsd_halted_on_gate_failure. Exactly ONE codex invocation
// (phase 02) is observed.

test(
  "pass-control-v1: frozen-mode batch [02,03] — phase 02 codex-invoked, phase 03 halts on missing artifact",
  async () => {
    const tmpClone = await cloneFixtureAt("pass-control-v1");
    try {
      await reExpectSurface(
        tmpClone,
        "02-task-service",
        "task-store-surface",
        tmpClone,
        "src/task-store.ts",
      );
      // Phase 03's surface contract is rebuilt against the canonical
      // pass-control-v1 task-store-surface contract pattern. We can't
      // recompute against task-service.ts because the fixture does not
      // contain it — gateFrozenPhase will surface that as the
      // "artifact missing" check failure. Leave phase 03 untouched.

      await seedStateMd(tmpClone, "02-task-service");

      // Fake-codex shim: simulates /gsd-execute-phase by writing STATE.md
      // to mark the current phase complete with current_phase=<phaseId>.
      // The runner's isPhaseComplete() returns true when
      // current_phase === phaseId AND complete===true.
      const { bin, binDir } = await setupFakeCodexShim(`
writeFileSync(join(stateDir, "STATE.md"),
  \`---\\nstatus: complete\\ncurrent_phase: \${phaseId}\\n---\\n\`);
process.exit(0);
`);

      try {
        const peer = spawnGsdPhaseBatch({
          repo: tmpClone,
          gsdBatch: {
            planning_mode: "frozen",
            selected_phases: ["02-task-service", "03-http-integration"],
            cursor: 0,
          },
        });
        await dispatchGsdPeer(peer.id, { codexBin: bin });
        const final = await _awaitGsdRunner(peer.id);

        // Assertion 1: halted on phase 03's missing-artifact gate failure.
        assert.equal(
          final.status,
          "gsd_halted_on_gate_failure",
          `expected gsd_halted_on_gate_failure (phase 03 missing artifact), got ${final.status}: ${final.lastEvent}`,
        );
        // Cursor sits at 1 (phase 02 advanced, phase 03 halted).
        assert.equal(
          final.gsdBatch.cursor,
          1,
          `expected cursor=1 (halt at phase 03), got ${final.gsdBatch.cursor}`,
        );

        // Assertion 2: phase 02 was the only codex invocation (exactly once).
        const invocations = (
          await readFile(
            join(tmpClone, ".fake-codex-invocations.log"),
            "utf8",
          )
        )
          .trim()
          .split("\n");
        assert.deepEqual(
          invocations,
          ["02-task-service"],
          "phase 02 must be invoked exactly once and phase 03 must NOT be invoked (halt before codex)",
        );

        // Assertion 3: phase 03 gate-failure artifact exists, references
        // missing artifact reason, dispatched_by codex-peers-gsd-runner.
        const phase03Artifact = join(
          tmpClone,
          ".planning",
          "dispatch",
          "03-http-integration-GATE-FAILURE.json",
        );
        const onDisk = JSON.parse(await readFile(phase03Artifact, "utf8"));
        assert.equal(onDisk.gate_status, "FAILURE");
        assert.equal(onDisk.planning_mode, "frozen");
        assert.equal(onDisk.dispatched_by, "codex-peers-gsd-runner");
        assert.equal(onDisk.phase_id, "03-http-integration");
        // Both contracts reference src/task-service.ts (file_sha256 +
        // ts_export_surface), so both fail with "artifact missing".
        assert.equal(
          onDisk.all_mismatches.length,
          2,
          "both phase-03 extractors must report artifact missing",
        );
        for (const m of onDisk.all_mismatches) {
          assert.ok(
            typeof m.reason === "string" && m.reason.includes("artifact missing"),
            `expected reason to include 'artifact missing', got ${m.reason}`,
          );
        }

        // Assertion 4: no gate-failure artifact written for phase 02 (it passed).
        const phase02Artifact = join(
          tmpClone,
          ".planning",
          "dispatch",
          "02-task-service-GATE-FAILURE.json",
        );
        const phase02ArtifactExists = await stat(phase02Artifact).then(
          () => true,
          () => false,
        );
        assert.equal(
          phase02ArtifactExists,
          false,
          "phase 02 must not have a gate-failure artifact (it passed)",
        );

        // Assertion 5: peer log contains gate PASS line for phase 02.
        const peerLog = await readFile(final.logPath, "utf8");
        assert.match(
          peerLog,
          /phase 02-task-service \(frozen\): gate PASS/,
          "missing gate PASS line for phase 02",
        );
        assert.match(
          peerLog,
          /phase 03-http-integration \(frozen\): GATE FAILURE/,
          "missing GATE FAILURE marker for phase 03",
        );
      } finally {
        await rm(binDir, { recursive: true, force: true });
      }
    } finally {
      await rm(tmpClone, { recursive: true, force: true });
    }
  },
);

// --- Test 2: kill-test halt (v8.0 thesis through full stack) --------------

test(
  "kill-test-v1: frozen-mode batch halts at phase 02 with gate failure — v8.0 thesis re-validated end-to-end",
  async () => {
    const canonical = await cloneFixtureAt("pass-control-v1");
    const subject = await cloneFixtureAt("kill-test-v1");
    try {
      // Recompute canonical task-store-surface expected_* from the
      // pass-control source and patch the kill-test contract. Leave
      // file_sha256 expected untouched — it matches canonical bytes; the
      // kill-test's mutated task-store.ts will trip it.
      await reExpectSurface(
        subject,
        "02-task-service",
        "task-store-surface",
        canonical,
        "src/task-store.ts",
      );

      await seedStateMd(subject, "02-task-service");

      // Fake-codex shim: exits 99 if invoked. The v8.0 thesis is that
      // on gate failure, codex must NOT be spawned at all.
      const { bin, binDir } = await setupFakeCodexShim(`
process.stderr.write("ERROR: fake-codex was invoked but kill-test should halt before codex spawn\\n");
process.exit(99);
`);

      try {
        // Snapshot src/task-service.ts is NOT present in kill-test-v1
        // either (same fixture quirk as pass-control); the load-bearing
        // mutation is in src/task-store.ts. Snapshot src/task-store.ts so
        // we can assert the gate-halt prevents any source mutation.
        const taskStoreBeforeSha = createHash("sha256")
          .update(await readFile(join(subject, "src", "task-store.ts")))
          .digest("hex");

        const peer = spawnGsdPhaseBatch({
          repo: subject,
          gsdBatch: {
            planning_mode: "frozen",
            selected_phases: ["02-task-service", "03-http-integration"],
            cursor: 0,
          },
        });
        await dispatchGsdPeer(peer.id, { codexBin: bin });
        const final = await _awaitGsdRunner(peer.id);

        // Assertion 1: status is gsd_halted_on_gate_failure (NOT gsd_failed).
        assert.equal(
          final.status,
          "gsd_halted_on_gate_failure",
          `expected gsd_halted_on_gate_failure (the kill-test halt), got ${final.status}: ${final.lastEvent}`,
        );

        // Assertion 2: cursor stayed at 0 (the batch did not advance).
        assert.equal(
          final.gsdBatch.cursor,
          0,
          `expected cursor=0 (no phase advanced), got ${final.gsdBatch.cursor}`,
        );

        // Assertion 3: gate-failure artifact for phase 02 with the
        // canonical shape, all_mismatches.length === 2 (both extractors).
        const artifactPath = join(
          subject,
          ".planning",
          "dispatch",
          "02-task-service-GATE-FAILURE.json",
        );
        const onDisk = JSON.parse(await readFile(artifactPath, "utf8"));
        assert.equal(onDisk.gate_status, "FAILURE");
        assert.equal(onDisk.dispatched_by, "codex-peers-gsd-runner");
        assert.equal(onDisk.planning_mode, "frozen");
        assert.equal(onDisk.phase_id, "02-task-service");
        assert.equal(
          onDisk.all_mismatches.length,
          2,
          "the v8.0 kill-test thesis: BOTH file_sha256_v1 and ts_export_surface_v1 detect drift",
        );
        const ids = new Set(onDisk.all_mismatches.map((m) => m.dependency_id));
        assert.ok(
          ids.has("task-store-source"),
          "task-store-source must be in all_mismatches",
        );
        assert.ok(
          ids.has("task-store-surface"),
          "task-store-surface must be in all_mismatches",
        );

        // Assertion 4: zero codex invocations. The shim's invocations
        // log must not exist OR must be empty.
        let invocations = "";
        try {
          invocations = await readFile(
            join(subject, ".fake-codex-invocations.log"),
            "utf8",
          );
        } catch {
          /* file absent is the strongest evidence */
        }
        assert.equal(
          invocations.trim(),
          "",
          "v8.0 thesis: codex must NOT be invoked when the gate fails — source mutation prevented",
        );

        // Assertion 5: phase 03 was never inspected (no phase-03 artifact).
        const phase03Artifact = join(
          subject,
          ".planning",
          "dispatch",
          "03-http-integration-GATE-FAILURE.json",
        );
        const phase03Exists = await stat(phase03Artifact).then(
          () => true,
          () => false,
        );
        assert.equal(
          phase03Exists,
          false,
          "phase 03 must not be inspected after phase 02 halts",
        );

        // Assertion 6: src/task-store.ts is byte-for-byte unchanged.
        // (No codex invocation = no source mutation. This is the v8.0
        // thesis at the file-mutation level.)
        const taskStoreAfterSha = createHash("sha256")
          .update(await readFile(join(subject, "src", "task-store.ts")))
          .digest("hex");
        assert.equal(
          taskStoreAfterSha,
          taskStoreBeforeSha,
          "phase 02's source file must not have been touched by the halted batch",
        );
      } finally {
        await rm(binDir, { recursive: true, force: true });
      }
    } finally {
      await rm(canonical, { recursive: true, force: true });
      await rm(subject, { recursive: true, force: true });
    }
  },
);
