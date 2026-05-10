import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  gateFrozenPhase,
  FrozenContractMalformedError,
  UnknownExtractorError,
} from './gate.js';
import { extractFileSha256 } from './extractors/index.js';

let tmpRepo: string;
beforeAll(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), 'frozen-gate-orch-'));
});
afterAll(async () => {
  if (tmpRepo) await rm(tmpRepo, { recursive: true, force: true });
});

async function setupPhase(
  phaseId: string,
  contract: object | null,
  files: Record<string, string>,
): Promise<void> {
  const phaseDir = join(tmpRepo, '.planning', 'phases', phaseId);
  await mkdir(phaseDir, { recursive: true });
  if (contract !== null) {
    const numericPrefix = phaseId.match(/^(\d+)/)![1];
    await writeFile(
      join(phaseDir, `${numericPrefix}-FROZEN-CONTRACT.json`),
      JSON.stringify(contract, null, 2),
      'utf8',
    );
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tmpRepo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

describe('gateFrozenPhase — orchestrator', () => {
  it('returns pass:true with empty checks when no FROZEN-CONTRACT.json exists', async () => {
    await setupPhase('99-no-contract', null, {});
    const r = await gateFrozenPhase(tmpRepo, '99-no-contract');
    expect(r.pass).toBe(true);
    expect(r.checks).toEqual([]);
  });

  it('returns pass:true when all file_sha256_v1 contracts match', async () => {
    const sourceContent = 'export const X = 1;\n';
    await mkdir(join(tmpRepo, 'src'), { recursive: true });
    await writeFile(join(tmpRepo, 'src', 'a.ts'), sourceContent, 'utf8');
    const real = await extractFileSha256(tmpRepo, 'src/a.ts');
    await setupPhase(
      '20-pass',
      {
        phase_id: '20-pass',
        contracts: [
          {
            dependency_id: 'src-a',
            artifact_path: 'src/a.ts',
            extractor: 'file_sha256_v1',
            expected_sha256: real.sha256,
            expected_normalized: null,
          },
        ],
      },
      {},
    );
    const r = await gateFrozenPhase(tmpRepo, '20-pass');
    expect(r.pass).toBe(true);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]!.pass).toBe(true);
  });

  it('returns pass:false aggregating ALL mismatches (no fail-fast)', async () => {
    await mkdir(join(tmpRepo, 'src'), { recursive: true });
    await writeFile(join(tmpRepo, 'src', 'b.ts'), 'export const Y = 2;\n', 'utf8');
    await writeFile(join(tmpRepo, 'src', 'c.ts'), 'export const Z = 3;\n', 'utf8');
    await setupPhase(
      '21-multi-fail',
      {
        phase_id: '21-multi-fail',
        contracts: [
          {
            dependency_id: 'src-b',
            artifact_path: 'src/b.ts',
            extractor: 'file_sha256_v1',
            expected_sha256: 'deadbeef'.repeat(8),
            expected_normalized: null,
          },
          {
            dependency_id: 'src-c',
            artifact_path: 'src/c.ts',
            extractor: 'file_sha256_v1',
            expected_sha256: 'cafebabe'.repeat(8),
            expected_normalized: null,
          },
        ],
      },
      {},
    );
    const r = await gateFrozenPhase(tmpRepo, '21-multi-fail');
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.all_mismatches).toHaveLength(2);
      expect(r.first_mismatch.dependency_id).toBe('src-b');
      expect(r.checks).toHaveLength(2);
    }
  });

  it('surfaces missing artifacts as check failures (not throws)', async () => {
    await setupPhase(
      '22-missing',
      {
        phase_id: '22-missing',
        contracts: [
          {
            dependency_id: 'gone',
            artifact_path: 'src/gone.ts',
            extractor: 'file_sha256_v1',
            expected_sha256: 'a'.repeat(64),
            expected_normalized: null,
          },
        ],
      },
      {},
    );
    const r = await gateFrozenPhase(tmpRepo, '22-missing');
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.first_mismatch.reason).toContain('artifact missing');
    }
  });

  it('throws UnknownExtractorError for unknown extractor names', async () => {
    await setupPhase(
      '23-bad-extractor',
      {
        phase_id: '23-bad-extractor',
        contracts: [
          {
            dependency_id: 'x',
            artifact_path: 'README.md',
            extractor: 'made_up_v9',
            expected_sha256: 'a'.repeat(64),
            expected_normalized: null,
          },
        ],
      },
      { 'README.md': '' },
    );
    await expect(
      gateFrozenPhase(tmpRepo, '23-bad-extractor'),
    ).rejects.toBeInstanceOf(UnknownExtractorError);
  });

  it('throws FrozenContractMalformedError for malformed contracts', async () => {
    const phaseDir = join(tmpRepo, '.planning', 'phases', '24-malformed');
    await mkdir(phaseDir, { recursive: true });
    await writeFile(
      join(phaseDir, '24-FROZEN-CONTRACT.json'),
      '{not valid',
      'utf8',
    );
    await expect(
      gateFrozenPhase(tmpRepo, '24-malformed'),
    ).rejects.toBeInstanceOf(FrozenContractMalformedError);
  });
});
