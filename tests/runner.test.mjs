// tests/runner.test.mjs
//
// Unit coverage for the three additive codex peer tuning knobs
// (reasoning_effort, developer_instructions, codex_config) added to
// src/runner.ts's buildCodexArgs/parseArgs, plus the CLI serialization
// round trip through src/peerManager.ts's buildRunnerArgv.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, parseArgs, reasoningEffortArgs } from "../dist/runner.js";
import { buildRunnerArgv } from "../dist/peerManager.js";

// --- reasoningEffortArgs (shared by runner.ts and gsdRunner.ts) ---

test("reasoningEffortArgs: absent effort preserves legacy default (high unless gpt-5.5)", () => {
  assert.deepEqual(reasoningEffortArgs("gpt-5", undefined), ["-c", 'model_reasoning_effort="high"']);
  assert.deepEqual(reasoningEffortArgs("gpt-5.5", undefined), []);
  assert.deepEqual(reasoningEffortArgs(undefined, undefined), []);
});

test("reasoningEffortArgs: explicit effort wins for ANY model, including gpt-5.5", () => {
  assert.deepEqual(reasoningEffortArgs("gpt-5.5", "xhigh"), ["-c", 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(reasoningEffortArgs("gpt-5", "minimal"), ["-c", 'model_reasoning_effort="minimal"']);
  assert.deepEqual(reasoningEffortArgs(undefined, "low"), ["-c", 'model_reasoning_effort="low"']);
});

// --- buildCodexArgs ---

test("buildCodexArgs: legacy byte-for-byte behavior when reasoningEffort absent (non-gpt-5.5)", () => {
  const args = buildCodexArgs({ peerId: "p", repo: "/r", promptFile: "/f", logPath: "/l", model: "gpt-5" });
  const cIdx = args.indexOf("-c");
  assert.equal(args[cIdx + 1], "features.codex_hooks=false");
  assert.equal(args[cIdx + 2], "-c");
  assert.equal(args[cIdx + 3], 'model_reasoning_effort="high"');
});

test("buildCodexArgs: legacy byte-for-byte behavior when reasoningEffort absent (gpt-5.5 gets no effort override)", () => {
  const args = buildCodexArgs({ peerId: "p", repo: "/r", promptFile: "/f", logPath: "/l", model: "gpt-5.5" });
  assert.ok(args.includes("features.codex_hooks=false"));
  assert.ok(!args.some((a) => typeof a === "string" && a.startsWith("model_reasoning_effort")));
});

test("buildCodexArgs: explicit reasoningEffort emits -c for gpt-5.5 too", () => {
  const args = buildCodexArgs({
    peerId: "p",
    repo: "/r",
    promptFile: "/f",
    logPath: "/l",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  });
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
});

test("buildCodexArgs: developer_instructions with embedded newlines and double quotes is valid-TOML-escaped", () => {
  const raw = 'Line one.\nLine "two" has quotes.\nLine three.';
  const args = buildCodexArgs({ peerId: "p", repo: "/r", promptFile: "/f", logPath: "/l", developerInstructions: raw });
  const idx = args.findIndex((a) => typeof a === "string" && a.startsWith("developer_instructions="));
  assert.ok(idx !== -1, "expected a developer_instructions=... -c value");
  const tomlValue = args[idx].slice("developer_instructions=".length);
  // JSON.stringify's escaping is a valid TOML basic string body: newlines
  // become \n, quotes become \", and the whole thing round-trips via JSON.parse.
  assert.equal(tomlValue, JSON.stringify(raw));
  assert.equal(JSON.parse(tomlValue), raw);
});

test("buildCodexArgs: codex_config entries are appended after delamain's own -c flags, in order", () => {
  const args = buildCodexArgs({
    peerId: "p",
    repo: "/r",
    promptFile: "/f",
    logPath: "/l",
    model: "gpt-5",
    codexConfig: ['sandbox_permissions=["disk-full-read-access"]', "shell_environment_policy.inherit=all"],
  });
  const hooksIdx = args.indexOf("features.codex_hooks=false");
  const effortIdx = args.indexOf('model_reasoning_effort="high"');
  const firstCustomIdx = args.indexOf('sandbox_permissions=["disk-full-read-access"]');
  const secondCustomIdx = args.indexOf("shell_environment_policy.inherit=all");
  assert.ok(hooksIdx < effortIdx);
  assert.ok(effortIdx < firstCustomIdx);
  assert.ok(firstCustomIdx < secondCustomIdx);
  // Every custom entry is paired with its own "-c" flag.
  assert.equal(args[firstCustomIdx - 1], "-c");
  assert.equal(args[secondCustomIdx - 1], "-c");
});

test("buildCodexArgs: -c flags apply on the resume path too (codex exec resume accepts -c)", () => {
  const args = buildCodexArgs({
    peerId: "p",
    repo: "/r",
    promptFile: "/f",
    logPath: "/l",
    resumeThread: "thread-123",
    reasoningEffort: "medium",
    developerInstructions: "resume note",
  });
  assert.deepEqual(args.slice(0, 4), ["exec", "resume", "--json", "thread-123"]);
  assert.ok(args.includes('model_reasoning_effort="medium"'));
  assert.ok(args.includes(`developer_instructions=${JSON.stringify("resume note")}`));
});

// --- parseArgs (run-peer CLI flag parsing) ---

test("parseArgs: parses --reasoning-effort, --developer-instructions, repeated --codex-config", () => {
  const argv = [
    "--peer-id", "p1",
    "--repo", "/r",
    "--prompt-file", "/f",
    "--log-path", "/l",
    "--reasoning-effort", "xhigh",
    "--developer-instructions", "multi\nline\ntext",
    "--codex-config", "foo.bar=1",
    "--codex-config", "baz=2",
  ];
  const parsed = parseArgs(argv);
  assert.equal(parsed.reasoningEffort, "xhigh");
  assert.equal(parsed.developerInstructions, "multi\nline\ntext");
  assert.deepEqual(parsed.codexConfig, ["foo.bar=1", "baz=2"]);
});

test("parseArgs: developer-instructions value starting with '--' is still consumed as the value", () => {
  const argv = [
    "--peer-id", "p1",
    "--repo", "/r",
    "--prompt-file", "/f",
    "--log-path", "/l",
    "--developer-instructions", "--bullet one\n--bullet two",
  ];
  const parsed = parseArgs(argv);
  assert.equal(parsed.developerInstructions, "--bullet one\n--bullet two");
});

test("parseArgs: absent knobs leave fields undefined (no behavior change)", () => {
  const argv = ["--peer-id", "p1", "--repo", "/r", "--prompt-file", "/f", "--log-path", "/l"];
  const parsed = parseArgs(argv);
  assert.equal(parsed.reasoningEffort, undefined);
  assert.equal(parsed.developerInstructions, undefined);
  assert.equal(parsed.codexConfig, undefined);
});

// --- CLI serialization round trip: options -> spawnRunner argv -> parseArgs ---

test("round trip: buildRunnerArgv -> parseArgs recovers all three tuning knobs", () => {
  const argv = buildRunnerArgv({
    peerId: "p1",
    repo: "/repo",
    promptFile: "/prompt.txt",
    logPath: "/log.txt",
    reasoningEffort: "low",
    developerInstructions: 'has "quotes" and\nnewlines',
    codexConfig: ["a.b=1", "c=2"],
  });
  // argv = [entry, "run-peer", ...flags]; runPeer(args) receives just the flags.
  assert.equal(argv[1], "run-peer");
  const parsed = parseArgs(argv.slice(2));
  assert.equal(parsed.peerId, "p1");
  assert.equal(parsed.reasoningEffort, "low");
  assert.equal(parsed.developerInstructions, 'has "quotes" and\nnewlines');
  assert.deepEqual(parsed.codexConfig, ["a.b=1", "c=2"]);
});

test("round trip: knobs absent from options are absent from argv and parsed output", () => {
  const argv = buildRunnerArgv({ peerId: "p1", repo: "/repo", promptFile: "/prompt.txt", logPath: "/log.txt" });
  assert.ok(!argv.includes("--reasoning-effort"));
  assert.ok(!argv.includes("--developer-instructions"));
  assert.ok(!argv.includes("--codex-config"));
  const parsed = parseArgs(argv.slice(2));
  assert.equal(parsed.reasoningEffort, undefined);
  assert.equal(parsed.developerInstructions, undefined);
  assert.equal(parsed.codexConfig, undefined);
});
