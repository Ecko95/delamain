// src/frozen-gate/extractors/file-sha256.test.ts
//
// Unit tests for the file_sha256_v1 extractor. Covers:
//   - Known content → known hash (canonical sha256 of "hello\n").
//   - File-not-found surfaces FrozenGateFileNotFoundError with .code.
//   - Idempotency: repeated calls produce identical hashes.
//   - Side-effect-free: directory listing before/after a call is identical.
//
// All fixtures are synthetic — no dependency on ~/dev/fixtures/frozen-batch/
// in this plan. Cross-validation against the real fixture lives in 32-04.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractFileSha256,
  FrozenGateFileNotFoundError,
} from './file-sha256.js';

let tmpRepo: string;

beforeAll(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), 'frozen-gate-file-sha256-'));
  await writeFile(join(tmpRepo, 'hello.txt'), 'hello\n', 'utf8');
  await writeFile(
    join(tmpRepo, 'task-store.ts'),
    'export class TaskStore { /* fixture */ }\n',
    'utf8',
  );
});

afterAll(async () => {
  if (tmpRepo) await rm(tmpRepo, { recursive: true, force: true });
});

describe('extractFileSha256', () => {
  it('hashes "hello\\n" to the canonical sha256', async () => {
    // sha256sum of "hello\n" is 5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03
    const { sha256 } = await extractFileSha256(tmpRepo, 'hello.txt');
    expect(sha256).toBe(
      '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03',
    );
  });

  it('throws FrozenGateFileNotFoundError for missing files', async () => {
    let captured: unknown = null;
    try {
      await extractFileSha256(tmpRepo, 'does-not-exist.ts');
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(FrozenGateFileNotFoundError);
    expect((captured as FrozenGateFileNotFoundError).code).toBe(
      'FROZEN_GATE_FILE_NOT_FOUND',
    );
    expect((captured as FrozenGateFileNotFoundError).absPath).toContain(
      'does-not-exist.ts',
    );
  });

  it('is idempotent: same input produces same hash across calls', async () => {
    const a = await extractFileSha256(tmpRepo, 'task-store.ts');
    const b = await extractFileSha256(tmpRepo, 'task-store.ts');
    const c = await extractFileSha256(tmpRepo, 'task-store.ts');
    expect(a.sha256).toBe(b.sha256);
    expect(b.sha256).toBe(c.sha256);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is side-effect-free: directory contents unchanged after extraction', async () => {
    const before = (await readdir(tmpRepo)).sort();
    await extractFileSha256(tmpRepo, 'hello.txt');
    await extractFileSha256(tmpRepo, 'task-store.ts');
    const after = (await readdir(tmpRepo)).sort();
    expect(after).toEqual(before);
  });
});
