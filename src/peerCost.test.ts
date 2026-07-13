import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costUsd, findRolloutFile, parseSessionTotals } from "./peerCost.js";

const LINES = [
  JSON.stringify({ timestamp: "t1", type: "session_meta", payload: { id: "s" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } } } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 33005, cached_input_tokens: 9984, output_tokens: 223 } } } }),
].join("\n");

describe("parseSessionTotals", () => {
  it("returns the LAST cumulative token_count", () => {
    expect(parseSessionTotals(LINES)).toEqual({ input: 33005, cached: 9984, output: 223 });
  });

  it("returns undefined when no token_count events exist", () => {
    expect(parseSessionTotals('{"type":"session_meta","payload":{}}')).toBeUndefined();
  });

  it("skips malformed lines", () => {
    expect(parseSessionTotals(`not-json\n${LINES}`)).toEqual({ input: 33005, cached: 9984, output: 223 });
  });
});

describe("costUsd", () => {
  it("prices uncached input, cached input, and output separately", () => {
    // gpt-5.5 assumed rates: 1.25/M in, 0.125/M cached, 10/M out
    const usd = costUsd({ input: 1_000_000 + 400_000, cached: 400_000, output: 100_000 }, "gpt-5.5");
    // (1.0M uncached * 1.25) + (0.4M * 0.125) + (0.1M * 10) = 1.25 + 0.05 + 1.0
    expect(usd).toBeCloseTo(2.3, 5);
  });

  it("falls back to default pricing for unknown models", () => {
    expect(costUsd({ input: 1_000_000, cached: 0, output: 0 }, "mystery-model")).toBeGreaterThan(0);
  });
});

describe("findRolloutFile", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delamain-cost-"));
    savedHome = process.env.DELAMAIN_HOME;
    savedCodexHome = process.env.CODEX_HOME;
    process.env.DELAMAIN_HOME = home;
    // Point the codexHome fallback root at an empty dir so the real ~/.codex never leaks in.
    process.env.CODEX_HOME = join(home, "codex-home");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DELAMAIN_HOME;
    else process.env.DELAMAIN_HOME = savedHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("finds the newest rollout file matching the threadId suffix", () => {
    const threadId = "0196a7e2-aaaa-bbbb-cccc-ddddeeeeffff";
    const sessions = join(home, "peer-codex-home", "sessions", "2026", "07", "01");
    mkdirSync(sessions, { recursive: true });
    const older = join(sessions, `rollout-2026-07-01T00-00-00-${threadId}.jsonl`);
    const newer = join(sessions, `rollout-2026-07-02T00-00-00-${threadId}.jsonl`);
    writeFileSync(older, "{}");
    writeFileSync(newer, "{}");
    writeFileSync(join(sessions, "rollout-2026-07-03T00-00-00-11111111-2222-3333-4444-555555555555.jsonl"), "{}");
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past); // resumes produce several files for one thread; newest mtime wins
    expect(findRolloutFile(threadId)).toBe(newer);
  });

  it("returns undefined for an unknown threadId", () => {
    expect(findRolloutFile("no-such-thread")).toBeUndefined();
  });
});
