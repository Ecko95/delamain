// src/frozen-eligibility/eligibility.integration.test.ts
//
// Phase 37 plan 01: integration test against the Phase 31 frozen-batch fixture.
//
// The Phase 31 fixture's `02-01-PLAN.md` was authored with `type: execute`
// but WITHOUT `autonomous: true` (the fixture predates Phase 37). The test
// documents this in two stages:
//   1. As-shipped at pass-control-v1 → classifyFrozenBatch reports
//      eligible:false with the autonomous-missing reason.
//   2. After patching the frontmatter to add `autonomous: true` →
//      classifyFrozenBatch reports eligible:true (or surfaces only
//      risky-keyword reasons originating from the fixture's own text).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFrozenBatch } from './eligibility.js';

const FIXTURE_REPO =
  process.env.FROZEN_BATCH_FIXTURE_PATH ?? `${process.env.HOME}/dev/fixtures/frozen-batch`;
const FIXTURE_TAG = 'pass-control-v1';
const PHASE_ID = '02-task-service';

const fixtureAvailable = existsSync(FIXTURE_REPO);

(fixtureAvailable ? describe : describe.skip)('classifyFrozenBatch — Phase 31 fixture', () => {
  let workdir: string;
  let clonePath: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'frozen-elig-fixture-'));
    clonePath = join(workdir, 'clone');
    execFileSync('git', ['clone', '--no-local', FIXTURE_REPO, clonePath], { stdio: 'pipe' });
    execFileSync('git', ['-C', clonePath, 'checkout', FIXTURE_TAG], { stdio: 'pipe' });
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('reports eligible:false on the fixture as-shipped (no autonomous: true)', async () => {
    const r = await classifyFrozenBatch(clonePath, [PHASE_ID]);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    // The exact reason we expect: autonomous missing on the PLAN.
    expect(
      r.reasons.some((s) => s.includes(PHASE_ID) && s.includes('autonomous')),
    ).toBe(true);
  });

  it('after patching the frontmatter to add autonomous: true, the autonomous reason is gone', async () => {
    const planPath = join(clonePath, '.planning', 'phases', PHASE_ID, '02-01-PLAN.md');
    const original = await readFile(planPath, 'utf8');
    // Insert `autonomous: true` immediately after the `type: execute` line.
    const patched = original.replace(
      /^type:\s*execute\s*$/m,
      'type: execute\nautonomous: true',
    );
    expect(patched).not.toBe(original); // sanity check the replace landed
    await writeFile(planPath, patched, 'utf8');
    const r = await classifyFrozenBatch(clonePath, [PHASE_ID]);
    // After patching: the autonomous-missing reason MUST be gone.
    if (r.eligible === false) {
      expect(r.reasons.some((s) => s.includes('autonomous'))).toBe(false);
    }
    // The result is either fully eligible or only fails on risky-keyword
    // reasons rooted in the fixture's own narrative text (the fixture is
    // a real planning tree and may legitimately contain words like
    // "discussion needed" in its CONTEXT files). Both outcomes prove the
    // patch flipped the autonomous gate.
    expect(r.eligible === true || (r.eligible === false && r.reasons.every((s) => s.includes('risky keyword')))).toBe(true);
  });
});
