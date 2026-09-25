import { describe, expect, it } from "vitest";
import { priceFor } from "./pricing.js";

describe("priceFor", () => {
  it("prices the gpt-5.3-codex family at its API rates", () => {
    expect(priceFor("gpt-5.3-codex-spark")).toEqual({ inputPerM: 1.75, cachedPerM: 0.175, outputPerM: 14 });
    expect(priceFor("gpt-5.3-codex")).toEqual(priceFor("gpt-5.3-codex-spark"));
    expect(priceFor("gpt-5.3-codex-fast")).toEqual(priceFor("gpt-5.3-codex-spark"));
    expect(priceFor("gpt-5.3-codex-high")).toEqual(priceFor("gpt-5.3-codex-spark"));
  });

  it("prices the gpt-6 family at official API rates", () => {
    expect(priceFor("gpt-6-astra")).toEqual({ inputPerM: 10, cachedPerM: 1, outputPerM: 50 });
    expect(priceFor("gpt-6-sol")).toEqual({ inputPerM: 2, cachedPerM: 0.2, outputPerM: 10 });
    expect(priceFor("gpt-6-luna")).toEqual({ inputPerM: 0.1, cachedPerM: 0.01, outputPerM: 0.5 });
  });

  it("prices gpt-5.6-terra at official Terra tier rates", () => {
    expect(priceFor("gpt-5.6-terra")).toEqual({ inputPerM: 2, cachedPerM: 0.2, outputPerM: 12 });
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
