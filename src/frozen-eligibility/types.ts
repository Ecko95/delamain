// src/frozen-eligibility/types.ts
//
// Phase 37 plan 01: public type surface for the eligibility filter.
// `FrozenEligibility` is the exact discriminated union shape from
// IMPLEMENTATION-PLAN.md line 216 (the Codex review §2.2 interface).

export type FrozenEligibility =
  | { eligible: true }
  | { eligible: false; reasons: string[] };

// Internal: tunable knobs passed by tests / the MCP handler. Defaults
// match the Phase 37 brief.
export interface FrozenEligibilityCheckOptions {
  /** Risky-keyword list. Defaults to RISKY_KEYWORDS (frozen, per Phase 37 brief). */
  riskyKeywords?: readonly string[];
  /** Word-boundary anchoring for the all-caps short tokens. Defaults to true. */
  wordBoundary?: boolean;
}

export const RISKY_KEYWORDS = [
  'TODO',
  'FIXME',
  'WIP',
  'scratch',
  'discussion needed',
  'needs human review',
] as const;
