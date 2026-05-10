// src/frozen-gate/types.ts
//
// Public type surface for the frozen-gate module. These types are the
// stable contract between the gate orchestrator (gate.ts), the extractor
// registry (extractors/index.ts), and downstream consumers (codex-peers
// dispatcher in Phase 33+, DevOS daemon in Phase 34+).
//
// `first_mismatch` mirrors the legacy flat fields from Phase 31's
// 02-GATE-FAILURE.json (dependency_id, extractor, expected_*, actual_*)
// for backward-compatible consumers. `all_mismatches[]` is the additive
// aggregate — Phase 32 evaluates ALL contracts in a phase (no fail-fast).

export type ExtractorName =
  | 'file_sha256_v1'
  | 'ts_export_surface_v1'
  | 'json_schema_v1';

export interface FrozenContractEntry {
  dependency_id: string;
  artifact_path: string;
  extractor: ExtractorName;
  expected_sha256?: string;
  expected_normalized?: string | null;
}

export interface FrozenContract {
  phase_id: string;
  depends_on?: string;
  contracts: FrozenContractEntry[];
}

export interface GateCheck {
  dependency_id: string;
  extractor: ExtractorName;
  pass: boolean;
  expected_sha256?: string;
  actual_sha256?: string;
  expected_normalized?: string;
  actual_normalized?: string;
  reason?: string;
}

export type GateResult =
  | {
      pass: true;
      phase_id: string;
      checks: GateCheck[];
    }
  | {
      pass: false;
      phase_id: string;
      checks: GateCheck[];
      first_mismatch: GateCheck;
      all_mismatches: GateCheck[];
    };
