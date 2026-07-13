import { describe, expect, it } from "vitest";
import { costUsd, parseSessionTotals } from "./peerCost.js";

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
