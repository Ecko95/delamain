export type ModelPricing = {
  inputPerM: number;   // USD per 1M uncached input tokens
  cachedPerM: number;  // USD per 1M cached input tokens
  outputPerM: number;  // USD per 1M output tokens
};

export const PRICING_VERSION = "2026-07-13";
export const PRICING_NOTE =
  "Notional GPT-5-class API-equivalent rates for subscription-billed codex peers. Update deliberately; dollars here are comparative, not invoiced.";

const TABLE: Record<string, ModelPricing> = {
  "gpt-5.5": { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 },
  "gpt-5.4": { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 },
  "gpt-5.4-mini": { inputPerM: 0.25, cachedPerM: 0.025, outputPerM: 2 },
  // Covers -spark/-fast/-high variants via prefix match; spark runs at base gpt-5.3-codex API rates.
  "gpt-5.3-codex": { inputPerM: 1.75, cachedPerM: 0.175, outputPerM: 14 },
  "gpt-5.6-terra": { inputPerM: 2.5, cachedPerM: 0.25, outputPerM: 15 },
};

// Longest-first so "gpt-5.4-mini-high" prefix-matches "gpt-5.4-mini", not "gpt-5.4".
const PREFIX_KEYS = Object.keys(TABLE).sort((a, b) => b.length - a.length);

const DEFAULT: ModelPricing = { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 };

export function priceFor(model: string | undefined): ModelPricing {
  if (model && TABLE[model]) return TABLE[model];
  // Prefix match: "gpt-5.5-codex" -> "gpt-5.5".
  for (const key of PREFIX_KEYS) {
    if (model?.startsWith(key)) return TABLE[key];
  }
  return DEFAULT;
}
