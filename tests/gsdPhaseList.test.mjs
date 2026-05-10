// tests/gsdPhaseList.test.mjs
//
// Phase 33 plan 01 — phase-ID parsing and range expansion tests for
// spawn_gsd_phase_batch / inspect_gsd_milestone helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandSelectedPhases,
  parsePhaseId,
  InvalidPhaseRangeError,
} from "../dist/gsdPhaseList.js";

test("parsePhaseId accepts NN-slug", () => {
  const r = parsePhaseId("02-task-service");
  assert.equal(r.prefix, "02");
  assert.equal(r.slug, "task-service");
});

test("parsePhaseId accepts NN.M-slug (decimal phase)", () => {
  const r = parsePhaseId("33.1-resilience");
  assert.equal(r.prefix, "33.1");
});

test("parsePhaseId accepts bare numeric prefix", () => {
  const r = parsePhaseId("02");
  assert.equal(r.prefix, "02");
  assert.equal(r.slug, undefined);
});

test("parsePhaseId rejects malformed IDs", () => {
  assert.throws(() => parsePhaseId(""), InvalidPhaseRangeError);
  assert.throws(() => parsePhaseId("abc"), InvalidPhaseRangeError);
  assert.throws(() => parsePhaseId("-no-prefix"), InvalidPhaseRangeError);
});

test("expandSelectedPhases passes through exact IDs", () => {
  const out = expandSelectedPhases(["02-task-service", "03-http-integration"]);
  assert.deepEqual(out, ["02-task-service", "03-http-integration"]);
});

test("expandSelectedPhases deduplicates while preserving order", () => {
  const out = expandSelectedPhases(["02-a", "02-a", "03-b"]);
  assert.deepEqual(out, ["02-a", "03-b"]);
});

test("expandSelectedPhases requires known phases for ranges", () => {
  assert.throws(() => expandSelectedPhases(["02..04"]), InvalidPhaseRangeError);
});

test("expandSelectedPhases expands NN..NN ranges via known phase list", () => {
  const known = ["01-foo", "02-bar", "03-baz", "04-qux"];
  const out = expandSelectedPhases(["02..03"], known);
  assert.deepEqual(out, ["02-bar", "03-baz"]);
});

test("expandSelectedPhases expands full-ID..full-ID ranges", () => {
  const known = ["01-foo", "02-bar", "03-baz", "04-qux"];
  const out = expandSelectedPhases(["02-bar..04-qux"], known);
  assert.deepEqual(out, ["02-bar", "03-baz", "04-qux"]);
});

test("expandSelectedPhases rejects reversed ranges", () => {
  const known = ["01-a", "02-b", "03-c"];
  assert.throws(
    () => expandSelectedPhases(["03..01"], known),
    InvalidPhaseRangeError,
  );
});

test("expandSelectedPhases rejects ranges with missing endpoint", () => {
  const known = ["01-a", "02-b"];
  assert.throws(
    () => expandSelectedPhases(["02-b.."], known),
    InvalidPhaseRangeError,
  );
  assert.throws(
    () => expandSelectedPhases(["..02-b"], known),
    InvalidPhaseRangeError,
  );
});

test("expandSelectedPhases rejects ranges with unknown endpoints", () => {
  const known = ["01-a", "02-b"];
  assert.throws(
    () => expandSelectedPhases(["99..02"], known),
    InvalidPhaseRangeError,
  );
});

test("expandSelectedPhases rejects empty selection", () => {
  assert.throws(() => expandSelectedPhases([]), InvalidPhaseRangeError);
});

test("expandSelectedPhases rejects non-string entries", () => {
  assert.throws(
    () => expandSelectedPhases([42]),
    InvalidPhaseRangeError,
  );
  assert.throws(
    () => expandSelectedPhases(["   "]),
    InvalidPhaseRangeError,
  );
});
