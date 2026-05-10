// src/frozen-gate/extractors/ts-export-surface.test.ts
//
// Unit tests for ts_export_surface_v1. Synthetic fixtures only — no
// dependency on ~/dev/fixtures/frozen-batch/. Cross-validation against
// the real Phase 31 fixture lives in 32-04.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractTsExportSurface,
} from './ts-export-surface.js';

let tmpRepo: string;

beforeAll(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), 'frozen-gate-ts-export-'));
});

afterAll(async () => {
  if (tmpRepo) await rm(tmpRepo, { recursive: true, force: true });
});

async function writeFx(name: string, source: string): Promise<void> {
  await writeFile(join(tmpRepo, name), source, 'utf8');
}

describe('extractTsExportSurface — surface kinds', () => {
  it('captures exported class with methods (TaskStore reproduction)', async () => {
    const src = `
export interface Task { id: string; title: string; }
export class TaskStore {
  get(id: string): Task | undefined { return undefined; }
  store(task: Task): void {}
  list(): Task[] { return []; }
}
`;
    await writeFx('store.ts', src);
    const r = await extractTsExportSurface(tmpRepo, 'store.ts');
    const byName = new Map(r.exports.map((e) => [e.name, e]));
    const taskStore = byName.get('TaskStore');
    expect(taskStore?.kind).toBe('class');
    expect(taskStore?.signature).toContain('get(id: string): Task | undefined');
    expect(taskStore?.signature).toContain('store(task: Task): void');
    expect(taskStore?.signature).toContain('list(): Task[]');
    const task = byName.get('Task');
    expect(task?.kind).toBe('interface');
    expect(task?.signature).toContain('id: string');
    expect(task?.signature).toContain('title: string');
  });

  it('captures exported function with typed params', async () => {
    await writeFx(
      'fn.ts',
      `export function add(a: number, b: number): number { return a + b; }\n`,
    );
    const r = await extractTsExportSurface(tmpRepo, 'fn.ts');
    const fn = r.exports.find((e) => e.name === 'add');
    expect(fn?.kind).toBe('function');
    expect(fn?.signature).toBe('function add(a: number, b: number): number');
  });

  it('captures exported const', async () => {
    await writeFx('const.ts', `export const VERSION: string = '1.0.0';\n`);
    const r = await extractTsExportSurface(tmpRepo, 'const.ts');
    const c = r.exports.find((e) => e.name === 'VERSION');
    expect(c?.kind).toBe('const');
    expect(c?.signature).toContain('VERSION');
    expect(c?.signature).toContain('string');
  });

  it('captures exported type alias', async () => {
    await writeFx(
      'alias.ts',
      `export type TaskId = string;\nexport type Status = 'open' | 'closed';\n`,
    );
    const r = await extractTsExportSurface(tmpRepo, 'alias.ts');
    const id = r.exports.find((e) => e.name === 'TaskId');
    expect(id?.kind).toBe('type');
    expect(id?.signature).toBe('type TaskId = string');
    const status = r.exports.find((e) => e.name === 'Status');
    expect(status?.kind).toBe('type');
    expect(status?.signature).toContain("'open'");
    expect(status?.signature).toContain("'closed'");
  });

  it('captures exported interface', async () => {
    await writeFx(
      'iface.ts',
      `export interface Repo { name: string; stars: number; }\n`,
    );
    const r = await extractTsExportSurface(tmpRepo, 'iface.ts');
    const i = r.exports.find((e) => e.name === 'Repo');
    expect(i?.kind).toBe('interface');
    expect(i?.signature).toContain('name: string');
    expect(i?.signature).toContain('stars: number');
  });
});

describe('extractTsExportSurface — determinism + kill-test mutation', () => {
  it('is whitespace-stable: extra blank lines do not change the surface', async () => {
    const compact = `export class Foo { bar(): void {} }\n`;
    const sparse = `\n\nexport class Foo {\n\n  bar(): void {}\n\n}\n\n`;
    await writeFx('compact.ts', compact);
    await writeFx('sparse.ts', sparse);
    const a = await extractTsExportSurface(tmpRepo, 'compact.ts');
    const b = await extractTsExportSurface(tmpRepo, 'sparse.ts');
    // source_file differs in the normalized form — but exports[] should match.
    expect(a.exports).toEqual(b.exports);
  });

  it('kill-test: renaming get -> find changes the normalized form', async () => {
    const canonical = `
export interface Task { id: string; title: string; }
export class TaskStore {
  get(id: string): Task | undefined { return undefined; }
  store(task: Task): void {}
  list(): Task[] { return []; }
}
`;
    const mutated = canonical.replace(
      'get(id: string): Task | undefined',
      'find(id: string): Task | undefined',
    );
    await writeFx('canonical.ts', canonical);
    await writeFx('mutated.ts', mutated);
    const a = await extractTsExportSurface(tmpRepo, 'canonical.ts');
    const b = await extractTsExportSurface(tmpRepo, 'mutated.ts');
    expect(a.normalized).not.toBe(b.normalized);
    expect(a.sha256).not.toBe(b.sha256);
    // Specific assertion: the canonical surface mentions get(); the
    // mutated surface mentions find(); cross-contamination would mean
    // the extractor isn't actually parsing per-file.
    expect(a.normalized).toContain('get(id: string): Task | undefined');
    expect(b.normalized).toContain('find(id: string): Task | undefined');
    expect(a.normalized).not.toContain('find(id: string)');
    expect(b.normalized).not.toContain('get(id: string)');
  });

  it('is idempotent: same file produces identical normalized + sha256 across calls', async () => {
    await writeFx(
      'idem.ts',
      `export class Idem { x(): void {} y(): number { return 0; } }\n`,
    );
    const a = await extractTsExportSurface(tmpRepo, 'idem.ts');
    const b = await extractTsExportSurface(tmpRepo, 'idem.ts');
    expect(a.normalized).toBe(b.normalized);
    expect(a.sha256).toBe(b.sha256);
  });

  it('is side-effect-free: directory listing unchanged after extraction', async () => {
    await writeFx(
      'side-effect.ts',
      `export const FOO: number = 42;\n`,
    );
    const before = (await readdir(tmpRepo)).sort();
    await extractTsExportSurface(tmpRepo, 'side-effect.ts');
    await extractTsExportSurface(tmpRepo, 'side-effect.ts');
    const after = (await readdir(tmpRepo)).sort();
    expect(after).toEqual(before);
  });
});
