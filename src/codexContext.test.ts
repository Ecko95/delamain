import { describe, expect, it } from "vitest";
import { contextFromSession, contextLevel, contextTransitionNote } from "./codexContext.js";

// Real token_count shape (see runner background): payload.info carries
// last_token_usage.input_tokens (current occupancy) and model_context_window.
function tokenCount(inputTokens: number, window = 258400): string {
  return JSON.stringify({
    timestamp: "2026-07-06T20:56:16.837Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: inputTokens, total_tokens: inputTokens + 400 },
        last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 4992, output_tokens: 402, total_tokens: inputTokens + 400 },
        model_context_window: window,
      },
    },
  });
}

describe("contextLevel thresholds", () => {
  it("maps used percent to green/yellow/red/skull", () => {
    expect(contextLevel(10)).toBe("green");
    expect(contextLevel(69)).toBe("green");
    expect(contextLevel(70)).toBe("yellow");
    expect(contextLevel(84)).toBe("yellow");
    expect(contextLevel(85)).toBe("red");
    expect(contextLevel(94)).toBe("red");
    expect(contextLevel(95)).toBe("skull");
    expect(contextLevel(100)).toBe("skull");
  });
});

describe("contextFromSession", () => {
  it("reads input_tokens and the reported window into a percent", () => {
    const jsonl = [tokenCount(19698), tokenCount(129200)].join("\n");
    const ctx = contextFromSession(jsonl);
    expect(ctx?.inputTokens).toBe(129200);
    expect(ctx?.contextWindow).toBe(258400);
    expect(ctx?.usedPercent).toBe(50); // 129200 / 258400
    expect(ctx?.level).toBe("green");
    expect(ctx?.compacted).toBe(false);
  });

  it("falls back to the env/default window when model_context_window is absent", () => {
    const line = JSON.stringify({
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 136000 } } },
    });
    const ctx = contextFromSession(line);
    // default fallback window is 272000 → 50%
    expect(ctx?.contextWindow).toBe(272000);
    expect(ctx?.usedPercent).toBe(50);
  });

  it("ignores partial/non-token lines and returns undefined when none present", () => {
    expect(contextFromSession("")).toBeUndefined();
    expect(contextFromSession('{"type":"session_meta"}\n{"garbage')).toBeUndefined();
  });

  it("flags a sharp input_tokens drop as compaction", () => {
    // 200000 → 40000 is a drop well below 60% of a substantial prior reading.
    const jsonl = [tokenCount(50000), tokenCount(200000), tokenCount(40000)].join("\n");
    const ctx = contextFromSession(jsonl);
    expect(ctx?.compacted).toBe(true);
    expect(ctx?.inputTokens).toBe(40000);
  });

  it("does not flag small dips or drops from a tiny prior reading", () => {
    expect(contextFromSession([tokenCount(200000), tokenCount(180000)].join("\n"))?.compacted).toBe(false);
    // prior below the 20k floor: a proportional drop is noise, not compaction.
    expect(contextFromSession([tokenCount(15000), tokenCount(2000)].join("\n"))?.compacted).toBe(false);
  });
});

describe("contextTransitionNote", () => {
  const ctx = (usedPercent: number, compacted = false) => ({
    inputTokens: 0,
    contextWindow: 100,
    usedPercent,
    level: contextLevel(usedPercent),
    compacted,
  });

  it("notes on escalation to a worse level only", () => {
    expect(contextTransitionNote(ctx(72), undefined, false)).toMatch(/approaching limit/);
    expect(contextTransitionNote(ctx(88), "yellow", false)).toMatch(/near limit/);
    // no escalation → no note (avoids 5s spam)
    expect(contextTransitionNote(ctx(88), "red", false)).toBeUndefined();
    expect(contextTransitionNote(ctx(50), undefined, false)).toBeUndefined();
  });

  it("notes compaction once", () => {
    expect(contextTransitionNote(ctx(60, true), "green", false)).toMatch(/auto-compacted/);
    expect(contextTransitionNote(ctx(60, true), "green", true)).toBeUndefined();
  });
});
