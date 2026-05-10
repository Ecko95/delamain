// src/frozen-gate/extractors/json-schema.ts
//
// json_schema_v1 extractor: read a JSON file, re-serialize in canonical
// form (sorted keys, no whitespace), return normalized + sha256.
//
// Pure stdlib. Idempotent and side-effect-free.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FrozenGateFileNotFoundError } from './file-sha256.js';

export class FrozenGateJsonParseError extends Error {
  readonly code = 'FROZEN_GATE_JSON_PARSE';
  constructor(public readonly absPath: string, cause?: unknown) {
    super(`frozen-gate: failed to parse JSON at ${absPath}`);
    this.name = 'FrozenGateJsonParseError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export async function extractJsonSchema(
  repo: string,
  relPath: string,
): Promise<{ sha256: string; normalized: string }> {
  const absPath = join(repo, relPath);
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new FrozenGateJsonParseError(absPath, err);
  }
  const normalized = canonicalStringify(value);
  const sha256 = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return { sha256, normalized };
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonicalStringify((value as Record<string, unknown>)[k]),
      )
      .join(',') +
    '}'
  );
}
