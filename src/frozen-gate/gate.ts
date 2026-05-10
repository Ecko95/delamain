// src/frozen-gate/gate.ts
//
// gateFrozenPhase — read <repo>/.planning/phases/<phaseId>/<NN>-FROZEN-CONTRACT.json,
// run every contract entry through its declared extractor, compare actual
// vs expected, aggregate ALL results (no fail-fast), and return a
// GateResult per the type contract frozen in plan 32-01.
//
// Contract:
//   - If FROZEN-CONTRACT.json does not exist: return pass:true with empty
//     checks[] (phases without contracts trivially pass — matches the
//     Phase 31 demo runner's behaviour).
//   - If FROZEN-CONTRACT.json exists but is malformed (bad JSON, missing
//     required fields): throw FrozenContractMalformedError. The caller
//     decides whether this is a hard failure or a recoverable
//     gate-failure-style artifact.
//   - If a contract entry references an unknown extractor: throw
//     UnknownExtractorError.
//   - If an extractor's artifact_path does not exist: surface as a
//     check failure with reason: "artifact missing" rather than throwing.
//
// Idempotent and side-effect-free.

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ExtractorName,
  FrozenContract,
  FrozenContractEntry,
  GateCheck,
  GateResult,
} from './types.js';
import { extractors, FrozenGateFileNotFoundError } from './extractors/index.js';

export class FrozenContractMalformedError extends Error {
  readonly code = 'FROZEN_CONTRACT_MALFORMED';
  constructor(
    public readonly absPath: string,
    public readonly detail: string,
  ) {
    super(`frozen-gate: malformed contract at ${absPath}: ${detail}`);
    this.name = 'FrozenContractMalformedError';
  }
}

export class UnknownExtractorError extends Error {
  readonly code = 'FROZEN_GATE_UNKNOWN_EXTRACTOR';
  constructor(public readonly extractorName: string) {
    super(`frozen-gate: unknown extractor '${extractorName}'`);
    this.name = 'UnknownExtractorError';
  }
}

const KNOWN_EXTRACTORS: readonly ExtractorName[] = [
  'file_sha256_v1',
  'ts_export_surface_v1',
  'json_schema_v1',
];

export async function gateFrozenPhase(
  repo: string,
  phaseId: string,
): Promise<GateResult> {
  const numericPrefix = phaseId.match(/^(\d+)/)?.[1];
  if (!numericPrefix) {
    throw new FrozenContractMalformedError(
      phaseId,
      'phaseId must start with a numeric prefix (e.g. "02-task-service")',
    );
  }
  const contractPath = join(
    repo,
    '.planning',
    'phases',
    phaseId,
    `${numericPrefix}-FROZEN-CONTRACT.json`,
  );

  // Phase has no contract → trivially passes.
  try {
    await access(contractPath);
  } catch {
    return { pass: true, phase_id: phaseId, checks: [] };
  }

  const contract = await loadContract(contractPath);
  const checks: GateCheck[] = [];
  for (const entry of contract.contracts) {
    checks.push(await evaluateEntry(repo, entry, contractPath));
  }

  const mismatches = checks.filter((c) => !c.pass);
  if (mismatches.length === 0) {
    return { pass: true, phase_id: phaseId, checks };
  }
  return {
    pass: false,
    phase_id: phaseId,
    checks,
    first_mismatch: mismatches[0]!,
    all_mismatches: mismatches,
  };
}

async function loadContract(absPath: string): Promise<FrozenContract> {
  const raw = await readFile(absPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new FrozenContractMalformedError(
      absPath,
      `JSON parse error: ${(err as Error).message}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { phase_id?: unknown }).phase_id !== 'string' ||
    !Array.isArray((parsed as { contracts?: unknown }).contracts)
  ) {
    throw new FrozenContractMalformedError(
      absPath,
      'expected { phase_id: string, contracts: [...] }',
    );
  }
  for (const [i, entry] of (
    (parsed as { contracts: unknown[] }).contracts
  ).entries()) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      typeof (entry as { dependency_id?: unknown }).dependency_id !== 'string' ||
      typeof (entry as { artifact_path?: unknown }).artifact_path !== 'string' ||
      typeof (entry as { extractor?: unknown }).extractor !== 'string'
    ) {
      throw new FrozenContractMalformedError(
        absPath,
        `contracts[${i}] missing required fields (dependency_id, artifact_path, extractor)`,
      );
    }
  }
  return parsed as FrozenContract;
}

async function evaluateEntry(
  repo: string,
  entry: FrozenContractEntry,
  contractPath: string,
): Promise<GateCheck> {
  if (!KNOWN_EXTRACTORS.includes(entry.extractor)) {
    throw new UnknownExtractorError(entry.extractor);
  }
  const extractor = extractors[entry.extractor];
  if (!extractor) {
    // Registered name but unimplemented — defensive guard against future
    // type drift.
    throw new UnknownExtractorError(
      `${entry.extractor} (registered but not implemented)`,
    );
  }

  let actual: { sha256?: string; normalized?: string };
  try {
    actual = await extractor(repo, entry.artifact_path);
  } catch (err) {
    if (err instanceof FrozenGateFileNotFoundError) {
      return {
        dependency_id: entry.dependency_id,
        extractor: entry.extractor,
        pass: false,
        expected_sha256: entry.expected_sha256,
        expected_normalized:
          entry.expected_normalized === null
            ? undefined
            : entry.expected_normalized,
        reason: `artifact missing: ${entry.artifact_path}`,
      };
    }
    throw err;
  }

  const expected_sha256 = entry.expected_sha256;
  const expected_normalized =
    entry.expected_normalized === null ? undefined : entry.expected_normalized;

  let pass = true;
  const reasons: string[] = [];

  if (expected_sha256 !== undefined && actual.sha256 !== undefined) {
    if (actual.sha256 !== expected_sha256) {
      pass = false;
      reasons.push('sha256 mismatch');
    }
  }
  if (expected_normalized !== undefined && actual.normalized !== undefined) {
    if (actual.normalized !== expected_normalized) {
      pass = false;
      reasons.push('normalized mismatch');
    }
  }
  // Both expected fields absent → contract entry has nothing to check.
  // Surface as a malformed contract.
  if (expected_sha256 === undefined && expected_normalized === undefined) {
    throw new FrozenContractMalformedError(
      contractPath,
      `contract '${entry.dependency_id}' has neither expected_sha256 nor expected_normalized`,
    );
  }

  return {
    dependency_id: entry.dependency_id,
    extractor: entry.extractor,
    pass,
    expected_sha256,
    actual_sha256: actual.sha256,
    expected_normalized,
    actual_normalized: actual.normalized,
    reason: pass ? undefined : reasons.join(', '),
  };
}
