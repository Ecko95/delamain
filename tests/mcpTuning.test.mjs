// tests/mcpTuning.test.mjs
//
// MCP-boundary validation for the three codex peer tuning knobs:
// reasoning_effort, developer_instructions, codex_config. These are
// validated in src/mcpServer.ts (fail loud, clear typed error messages)
// before ever reaching spawnPeer/spawnRunner.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reasoningEffortValue,
  developerInstructionsValue,
  codexConfigValue,
  codexTuningOptions,
  DEVELOPER_INSTRUCTIONS_MAX,
  CODEX_CONFIG_MAX_ENTRIES,
} from "../dist/mcpServer.js";

// --- reasoning_effort ---

test("reasoningEffortValue: absent is undefined", () => {
  assert.equal(reasoningEffortValue({}), undefined);
});

test("reasoningEffortValue: accepts all five enum values, both snake_case and camelCase keys", () => {
  for (const v of ["minimal", "low", "medium", "high", "xhigh"]) {
    assert.equal(reasoningEffortValue({ reasoning_effort: v }), v);
    assert.equal(reasoningEffortValue({ reasoningEffort: v }), v);
  }
});

test("reasoningEffortValue: rejects an invalid value with a clear message", () => {
  assert.throws(() => reasoningEffortValue({ reasoning_effort: "ultra" }), /Invalid reasoning_effort/);
});

// --- developer_instructions ---

test("developerInstructionsValue: passes through a string with embedded newlines and quotes", () => {
  const raw = 'Line one.\nLine "two".';
  assert.equal(developerInstructionsValue({ developer_instructions: raw }), raw);
});

test("developerInstructionsValue: absent is undefined", () => {
  assert.equal(developerInstructionsValue({}), undefined);
});

test("developerInstructionsValue: rejects non-string", () => {
  assert.throws(() => developerInstructionsValue({ developer_instructions: 42 }), /must be a string/);
});

test("developerInstructionsValue: rejects over the 32768-char cap", () => {
  const tooLong = "x".repeat(DEVELOPER_INSTRUCTIONS_MAX + 1);
  assert.throws(() => developerInstructionsValue({ developer_instructions: tooLong }), /exceeds 32768 chars/);
});

test("developerInstructionsValue: accepts exactly the cap", () => {
  const atCap = "x".repeat(DEVELOPER_INSTRUCTIONS_MAX);
  assert.equal(developerInstructionsValue({ developer_instructions: atCap }), atCap);
});

// --- codex_config ---

test("codexConfigValue: absent is undefined", () => {
  assert.equal(codexConfigValue({}), undefined);
});

test("codexConfigValue: valid entries pass through in order", () => {
  const entries = ["model_reasoning_effort=high", "sandbox_permissions.disk=full"];
  assert.deepEqual(codexConfigValue({ codex_config: entries }), entries);
});

test("codexConfigValue: rejects a malformed entry (no '=value')", () => {
  assert.throws(() => codexConfigValue({ codex_config: ["not-a-kv-pair"] }), /codex_config entry invalid/);
});

test("codexConfigValue: rejects a key with disallowed characters", () => {
  assert.throws(() => codexConfigValue({ codex_config: ["bad key!=value"] }), /codex_config entry invalid/);
});

test("codexConfigValue: rejects more than 16 entries", () => {
  const entries = Array.from({ length: CODEX_CONFIG_MAX_ENTRIES + 1 }, (_, i) => `k${i}=v`);
  assert.throws(() => codexConfigValue({ codex_config: entries }), /max 16/);
});

test("codexConfigValue: rejects a non-array", () => {
  assert.throws(() => codexConfigValue({ codex_config: "k=v" }), /must be an array/);
});

test("codexConfigValue: rejects an entry over 2000 chars", () => {
  const entry = `k=${"v".repeat(2001)}`;
  assert.throws(() => codexConfigValue({ codex_config: [entry] }), /codex_config entry invalid/);
});

// --- engine guard (codex-only knobs must not be combined with engine=cursor) ---

test("codexTuningOptions: engine='cursor' + any tuning knob is rejected clearly", () => {
  assert.throws(
    () => codexTuningOptions({ reasoning_effort: "high" }, "cursor"),
    /codex-engine-only/,
  );
  assert.throws(
    () => codexTuningOptions({ developer_instructions: "x" }, "cursor"),
    /codex-engine-only/,
  );
  assert.throws(
    () => codexTuningOptions({ codex_config: ["a=b"] }, "cursor"),
    /codex-engine-only/,
  );
});

test("codexTuningOptions: engine='cursor' with no tuning knobs passed is fine", () => {
  assert.deepEqual(codexTuningOptions({}, "cursor"), {
    reasoningEffort: undefined,
    developerInstructions: undefined,
    codexConfig: undefined,
  });
});

test("codexTuningOptions: engine='codex' (or undefined) passes all three through", () => {
  const out = codexTuningOptions(
    { reasoning_effort: "low", developer_instructions: "d", codex_config: ["a=b"] },
    "codex",
  );
  assert.equal(out.reasoningEffort, "low");
  assert.equal(out.developerInstructions, "d");
  assert.deepEqual(out.codexConfig, ["a=b"]);

  const outDefault = codexTuningOptions({ reasoning_effort: "medium" }, undefined);
  assert.equal(outDefault.reasoningEffort, "medium");
});
