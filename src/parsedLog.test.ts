import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildParsedLog } from "./parsedLog.js";

describe("buildParsedLog (contract 1)", () => {
  it("classifies a mixed codex tail: NDJSON, runner, stderr, garbage", () => {
    const raw = [
      '{"type":"session.created","session_id":"s1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello from agent"}}',
      "[delamain] starting workflow",
      "[stderr] boom went the process",
      "this is not json {{{",
      "", // blank trailing line — must be dropped
    ].join("\n");

    const out = buildParsedLog("peer-1", "codex", raw);
    expect(out.peerId).toBe("peer-1");
    expect(out.engine).toBe("codex");
    expect(out.events).toHaveLength(5);

    // engine NDJSON -> codex parser output, normalized (nulls not undefined).
    const [session, agent] = out.events;
    expect(session.type).toBe("session.created");
    expect(session.isAgentMessage).toBe(false);
    expect(session.waitingQuestion).toBeNull();

    expect(agent.type).toBe("item.completed");
    expect(agent.isAgentMessage).toBe(true);
    expect(agent.text).toContain("Hello from agent");

    // runner + stderr plain lines keep the full line as text.
    expect(out.events[2]).toEqual({
      type: "runner",
      text: "[delamain] starting workflow",
      label: null,
      isAgentMessage: false,
      waitingQuestion: null,
    });
    expect(out.events[3]).toEqual({
      type: "stderr",
      text: "[stderr] boom went the process",
      label: null,
      isAgentMessage: false,
      waitingQuestion: null,
    });

    // unparseable, non-prefixed -> raw carries the original line, text null.
    expect(out.events[4]).toEqual({
      type: "raw",
      raw: "this is not json {{{",
      text: null,
      label: null,
      isAgentMessage: false,
      waitingQuestion: null,
    });
  });

  it("tolerates a pi golden fixture (session id only on line 1)", () => {
    const raw = readFileSync(join(__dirname, "../tests/fixtures/pi/0.73.1-text.ndjson"), "utf8");
    const out = buildParsedLog("pi-peer", "pi", raw);
    expect(out.engine).toBe("pi");
    expect(out.events.length).toBeGreaterThan(0);
    // Every event conforms to the ParsedLogEvent shape (no undefined leaks).
    for (const e of out.events) {
      expect(typeof e.type).toBe("string");
      expect(e).toHaveProperty("isAgentMessage");
      expect(typeof e.isAgentMessage).toBe("boolean");
    }
    // The assistant's final answer surfaces as an agent message.
    expect(out.events.some((e) => e.isAgentMessage)).toBe(true);
  });
});
