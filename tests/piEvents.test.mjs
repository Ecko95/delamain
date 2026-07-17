// tests/piEvents.test.mjs
//
// SP2 — parsePiJsonLine over REAL pi 0.73.1 `--print --mode json` output
// (golden fixtures captured live, tests/fixtures/pi/0.73.1-*.ndjson).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { parsePiJsonLine, looksLikeFileWrite } = await import("../dist/piEvents.js");

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(HERE, "fixtures", "pi", name), "utf8").split(/\r?\n/).filter((l) => l.trim());

// Mimic piRunner's accumulation: collectedText grows from parsed.text only.
function drive(lines) {
  let threadId;
  let collected = "";
  let waiting;
  const labels = [];
  for (const line of lines) {
    const p = parsePiJsonLine(line);
    if (p.threadId) threadId = p.threadId;
    if (p.text) collected = `${collected}${collected ? "\n" : ""}${p.text}`;
    if (p.waitingQuestion) waiting = p.waitingQuestion;
    if (p.label) labels.push(p.label);
  }
  return { threadId, collected: collected.trim(), waiting, labels };
}

test("session line yields threadId (bare `id`, only source)", () => {
  const p = parsePiJsonLine('{"type":"session","version":3,"id":"019f711f-7708-7159-8ab3-5e182472c16a","timestamp":"t","cwd":"/x"}');
  assert.equal(p.threadId, "019f711f-7708-7159-8ab3-5e182472c16a");
  assert.equal(p.text, undefined);
});

test("text_delta contributes a progress label but NO text (no double-count)", () => {
  const p = parsePiJsonLine('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"hello"}}');
  assert.equal(p.text, undefined, "text_delta must not emit text");
  assert.equal(p.label, "hello");
});

test("thinking_delta never leaks into text", () => {
  const p = parsePiJsonLine('{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"pondering"}}');
  assert.equal(p.text, undefined);
});

test("message_end (assistant) yields the final text; user echo is ignored", () => {
  const asst = parsePiJsonLine('{"type":"message_end","message":{"role":"assistant","stopReason":"stop","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"hello"}]}}');
  assert.equal(asst.text, "hello");
  assert.equal(asst.isAgentMessage, true);
  const user = parsePiJsonLine('{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word: hello"}]}}');
  assert.equal(user.text, undefined, "user message_end must not be treated as agent output");
});

test("golden text stream: accumulated result is 'hello' exactly (no delta/message_end duplication)", () => {
  const r = drive(fixture("0.73.1-text.ndjson"));
  assert.equal(r.threadId, "019f711f-7708-7159-8ab3-5e182472c16a");
  assert.equal(r.collected, "hello", `expected 'hello', got ${JSON.stringify(r.collected)}`);
  assert.equal(r.waiting, undefined);
});

test("golden tool stream: tool labels carry toolName; write detection works", () => {
  const lines = fixture("0.73.1-tools.ndjson");
  const startLabels = lines
    .map(parsePiJsonLine)
    .filter((p) => p.type === "tool_execution_start")
    .map((p) => p.label);
  assert.ok(startLabels.some((l) => l.includes("write")), `expected a write tool label, got ${JSON.stringify(startLabels)}`);
  assert.ok(startLabels.some((l) => l.includes("bash")));
  assert.equal(looksLikeFileWrite("write"), true);
  assert.equal(looksLikeFileWrite("edit"), true);
  assert.equal(looksLikeFileWrite("bash"), false);
  assert.equal(looksLikeFileWrite("read"), false);
});

test("golden resume stream: same session id re-emitted; context answer captured", () => {
  const r = drive(fixture("0.73.1-resume.ndjson"));
  assert.equal(r.threadId, "019f711f-7708-7159-8ab3-5e182472c16a", "resume re-opens the same session id");
  assert.equal(r.collected.toLowerCase().includes("hello"), true);
});

test("WAITING sentinel in the final assistant message drives waitingQuestion", () => {
  const line = JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "CODEX_PEERS_STATUS: WAITING\nQUESTION: which branch?" }] },
  });
  const p = parsePiJsonLine(line);
  assert.equal(p.isAgentMessage, true);
  assert.ok(p.waitingQuestion && /which branch/.test(p.waitingQuestion), `got ${JSON.stringify(p.waitingQuestion)}`);
});

test("unknown/no-text events return a label, never crash", () => {
  for (const t of ["turn_start", "agent_start", "queue_update", "compaction_start", "session_info_changed", "auto_retry_start"]) {
    const p = parsePiJsonLine(JSON.stringify({ type: t }));
    assert.equal(p.type, t);
    assert.equal(p.text, undefined);
  }
  assert.deepEqual(parsePiJsonLine(""), {});
  assert.deepEqual(parsePiJsonLine("not json at all").isAgentMessage, true); // fallback text
});
