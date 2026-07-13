import { describe, expect, it } from "vitest";
import { priceFor } from "./pricing.js";

describe("priceFor", () => {
  it("prices the gpt-5.3-codex family at its API rates", () => {
    expect(priceFor("gpt-5.3-codex-spark")).toEqual({ inputPerM: 1.75, cachedPerM: 0.175, outputPerM: 14 });
    expect(priceFor("gpt-5.3-codex")).toEqual(priceFor("gpt-5.3-codex-spark"));
    expect(priceFor("gpt-5.3-codex-fast")).toEqual(priceFor("gpt-5.3-codex-spark"));
    expect(priceFor("gpt-5.3-codex-high")).toEqual(priceFor("gpt-5.3-codex-spark"));
  });

  it("prices gpt-5.6-terra at official Terra tier rates", () => {
    expect(priceFor("gpt-5.6-terra")).toEqual({ inputPerM: 2.5, cachedPerM: 0.25, outputPerM: 15 });
  });

  it("resolves an existing exact match", () => {
    expect(priceFor("gpt-5.4-mini")).toEqual({ inputPerM: 0.25, cachedPerM: 0.025, outputPerM: 2 });
  });

  it("prefix-matches longest key first", () => {
    expect(priceFor("gpt-5.4-mini-high")).toEqual(priceFor("gpt-5.4-mini"));
    expect(priceFor("gpt-5.5-codex")).toEqual(priceFor("gpt-5.5"));
  });

  it("falls back to default pricing for unknown models", () => {
    expect(priceFor("mystery-model")).toEqual({ inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 });
  });
});
