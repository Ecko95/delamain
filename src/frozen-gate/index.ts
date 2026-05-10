// src/frozen-gate/index.ts
//
// Public entry point. Consumers import from this file only.

export {
  gateFrozenPhase,
  FrozenContractMalformedError,
  UnknownExtractorError,
} from './gate.js';
export type {
  ExtractorName,
  FrozenContract,
  FrozenContractEntry,
  GateCheck,
  GateResult,
} from './types.js';
