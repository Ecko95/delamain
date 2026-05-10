// tests/peerKind.test.mjs
//
// Phase 33 plan 01 — schema/normalization tests for PeerKind.
//
// Covers:
//   (a) normalizePeerRecord defaults missing `kind` to "generic"
//   (b) records WITH `kind` are returned unchanged
//   (c) the normaliser is idempotent
//   (d) Phase 33 PeerStatus values pass through normalisation cleanly

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePeerRecord } from "../dist/types.js";

test("normalizePeerRecord defaults missing kind to 'generic'", () => {
  const peer = {
    id: "abc",
    repo: "/tmp/x",
    task: "do thing",
    status: "starting",
    startedAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
    logPath: "/tmp/abc.log",
  };
  const out = normalizePeerRecord(peer);
  assert.equal(out.kind, "generic");
});

test("normalizePeerRecord preserves explicit kind=gsd_phase_batch", () => {
  const peer = {
    id: "abc",
    repo: "/tmp/x",
    task: "GSD frozen batch: 02-task-service",
    status: "gsd_pending",
    startedAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
    logPath: "/tmp/abc.log",
    kind: "gsd_phase_batch",
    gsdBatch: {
      planning_mode: "frozen",
      selected_phases: ["02-task-service"],
      cursor: 0,
    },
  };
  const out = normalizePeerRecord(peer);
  assert.equal(out.kind, "gsd_phase_batch");
  assert.equal(out.status, "gsd_pending");
  assert.deepEqual(out.gsdBatch.selected_phases, ["02-task-service"]);
});

test("normalizePeerRecord preserves explicit kind=generic", () => {
  const peer = {
    id: "abc",
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/l",
    kind: "generic",
  };
  const out = normalizePeerRecord(peer);
  assert.equal(out.kind, "generic");
});

test("normalizePeerRecord is idempotent", () => {
  const peer = {
    id: "x",
    repo: "/r",
    task: "t",
    status: "done",
    startedAt: "t",
    updatedAt: "t",
    logPath: "/l",
  };
  const a = normalizePeerRecord(peer);
  const b = normalizePeerRecord(a);
  assert.deepEqual(a, b);
});

test("normalizePeerRecord accepts all Phase 33 GSD PeerStatus values", () => {
  const phase33Statuses = [
    "gsd_pending",
    "gsd_running_phase",
    "gsd_polling_state",
    "gsd_running_gate_check",
    "gsd_halted_on_gate_failure",
    "gsd_completed",
    "gsd_failed",
  ];
  for (const status of phase33Statuses) {
    const peer = {
      id: status,
      repo: "/r",
      task: "t",
      status,
      startedAt: "t",
      updatedAt: "t",
      logPath: "/l",
      kind: "gsd_phase_batch",
    };
    const out = normalizePeerRecord(peer);
    assert.equal(out.status, status, `status ${status} preserved`);
    assert.equal(out.kind, "gsd_phase_batch");
  }
});
