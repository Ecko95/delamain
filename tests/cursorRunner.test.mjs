import test from "node:test";
import assert from "node:assert/strict";
import { resolveCursorModel, buildCursorArgs, DEFAULT_CURSOR_MODEL } from "../dist/cursorRunner.js";

test("resolveCursorModel returns default for empty/undefined", () => {
	assert.equal(resolveCursorModel(undefined), DEFAULT_CURSOR_MODEL);
	assert.equal(resolveCursorModel(""), DEFAULT_CURSOR_MODEL);
	assert.equal(resolveCursorModel("   "), DEFAULT_CURSOR_MODEL);
});

test("resolveCursorModel maps short aliases to full model ids", () => {
	assert.equal(resolveCursorModel("sonnet"), "claude-4.6-sonnet-medium");
	assert.equal(resolveCursorModel("opus"), "claude-opus-4-7-high");
	assert.equal(resolveCursorModel("gpt"), "gpt-5.3-codex");
	assert.equal(resolveCursorModel("fast"), "composer-2-fast");
	assert.equal(resolveCursorModel("Composer-2"), "composer-2");
});

test("resolveCursorModel passes unknown ids through verbatim", () => {
	assert.equal(resolveCursorModel("composer-3-experimental"), "composer-3-experimental");
});

test("buildCursorArgs assembles base args with model + force by default", () => {
	const args = buildCursorArgs(
		{ peerId: "p1", repo: "/r", promptFile: "/p", logPath: "/l" },
		"do the thing",
	);
	assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "stream-json"]);
	assert.ok(args.includes("--model"));
	assert.ok(args.includes(DEFAULT_CURSOR_MODEL));
	assert.ok(args.includes("--force"));
	assert.equal(args[args.length - 1], "do the thing");
});

test("buildCursorArgs adds --cloud and --approve-mcps when set", () => {
	const args = buildCursorArgs(
		{ peerId: "p1", repo: "/r", promptFile: "/p", logPath: "/l", cloud: true, approveMcps: true },
		"task",
	);
	assert.ok(args.includes("--cloud"));
	assert.ok(args.includes("--approve-mcps"));
});

test("buildCursorArgs omits --force when force=false", () => {
	const args = buildCursorArgs(
		{ peerId: "p1", repo: "/r", promptFile: "/p", logPath: "/l", force: false },
		"task",
	);
	assert.ok(!args.includes("--force"));
});

test("buildCursorArgs adds --resume=<id> when resumeThread present", () => {
	const args = buildCursorArgs(
		{ peerId: "p1", repo: "/r", promptFile: "/p", logPath: "/l", resumeThread: "chat_xyz" },
		"task",
	);
	assert.ok(args.includes("--resume=chat_xyz"));
});
