import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractJsonSchema,
  FrozenGateJsonParseError,
} from './json-schema.js';

let tmpRepo: string;
beforeAll(async () => {
  tmpRepo = await mkdtemp(join(tmpdir(), 'frozen-gate-json-schema-'));
});
afterAll(async () => {
  if (tmpRepo) await rm(tmpRepo, { recursive: true, force: true });
});

describe('extractJsonSchema', () => {
  it('canonicalises key order: { b: 1, a: 2 } and { a: 2, b: 1 } produce identical output', async () => {
    await writeFile(join(tmpRepo, 'a.json'), '{"b":1,"a":2}', 'utf8');
    await writeFile(join(tmpRepo, 'b.json'), '{"a":2,"b":1}', 'utf8');
    const ra = await extractJsonSchema(tmpRepo, 'a.json');
    const rb = await extractJsonSchema(tmpRepo, 'b.json');
    expect(ra.normalized).toBe(rb.normalized);
    expect(ra.sha256).toBe(rb.sha256);
    expect(ra.normalized).toBe('{"a":2,"b":1}');
  });

  it('strips whitespace: pretty-printed and minified produce identical output', async () => {
    await writeFile(
      join(tmpRepo, 'pretty.json'),
      '{\n  "x": 1,\n  "y": [1, 2, 3]\n}\n',
      'utf8',
    );
    await writeFile(join(tmpRepo, 'mini.json'), '{"x":1,"y":[1,2,3]}', 'utf8');
    const rp = await extractJsonSchema(tmpRepo, 'pretty.json');
    const rmini = await extractJsonSchema(tmpRepo, 'mini.json');
    expect(rp.normalized).toBe(rmini.normalized);
    expect(rp.sha256).toBe(rmini.sha256);
  });

  it('detects content drift: changed value produces different sha256', async () => {
    await writeFile(join(tmpRepo, 'v1.json'), '{"version":"1.0.0"}', 'utf8');
    await writeFile(join(tmpRepo, 'v2.json'), '{"version":"1.0.1"}', 'utf8');
    const a = await extractJsonSchema(tmpRepo, 'v1.json');
    const b = await extractJsonSchema(tmpRepo, 'v2.json');
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.normalized).not.toBe(b.normalized);
  });

  it('throws FrozenGateJsonParseError on malformed JSON', async () => {
    await writeFile(join(tmpRepo, 'bad.json'), '{not valid', 'utf8');
    let captured: unknown = null;
    try {
      await extractJsonSchema(tmpRepo, 'bad.json');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(FrozenGateJsonParseError);
    expect((captured as FrozenGateJsonParseError).code).toBe(
      'FROZEN_GATE_JSON_PARSE',
    );
  });

  it('is idempotent + side-effect-free', async () => {
    await writeFile(join(tmpRepo, 'idem.json'), '{"k":42}', 'utf8');
    const before = (await readdir(tmpRepo)).sort();
    const a = await extractJsonSchema(tmpRepo, 'idem.json');
    const b = await extractJsonSchema(tmpRepo, 'idem.json');
    const after = (await readdir(tmpRepo)).sort();
    expect(a.normalized).toBe(b.normalized);
    expect(a.sha256).toBe(b.sha256);
    expect(after).toEqual(before);
  });
});
