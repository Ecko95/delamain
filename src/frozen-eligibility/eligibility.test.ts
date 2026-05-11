// src/frozen-eligibility/eligibility.test.ts
//
// Phase 37 plan 01: synthetic-fixture unit tests for classifyFrozenBatch.
// Each case constructs a minimal .planning/phases/<id>/ tree in os.tmpdir(),
// invokes the classifier, then asserts the discriminated-union outcome.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFrozenBatch } from './eligibility.js';

const ELIGIBLE_FRONTMATTER = `---
phase: 99-fixture
type: execute
autonomous: true
---

# Phase 99 fixture
Body without risky keywords. Just a plain sentence.
`;

const FROZEN_CONTRACT = JSON.stringify({ version: 1, entries: [] });

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'frozen-elig-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePhase(
  phaseId: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(root, '.planning', 'phases', phaseId);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8');
  }
}

describe('classifyFrozenBatch', () => {
  it('returns eligible:true when every condition is met', async () => {
    await writePhase('99-fixture', {
      '99-FROZEN-CONTRACT.json': FROZEN_CONTRACT,
      '99-01-PLAN.md': ELIGIBLE_FRONTMATTER,
    });
    const r = await classifyFrozenBatch(root, ['99-fixture']);
    expect(r).toEqual({ eligible: true });
  });

  it('reports missing FROZEN-CONTRACT.json', async () => {
    await writePhase('99-fixture', {
      '99-01-PLAN.md': ELIGIBLE_FRONTMATTER,
    });
    const r = await classifyFrozenBatch(root, ['99-fixture']);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    expect(r.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/FROZEN-CONTRACT.json missing/)]),
    );
  });

  it('reports type !== execute', async () => {
    const wrongType = ELIGIBLE_FRONTMATTER.replace('type: execute', 'type: discuss');
    await writePhase('99-fixture', {
      '99-FROZEN-CONTRACT.json': FROZEN_CONTRACT,
      '99-01-PLAN.md': wrongType,
    });
    const r = await classifyFrozenBatch(root, ['99-fixture']);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    expect(r.reasons.some((s) => s.includes("type is 'discuss', expected 'execute'"))).toBe(true);
  });

  it('reports autonomous !== true', async () => {
    const notAutonomous = ELIGIBLE_FRONTMATTER.replace('autonomous: true', 'autonomous: false');
    await writePhase('99-fixture', {
      '99-FROZEN-CONTRACT.json': FROZEN_CONTRACT,
      '99-01-PLAN.md': notAutonomous,
    });
    const r = await classifyFrozenBatch(root, ['99-fixture']);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    expect(r.reasons.some((s) => s.includes("autonomous is 'false', expected 'true'"))).toBe(true);
  });

  it('reports risky keyword in CONTEXT.md', async () => {
    await writePhase('99-fixture', {
      '99-FROZEN-CONTRACT.json': FROZEN_CONTRACT,
      '99-01-PLAN.md': ELIGIBLE_FRONTMATTER,
      '99-CONTEXT.md': 'Some preamble.\n\nTODO: finish this section.\n',
    });
    const r = await classifyFrozenBatch(root, ['99-fixture']);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    expect(r.reasons.some((s) => s.includes("contains risky keyword 'TODO'"))).toBe(true);
  });

  it('aggregates ALL reasons — no short-circuit', async () => {
    // Contract missing + wrong type + risky keyword in CONTEXT, all at once.
    const wrongType = ELIGIBLE_FRONTMATTER.replace('type: execute', 'type: discuss');
    await writePhase('99-fixture', {
      '99-01-PLAN.md': wrongType,
      '99-CONTEXT.md': 'WIP — needs human review before we move on.\n',
    });
    const r = await classifyFrozenBatch(root, ['99-fixture']);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    // Expect at least 4 distinct reasons (contract, type, WIP, needs-human-review).
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
    expect(r.reasons.some((s) => s.includes('FROZEN-CONTRACT.json missing'))).toBe(true);
    expect(r.reasons.some((s) => s.includes("type is 'discuss'"))).toBe(true);
    expect(r.reasons.some((s) => s.includes("'WIP'"))).toBe(true);
    expect(r.reasons.some((s) => s.includes("'needs human review'"))).toBe(true);
  });

  it('returns eligible:false on empty phaseIds (defensive)', async () => {
    const r = await classifyFrozenBatch(root, []);
    expect(r.eligible).toBe(false);
    if (r.eligible === true) throw new Error('unreachable');
    expect(r.reasons[0]).toContain('phaseIds is empty');
  });
});
