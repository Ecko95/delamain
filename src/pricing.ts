export type ModelPricing = {
  inputPerM: number;   // USD per 1M uncached input tokens
  cachedPerM: number;  // USD per 1M cached input tokens
  outputPerM: number;  // USD per 1M output tokens
};

export const PRICING_VERSION = "2026-07-12";
export const PRICING_NOTE =
  "Notional GPT-5-class API-equivalent rates for subscription-billed codex peers. Update deliberately; dollars here are comparative, not invoiced.";

const TABLE: Record<string, ModelPricing> = {
  "gpt-5.5": { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 },
  "gpt-5.4": { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 },
  "gpt-5.4-mini": { inputPerM: 0.25, cachedPerM: 0.025, outputPerM: 2 },
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
