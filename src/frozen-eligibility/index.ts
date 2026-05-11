// src/frozen-eligibility/index.ts
//
// Public entry point. Consumers import from this file only.

export { classifyFrozenBatch } from './eligibility.js';
export type {
  FrozenEligibility,
  FrozenEligibilityCheckOptions,
} from './types.js';
export { RISKY_KEYWORDS } from './types.js';
