// tests/gsdState.test.mjs
//
// Tests for the STATE.md parser. Pattern adapted from the parked
// feat/gsd-sdk-runner branch's tests/gsdState.test.mjs — fake-shim
// integration test pattern only. The parked tests' specific
// HANDOFF-reconciliation assertions are wrong contract per the ADR and
// are not reproduced here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readStateDocument, isPhaseComplete } = await import("../dist/gsdState.js");

async function makeRepo(stateMd) {
  const dir = await mkdtemp(join(tmpdir(), "gsd-state-test-"));
  await mkdir(join(dir, ".planning"), { recursive: true });
  if (stateMd !== null) {
    await writeFile(join(dir, ".planning", "STATE.md"), stateMd, "utf8");
  }
  return dir;
}

// Note on the SDK path: readStateDocument prefers `gsd-sdk query state-document
// --json` when available. If gsd-sdk is on PATH but doesn't implement that
// subcommand (current GSD CLI does not, as of 2026-05-11), spawnSync returns
// non-zero and the parser falls back to direct file read — which is what
// these tests exercise. If a future GSD ships state-document with the
// expected shape, these tests still pass because the SDK output normalises
// to the same GsdStateFrontmatter type.

test("parses minimal STATE.md frontmatter", async () => {
  const dir = await makeRepo(`---\nstatus: in_progress\ncurrent_phase: 02-task-service\n---\n\nbody\n`);
  try {
    const r = await readStateDocument(dir);
    assert.equal(r.status, "in_progress");
    assert.equal(r.current_phase, "02-task-service");
    assert.equal(r.complete, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("derives complete=true when status=complete", async () => {
  const dir = await makeRepo(`---\nstatus: complete\ncurrent_phase: 03-http\n---\n`);
  try {
    const r = await readStateDocument(dir);
    assert.equal(r.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("derives complete=true when phase_status=complete", async () => {
  const dir = await makeRepo(
    `---\nstatus: in_progress\nphase_status: complete\nphase: 02-foo\n---\n`,
  );
  try {
    const r = await readStateDocument(dir);
    assert.equal(r.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("throws GsdStateMissingError when STATE.md is absent", async () => {
  const dir = await makeRepo(null);
  try {
    await assert.rejects(
      () => readStateDocument(dir),
      (err) => err.code === "GSD_STATE_MISSING",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("throws GsdStateMalformedError when frontmatter is missing", async () => {
  const dir = await makeRepo(`no frontmatter at all\nstatus: complete\n`);
  try {
    await assert.rejects(
      () => readStateDocument(dir),
      (err) => err.code === "GSD_STATE_MALFORMED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("isPhaseComplete: returns true when current_phase advanced past phaseId", () => {
  assert.equal(
    isPhaseComplete({ current_phase: "03-http", complete: false }, "02-task-service"),
    true,
  );
});

test("isPhaseComplete: returns true when current_phase equals phaseId AND complete=true", () => {
  assert.equal(
    isPhaseComplete({ current_phase: "02-task-service", complete: true }, "02-task-service"),
    true,
  );
});

test("isPhaseComplete: returns false when current_phase equals phaseId AND complete=false", () => {
  assert.equal(
    isPhaseComplete({ current_phase: "02-task-service", complete: false }, "02-task-service"),
    false,
  );
});

test("isPhaseComplete handles decimal phases (33.1 > 33)", () => {
  assert.equal(
    isPhaseComplete({ current_phase: "33.1-resilience", complete: false }, "33-foo"),
    true,
  );
});

test("HANDOFF.json presence is IGNORED — no read attempt, no influence on parser output", async () => {
  const dir = await makeRepo(`---\nstatus: in_progress\ncurrent_phase: 02\n---\n`);
  try {
    // Drop a HANDOFF.json with deliberately misleading content next to
    // STATE.md. Our parser must not read it; the result is purely from
    // STATE.md.
    await writeFile(
      join(dir, ".planning", "HANDOFF.json"),
      JSON.stringify({ status: "complete", next_action: "lies" }),
      "utf8",
    );
    const r = await readStateDocument(dir);
    assert.equal(r.status, "in_progress");
    assert.equal(r.complete, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
