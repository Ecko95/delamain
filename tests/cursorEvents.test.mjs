import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCursorJsonLine, walkToolUses, looksLikeFileWrite } from "../dist/cursorEvents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "cursor-events");

function parseFixture(name) {
	const raw = readFileSync(join(FIXTURES, `${name}.ndjson`), "utf8");
	return raw
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map(parseCursorJsonLine);
}

test("parseCursorJsonLine extracts session_id from system init", () => {
	const events = parseFixture("happy-path");
	const threadIds = events.map((ev) => ev.threadId).filter(Boolean);
	assert.ok(threadIds.includes("chat_abc123"), "expected session_id chat_abc123 to surface");
});

test("parseCursorJsonLine flags assistant messages and result success as agent-like", () => {
	const events = parseFixture("happy-path");
	const agent = events.filter((ev) => ev.isAgentMessage);
	assert.ok(agent.length >= 2, "expected at least one assistant + one result event");
});

test("parseCursorJsonLine extracts text from assistant.message.text", () => {
	const events = parseFixture("happy-path");
	const assistantText = events.find(
		(ev) => ev.type === "assistant" && typeof ev.text === "string",
	);
	assert.ok(assistantText, "expected an assistant event with text");
	assert.match(assistantText.text, /Starting work/);
});

test("parseCursorJsonLine extracts result text from final result event", () => {
	const events = parseFixture("happy-path");
	const result = events.find((ev) => ev.type === "result");
	assert.ok(result);
	assert.match(result.text, /Added src\/foo\.ts/);
});

test("failure fixture surfaces error result with text", () => {
	const events = parseFixture("failure");
	const result = events.find((ev) => ev.type === "result");
	assert.ok(result);
	assert.match(result.text, /Aborted due to error/);
});

test("walkToolUses finds nested tool_use objects with names", () => {
	const events = parseFixture("happy-path");
	const writes = [];
	for (const ev of events) {
		// parsed events lose the original `type`/`input` shape; walk the raw line
		// indirectly by re-parsing the fixture for tool detection.
	}
	// Walk tool_use objects directly off raw NDJSON to validate the helper.
	const raw = readFileSync(join(FIXTURES, "happy-path.ndjson"), "utf8");
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		const obj = JSON.parse(line);
		for (const tu of walkToolUses(obj)) {
			if (looksLikeFileWrite(tu.name)) writes.push(tu);
		}
	}
	assert.equal(writes.length, 2, "expected 2 file-write tool uses (write + edit)");
	assert.equal(writes[0].name, "write");
	assert.equal(writes[1].name, "edit");
});

test("parseCursorJsonLine returns waitingQuestion for CODEX_PEERS_STATUS:WAITING in agent message", () => {
	const line = JSON.stringify({
		type: "assistant",
		message: { text: "CODEX_PEERS_STATUS: WAITING\nQUESTION: Should I rename the helper?" },
	});
	const ev = parseCursorJsonLine(line);
	assert.equal(ev.isAgentMessage, true);
	assert.match(ev.waitingQuestion, /Should I rename the helper/);
});

test("parseCursorJsonLine handles malformed JSON without throwing", () => {
	const ev = parseCursorJsonLine("{ not json");
	assert.equal(ev.isAgentMessage, true);
	assert.match(ev.text, /not json/);
});

test("parseCursorJsonLine returns empty event for blank lines", () => {
	const ev = parseCursorJsonLine("");
	assert.equal(ev.isAgentMessage, undefined);
	assert.equal(ev.text, undefined);
});

test("looksLikeFileWrite recognises write/edit/patch hints", () => {
	assert.equal(looksLikeFileWrite("write"), true);
	assert.equal(looksLikeFileWrite("str_replace"), true);
	assert.equal(looksLikeFileWrite("apply_patch"), true);
	assert.equal(looksLikeFileWrite("read"), false);
	assert.equal(looksLikeFileWrite(undefined), false);
});
