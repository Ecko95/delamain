// src/gsdGateFailure.ts
//
// Serializer for the gate-failure artifact emitted by the GSD peer runner
// when frozen-mode gateFrozenPhase returns pass:false. The artifact is
// written to <repo>/.planning/dispatch/<phaseId>-GATE-FAILURE.json and
// matches the schema established by Phase 31's demo runner (legacy flat
// fields mirroring first_mismatch) and extended by Phase 32 with the
// all_mismatches[] aggregate.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateResult, GateCheck } from "./frozen-gate/index.js";

export type GateFailureArtifact = {
  phase_id: string;
  gate_status: "FAILURE";
  dispatched_by: "codex-peers-gsd-runner";
  planning_mode: "frozen";
  checked_at_iso8601: string;
  // Legacy flat fields (copy of first_mismatch) — match the Phase 31
  // demo runner's emitted shape so existing consumers parse unchanged.
  dependency_id: string;
  extractor: string;
  expected_sha256?: string;
  actual_sha256?: string;
  expected_normalized?: string;
  actual_normalized?: string;
  reason?: string;
  // Phase 32 aggregate.
  all_mismatches: GateCheck[];
};

export function buildGateFailureArtifact(
  result: GateResult,
  phaseId: string,
): GateFailureArtifact {
  if (result.pass) {
    throw new Error(
      "buildGateFailureArtifact called with pass:true GateResult — only failure results are serializable",
    );
  }
  const first = result.first_mismatch;
  return {
    phase_id: phaseId,
    gate_status: "FAILURE",
    dispatched_by: "codex-peers-gsd-runner",
    planning_mode: "frozen",
    checked_at_iso8601: new Date().toISOString(),
    dependency_id: first.dependency_id,
    extractor: first.extractor,
    expected_sha256: first.expected_sha256,
    actual_sha256: first.actual_sha256,
    expected_normalized: first.expected_normalized,
    actual_normalized: first.actual_normalized,
    reason: first.reason,
    all_mismatches: result.all_mismatches,
  };
}

export async function writeGateFailureArtifact(
  repo: string,
  phaseId: string,
  artifact: GateFailureArtifact,
): Promise<string> {
  const dispatchDir = join(repo, ".planning", "dispatch");
  await mkdir(dispatchDir, { recursive: true });
  const absPath = join(dispatchDir, `${phaseId}-GATE-FAILURE.json`);
  await writeFile(absPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return absPath;
}
