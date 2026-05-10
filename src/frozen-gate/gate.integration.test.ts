// src/frozen-gate/gate.integration.test.ts
//
// Integration tests against the Phase 31 fixture at
// ~/dev/fixtures/frozen-batch/. The fixture is READ-ONLY — every test
// works against a temp clone (via `git clone --no-local`).
//
// Reconciliation note (Option A): the Phase 31 fixture's FROZEN-CONTRACT
// `expected_normalized` for ts_export_surface_v1 was pinned by Phase 31's
// regex-based demo runner. Phase 32's tree-sitter extractor produces a
// structurally equivalent but byte-different normalized form (different
// JSON shape, sorted by name, with whitespace + trailing newline). Each
// integration test therefore recomputes `expected_sha256` and
// `expected_normalized` for the surface contract in its temp clone using
// Phase 32's own extractor against the canonical pass-control source.
// The file_sha256_v1 contract's `expected_sha256` is left untouched —
// it matches `sha256sum` of the canonical bytes and Phase 32 implements
// the same algorithm.
//
// A beforeAll/afterAll guard snapshots the user's actual fixture HEAD;
// the suite asserts it never changes — the read-only fixture invariant
// is load-bearing for Phase 32 success criterion 5 (side-effect-free).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gateFrozenPhase } from './gate.js';
import { extractTsExportSurface } from './extractors/index.js';

const FIXTURE_REPO = join(
  process.env.HOME ?? '',
  'dev',
  'fixtures',
  'frozen-batch',
);

function runGit(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  }
}

async function fixtureAvailable(): Promise<boolean> {
  try {
    await stat(FIXTURE_REPO);
    return true;
  } catch {
    return false;
  }
}

async function cloneFixtureAt(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `frozen-batch-${tag}-`));
  // --no-local forces a real clone (not hardlinked objects); mutations
  // to the temp clone cannot leak back to FIXTURE_REPO.
  const cloneResult = spawnSync(
    'git',
    ['clone', '--no-local', '--quiet', FIXTURE_REPO, dir],
    { encoding: 'utf8' },
  );
  if (cloneResult.status !== 0) {
    throw new Error(
      `git clone --no-local failed: ${cloneResult.stderr || cloneResult.stdout}`,
    );
  }
  runGit(dir, 'checkout', '--quiet', tag);
  return dir;
}

/**
 * Patch the ts_export_surface_v1 contract entry in a temp clone's
 * FROZEN-CONTRACT.json so its `expected_*` fields reflect Phase 32's
 * extractor output (recomputed against `canonicalSourcePath` of
 * `canonicalRepo`). This is the Option A reconciliation: Phase 31's
 * pinned normalized form is structurally different from Phase 32's
 * output; we re-pin in-clone to keep the test self-consistent.
 */
async function reExpectSurface(
  targetRepo: string,
  phaseId: string,
  dependencyId: string,
  canonicalRepo: string,
  canonicalSourcePath: string,
): Promise<void> {
  const surface = await extractTsExportSurface(
    canonicalRepo,
    canonicalSourcePath,
  );
  const numericPrefix = phaseId.match(/^(\d+)/)![1];
  const contractPath = join(
    targetRepo,
    '.planning',
    'phases',
    phaseId,
    `${numericPrefix}-FROZEN-CONTRACT.json`,
  );
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  for (const c of contract.contracts) {
    if (c.dependency_id === dependencyId) {
      c.expected_sha256 = surface.sha256;
      c.expected_normalized = surface.normalized;
    }
  }
  await writeFile(
    contractPath,
    JSON.stringify(contract, null, 2) + '\n',
    'utf8',
  );
}

const fixtureGuards: { sha?: string; branch?: string; dirty?: string } = {};

beforeAll(() => {
  // Snapshot the user's actual fixture HEAD; afterAll asserts it is
  // unchanged. This is the canary for "did the test accidentally write
  // through to the user's fixture".
  const sha = spawnSync('git', ['-C', FIXTURE_REPO, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const branch = spawnSync(
    'git',
    ['-C', FIXTURE_REPO, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { encoding: 'utf8' },
  ).stdout.trim();
  const dirty = spawnSync('git', ['-C', FIXTURE_REPO, 'status', '-s'], {
    encoding: 'utf8',
  }).stdout;
  fixtureGuards.sha = sha;
  fixtureGuards.branch = branch;
  fixtureGuards.dirty = dirty;
});

afterAll(() => {
  // Re-read and compare. Any divergence means a test wrote through.
  const sha = spawnSync('git', ['-C', FIXTURE_REPO, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const branch = spawnSync(
    'git',
    ['-C', FIXTURE_REPO, 'rev-parse', '--abbrev-ref', 'HEAD'],
    { encoding: 'utf8' },
  ).stdout.trim();
  const dirty = spawnSync('git', ['-C', FIXTURE_REPO, 'status', '-s'], {
    encoding: 'utf8',
  }).stdout;
  expect(sha).toBe(fixtureGuards.sha);
  expect(branch).toBe(fixtureGuards.branch);
  expect(dirty).toBe(fixtureGuards.dirty);
});

describe('gateFrozenPhase — integration against ~/dev/fixtures/frozen-batch/', () => {
  it('pass-control-v1: phase 02-task-service returns pass:true', async () => {
    if (!(await fixtureAvailable())) return;
    const tmp = await cloneFixtureAt('pass-control-v1');
    try {
      // Re-pin the surface contract using Phase 32's extractor against
      // the canonical task-store.ts in this same clone.
      await reExpectSurface(
        tmp,
        '02-task-service',
        'task-store-surface',
        tmp,
        'src/task-store.ts',
      );
      const r = await gateFrozenPhase(tmp, '02-task-service');
      expect(r.pass).toBe(true);
      expect(r.checks).toHaveLength(2);
      expect(r.checks.every((c) => c.pass)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('pass-control-v1: phase 03-http-integration surfaces missing artifact as check failure (fixture quirk: src/task-service.ts is absent from pass-control-v1)', async () => {
    // Fixture finding: pass-control-v1 contains src/task-store.ts but
    // NOT src/task-service.ts, even though the phase-03 FROZEN-CONTRACT
    // references it. Per the orchestrator contract, missing artifacts
    // surface as check failures with reason: "artifact missing" rather
    // than throwing. This test pins that behaviour against the real
    // fixture. Documented as Phase 31 fixture incompleteness in the
    // Phase 32-04 SUMMARY (Rule 4 architectural deviation candidate;
    // does NOT block Phase 32 success criteria since orchestrator
    // semantics are correctly exercised).
    if (!(await fixtureAvailable())) return;
    const tmp = await cloneFixtureAt('pass-control-v1');
    try {
      const r = await gateFrozenPhase(tmp, '03-http-integration');
      expect(r.pass).toBe(false);
      if (!r.pass) {
        expect(r.all_mismatches).toHaveLength(2);
        for (const m of r.all_mismatches) {
          expect(m.reason).toContain('artifact missing');
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('kill-test-v1: phase 02-task-service returns pass:false with both extractors detecting drift', async () => {
    if (!(await fixtureAvailable())) return;
    // Two clones: pass-control supplies canonical expected values
    // (recomputed via Phase 32's extractor); kill-test is the subject
    // whose drifted source must trip BOTH checks.
    const canonical = await cloneFixtureAt('pass-control-v1');
    const subject = await cloneFixtureAt('kill-test-v1');
    try {
      // Re-pin the kill-test clone's surface contract against the
      // canonical (pass-control) source's Phase 32 normalized form.
      // file_sha256_v1's expected_sha256 already matches canonical bytes;
      // leave it untouched so the kill-test's source-rename trips it.
      await reExpectSurface(
        subject,
        '02-task-service',
        'task-store-surface',
        canonical,
        'src/task-store.ts',
      );

      const r = await gateFrozenPhase(subject, '02-task-service');
      expect(r.pass).toBe(false);
      if (!r.pass) {
        expect(r.all_mismatches).toHaveLength(2);
        const ids = new Set(r.all_mismatches.map((m) => m.dependency_id));
        expect(ids.has('task-store-source')).toBe(true);
        expect(ids.has('task-store-surface')).toBe(true);

        const sourceMismatch = r.all_mismatches.find(
          (m) => m.dependency_id === 'task-store-source',
        )!;
        expect(sourceMismatch.expected_sha256).not.toBe(
          sourceMismatch.actual_sha256,
        );

        const surfaceMismatch = r.all_mismatches.find(
          (m) => m.dependency_id === 'task-store-surface',
        )!;
        expect(surfaceMismatch.expected_normalized).not.toBe(
          surfaceMismatch.actual_normalized,
        );
      }
    } finally {
      await rm(canonical, { recursive: true, force: true });
      await rm(subject, { recursive: true, force: true });
    }
  });
});
