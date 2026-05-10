// src/frozen-gate/gate.ts
//
// Skeleton — body lands in 32-04. This file exists in 32-01 to (a) make
// the module's public surface importable from index.ts, (b) freeze the
// gateFrozenPhase signature ahead of extractor implementation. Throwing
// `not implemented` is intentional; 32-04 replaces the body.

import type { GateResult } from './types.js';

export async function gateFrozenPhase(
  repo: string,
  phaseId: string,
): Promise<GateResult> {
  void repo;
  void phaseId;
  throw new Error('gateFrozenPhase not implemented (lands in plan 32-04)');
}
