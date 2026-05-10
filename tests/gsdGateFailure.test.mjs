// tests/gsdGateFailure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { buildGateFailureArtifact, writeGateFailureArtifact } = await import(
  "../dist/gsdGateFailure.js"
);

function makeFailureResult() {
  return {
    pass: false,
    phase_id: "02-task-service",
    checks: [
      {
        dependency_id: "task-store-source",
        extractor: "file_sha256_v1",
        pass: false,
        expected_sha256: "a".repeat(64),
        actual_sha256: "b".repeat(64),
        reason: "sha256 mismatch",
      },
      {
        dependency_id: "task-store-surface",
        extractor: "ts_export_surface_v1",
        pass: false,
        expected_sha256: "c".repeat(64),
        actual_sha256: "d".repeat(64),
        expected_normalized: "x",
        actual_normalized: "y",
        reason: "normalized mismatch",
      },
    ],
    first_mismatch: {
      dependency_id: "task-store-source",
      extractor: "file_sha256_v1",
      pass: false,
      expected_sha256: "a".repeat(64),
      actual_sha256: "b".repeat(64),
      reason: "sha256 mismatch",
    },
    all_mismatches: [
      {
        dependency_id: "task-store-source",
        extractor: "file_sha256_v1",
        pass: false,
        expected_sha256: "a".repeat(64),
        actual_sha256: "b".repeat(64),
        reason: "sha256 mismatch",
      },
      {
        dependency_id: "task-store-surface",
        extractor: "ts_export_surface_v1",
        pass: false,
        expected_sha256: "c".repeat(64),
        actual_sha256: "d".repeat(64),
        expected_normalized: "x",
        actual_normalized: "y",
        reason: "normalized mismatch",
      },
    ],
  };
}

test("buildGateFailureArtifact maps first_mismatch to legacy flat fields", () => {
  const r = makeFailureResult();
  const art = buildGateFailureArtifact(r, "02-task-service");
  assert.equal(art.gate_status, "FAILURE");
  assert.equal(art.planning_mode, "frozen");
  assert.equal(art.dispatched_by, "codex-peers-gsd-runner");
  assert.equal(art.phase_id, "02-task-service");
  assert.equal(art.dependency_id, "task-store-source");
  assert.equal(art.extractor, "file_sha256_v1");
  assert.equal(art.expected_sha256, "a".repeat(64));
  assert.equal(art.actual_sha256, "b".repeat(64));
  assert.equal(art.reason, "sha256 mismatch");
});

test("buildGateFailureArtifact preserves all_mismatches array", () => {
  const r = makeFailureResult();
  const art = buildGateFailureArtifact(r, "02-task-service");
  assert.equal(art.all_mismatches.length, 2);
  assert.deepEqual(
    art.all_mismatches.map((m) => m.dependency_id),
    ["task-store-source", "task-store-surface"],
  );
});

test("buildGateFailureArtifact throws on pass:true input", () => {
  assert.throws(
    () =>
      buildGateFailureArtifact(
        { pass: true, phase_id: "x", checks: [] },
        "x",
      ),
    /pass:true/,
  );
});

test("buildGateFailureArtifact stamps an ISO8601 timestamp", () => {
  const r = makeFailureResult();
  const before = new Date().toISOString();
  const art = buildGateFailureArtifact(r, "02-task-service");
  const after = new Date().toISOString();
  assert.ok(art.checked_at_iso8601 >= before);
  assert.ok(art.checked_at_iso8601 <= after);
});

test("writeGateFailureArtifact creates .planning/dispatch/<phaseId>-GATE-FAILURE.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gate-failure-test-"));
  try {
    const art = buildGateFailureArtifact(makeFailureResult(), "02-task-service");
    const path = await writeGateFailureArtifact(dir, "02-task-service", art);
    assert.equal(
      path,
      join(dir, ".planning", "dispatch", "02-task-service-GATE-FAILURE.json"),
    );
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.gate_status, "FAILURE");
    assert.equal(onDisk.dependency_id, "task-store-source");
    assert.equal(onDisk.all_mismatches.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeGateFailureArtifact creates the .planning/dispatch/ directory if missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gate-failure-test-no-dispatch-"));
  try {
    const art = buildGateFailureArtifact(makeFailureResult(), "07-foo");
    const path = await writeGateFailureArtifact(dir, "07-foo", art);
    const { stat } = await import("node:fs/promises");
    const st = await stat(path);
    assert.ok(st.isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeGateFailureArtifact overwrites existing artifact (latest run wins)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gate-failure-test-overwrite-"));
  try {
    const a1 = buildGateFailureArtifact(makeFailureResult(), "02-x");
    const path = await writeGateFailureArtifact(dir, "02-x", a1);
    const a2 = { ...a1, reason: "newer reason" };
    await writeGateFailureArtifact(dir, "02-x", a2);
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    assert.equal(onDisk.reason, "newer reason");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
