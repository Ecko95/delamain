// src/frozen-gate/extractors/file-sha256.ts
//
// file_sha256_v1 extractor: returns the hex sha256 of a file's bytes.
// Pure Node stdlib (no tree-sitter, no third-party). Idempotent and
// side-effect-free per Phase 32 success criterion 5.
//
// The hash MUST match `sha256sum <file> | awk '{print $1}'` byte-for-byte
// — this is what the Phase 31 fixture's pinned `expected_sha256` values
// were computed against (e.g. ab28171d... for task-store.ts on
// pass-control-v1). Cross-validation against the fixture lands in 32-04.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class FrozenGateFileNotFoundError extends Error {
  readonly code = 'FROZEN_GATE_FILE_NOT_FOUND';
  constructor(public readonly absPath: string, cause?: unknown) {
    super(`frozen-gate: file not found at ${absPath}`);
    this.name = 'FrozenGateFileNotFoundError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export async function extractFileSha256(
  repo: string,
  relPath: string,
): Promise<{ sha256: string }> {
  const absPath = join(repo, relPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absPath);
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      throw new FrozenGateFileNotFoundError(absPath, err);
    }
    throw err;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { sha256 };
}
