// workflows/gsd-slices.ts — the branch-per-slice orchestrator behind the
// delamain-orchestrate Codex skill.
//   1. the shipped script passes the sandbox AST guard
//   2. planWaves: dependency waves, and the plan errors the skill relies on
//   3. buildSlicePrompt: the spec-driven rules every slice leaf must see
//   4. sliceLanded / juryOutcome: the "is this really a PR candidate" gates
//   5. run(ctx) end to end against a fake ctx: the exact opts each leaf gets,
//      wave ordering, upstream start refs, refuted/blocked handling, finalize
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkflowSource } from "./sandbox.js";

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "gsd-slices.ts");

// The workflow lives outside tsconfig's rootDir (it is sandbox source, not
// library code), so load it dynamically for the unit tests.
const mod = (await import(/* @vite-ignore */ WORKFLOW_PATH)) as {
  default: (ctx: unknown) => Promise<any>;
  planWaves: (slices: unknown[]) => Array<Array<{ id: string }>>;
  buildSlicePrompt: (plan: unknown, slice: unknown, upstreamBranch: string | null) => string;
  buildFinalizePrompt: (plan: unknown) => string;
  sliceLanded: (result: unknown) => boolean;
  juryOutcome: (verdict: { survived: boolean; refutedCount: number; jurors: number }) => { survived: boolean; jurors: number; note: string | null };
};
const { buildFinalizePrompt, buildSlicePrompt, planWaves, sliceLanded, juryOutcome } = mod;

const slice = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `title ${id}`, prompt: `do ${id}`, ...extra });

type LeafResult = { status: "done" | "blocked"; branch: string; summary: string; filesChanged: string[]; verification: string; residualRisk: string };
const done = (branch: string, files: string[] = ["a.ts"]): LeafResult => ({ status: "done", branch, summary: `did ${branch}`, filesChanged: files, verification: "npx vitest run", residualRisk: "" });

/**
 * A ctx that stands in for the sandbox: agent() records every call and answers
 * from `answers` keyed by slice id (the label is `<id> · <title>`), parallel()
 * mirrors the engine (thunk throw → null), verify() answers from `verdicts`.
 */
function fakeCtx(answers: Record<string, LeafResult | Error | string>, verdicts: Record<string, { survived: boolean; refutedCount: number; jurors: number }> = {}) {
  const calls: Array<{ prompt: string; opts: any }> = [];
  const verifies: string[] = [];
  const ctx = {
    agent: async (prompt: string, opts: any) => {
      calls.push({ prompt, opts });
      const id = String(opts.label).split(" · ")[0];
      const answer = answers[id] ?? answers[opts.label];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`no scripted answer for ${opts.label}`);
      return answer;
    },
    parallel: async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t().catch(() => null))),
    pipeline: async () => [],
    phase: () => {},
    log: () => {},
    verify: async (claim: string) => {
      verifies.push(claim);
      const id = /^Slice (\S+)/.exec(claim)?.[1] ?? "";
      const v = verdicts[id] ?? { survived: true, refutedCount: 0, jurors: 3 };
      return { claim, ...v, verdicts: [] };
    },
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
  return { ctx, calls, verifies };
}

async function runWorkflow(plan: Record<string, unknown>, ctx: unknown) {
  (globalThis as any).args = plan;
  try {
    return await mod.default(ctx);
  } finally {
    delete (globalThis as any).args;
  }
}

afterEach(() => {
  delete (globalThis as any).args;
});

describe("gsd-slices workflow", () => {
  it("the shipped workflow passes the sandbox AST guard", () => {
    expect(() => validateWorkflowSource(readFileSync(WORKFLOW_PATH, "utf8"), WORKFLOW_PATH)).not.toThrow();
  });

  describe("planWaves", () => {
    it("puts independent slices in wave 0 and dependents one wave after their upstream", () => {
      const waves = planWaves([slice("a"), slice("b"), slice("c", { dependsOn: ["a"] }), slice("d", { dependsOn: ["c"] })] as any);
      expect(waves.map((w) => w.map((s) => s.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    });

    it("rejects duplicate ids, unknown or multiple dependencies, cycles, and empty plans", () => {
      expect(() => planWaves([] as any)).toThrow(/non-empty/);
      expect(() => planWaves([slice("a"), slice("a")] as any)).toThrow(/duplicate slice id/);
      expect(() => planWaves([slice("a", { dependsOn: ["zzz"] })] as any)).toThrow(/unknown slice/);
      expect(() => planWaves([slice("a"), slice("b"), slice("c", { dependsOn: ["a", "b"] })] as any)).toThrow(/at most one dependency/);
      expect(() => planWaves([slice("a", { dependsOn: ["b"] }), slice("b", { dependsOn: ["a"] })] as any)).toThrow(/cycle/);
      expect(() => planWaves([{ id: "a", title: "t", prompt: "" }] as any)).toThrow(/non-empty prompt/);
    });
  });

  describe("buildSlicePrompt", () => {
    const plan = { name: "roadmap-m1", mergeBranch: "main", slices: [] } as any;

    it("carries the spec paths, acceptance, verification, and the .planning read-only rule", () => {
      const p = buildSlicePrompt(
        plan,
        slice("P03", { phase: "03", planPaths: [".planning/phases/03/PLAN.md"], acceptance: ["endpoint returns 200"], verification: ["npx vitest run src/api"] }) as any,
        null,
      );
      expect(p).toContain("# Slice P03: title P03");
      expect(p).toContain("OpenGSD phase: 03");
      expect(p).toContain(".planning/phases/03/PLAN.md");
      expect(p).toContain("- endpoint returns 200");
      expect(p).toContain("- npx vitest run src/api");
      expect(p).toContain("READ-ONLY");
      expect(p).toContain("Do not push, merge, or switch branches");
      expect(p).toContain("codex-peer/<id>");
      expect(p).not.toContain("upstream slice");
    });

    it("tells a dependent slice which upstream branch it starts from", () => {
      const p = buildSlicePrompt(plan, slice("P04", { dependsOn: ["P03"] }) as any, "codex-peer/abc123");
      expect(p).toContain("starts from origin/codex-peer/abc123");
    });
  });

  it("sliceLanded requires done + a codex-peer branch + at least one committed file", () => {
    const ok = done("codex-peer/x");
    expect(sliceLanded(ok)).toBe(true);
    expect(sliceLanded({ ...ok, filesChanged: [] })).toBe(false);
    expect(sliceLanded({ ...ok, branch: "" })).toBe(false);
    expect(sliceLanded({ ...ok, branch: "HEAD" })).toBe(false);
    expect(sliceLanded({ ...ok, branch: "origin/codex-peer/x" })).toBe(false);
    expect(sliceLanded({ ...ok, status: "blocked" })).toBe(false);
    expect(sliceLanded(null)).toBe(false);
  });

  it("juryOutcome never treats a jury with zero votes as approval", () => {
    expect(juryOutcome({ survived: true, refutedCount: 0, jurors: 0 })).toMatchObject({ survived: false, jurors: 0 });
    expect(juryOutcome({ survived: true, refutedCount: 0, jurors: 0 }).note).toMatch(/no juror/);
    expect(juryOutcome({ survived: true, refutedCount: 1, jurors: 3 })).toMatchObject({ survived: true, jurors: 3, note: null });
    expect(juryOutcome({ survived: false, refutedCount: 2, jurors: 3 }).survived).toBe(false);
  });

  it("buildFinalizePrompt lists landed slices and forbids product-code changes", () => {
    const p = buildFinalizePrompt({ name: "roadmap-m1", mergeBranch: "main", slices: [], landed: [{ id: "P03", phase: "03", branch: "codex-peer/x", summary: "did it" }] } as any);
    expect(p).toContain("- P03 (phase 03) — branch codex-peer/x: did it");
    expect(p).toContain("Do not implement or change product code");
  });

  describe("run(ctx) — implement stage", () => {
    const plan = {
      name: "roadmap-m1",
      mergeBranch: "main",
      startRef: "origin/release",
      model: "gpt-6-sol",
      slices: [slice("a"), slice("b"), slice("c", { dependsOn: ["a"], model: "gpt-6-astra" })],
    };

    it("issues wave leaves in plan order with integrate ON, then starts the dependent from the upstream's pushed branch", async () => {
      const { ctx, calls, verifies } = fakeCtx({ a: done("codex-peer/aaa"), b: done("codex-peer/bbb", []), c: done("codex-peer/ccc") });
      const result = await runWorkflow(plan, ctx);

      expect(calls.map((c) => c.opts.label)).toEqual(["a · title a", "b · title b", "c · title c"]);
      expect(calls[0].opts).toMatchObject({ integrate: true, mergeBranch: "main", startRef: "origin/release", model: "gpt-6-sol" });
      expect(calls[0].opts.schema).toBeDefined();
      expect(calls[0].prompt).toContain("# Slice a: title a");
      // Dependent: starts from the upstream's branch, keeps the merge target, uses its own model.
      expect(calls[2].opts).toMatchObject({ integrate: true, mergeBranch: "main", startRef: "origin/codex-peer/aaa", model: "gpt-6-astra" });
      expect(calls[2].prompt).toContain("starts from origin/codex-peer/aaa");

      expect(verifies).toEqual([]); // jury off by default
      expect(result.waves).toBe(2);
      expect(result.slices.map((s: any) => [s.id, s.wave, s.status, s.landed])).toEqual([
        ["a", 1, "done", true],
        ["b", 1, "blocked", false], // done with no committed files → nothing pushed → blocked
        ["c", 2, "done", true],
      ]);
      expect(result.slices[1].summary).toMatch(/committed no files/);
      expect(result.landed.map((l: any) => l.id)).toEqual(["a", "c"]);
    });

    it("a refuted upstream is landed but not approved, and its dependent is skipped for that reason", async () => {
      const { ctx, calls, verifies } = fakeCtx(
        { a: done("codex-peer/aaa"), b: done("codex-peer/bbb"), c: done("codex-peer/ccc") },
        { a: { survived: false, refutedCount: 2, jurors: 3 }, b: { survived: true, refutedCount: 0, jurors: 0 } },
      );
      const result = await runWorkflow({ ...plan, verify: { jurors: 3 } }, ctx);

      // Jury runs after the wave, once per landed slice, in plan order; c never spawns.
      expect(verifies.map((v) => /^Slice (\S+)/.exec(v)?.[1])).toEqual(["a", "b"]);
      expect(calls.map((c) => c.opts.label)).toEqual(["a · title a", "b · title b"]);
      const [a, b, c] = result.slices;
      expect(a).toMatchObject({ status: "done", landed: true, verified: { survived: false, jurors: 3 } });
      expect(b).toMatchObject({ status: "done", landed: true, verified: { survived: false, jurors: 0 } });
      expect(b.verified.note).toMatch(/no juror/);
      expect(c).toMatchObject({ status: "skipped", landed: false });
      expect(c.summary).toMatch(/dependency a landed but was refuted/);
      expect(result.landed).toEqual([]);
    });

    it("a misreported branch or a failed leaf never becomes an upstream", async () => {
      const { ctx, calls } = fakeCtx({ a: done("HEAD"), b: new Error("peer died"), c: done("codex-peer/ccc") });
      const result = await runWorkflow(plan, ctx);
      const [a, b, c] = result.slices;
      expect(a).toMatchObject({ status: "blocked", landed: false });
      expect(b).toMatchObject({ status: "failed", landed: false, error: "peer died" });
      expect(c).toMatchObject({ status: "skipped", summary: "dependency a did not land" });
      expect(calls).toHaveLength(2);
      expect(result.landed).toEqual([]);
    });

    it("rejects a plan without name or mergeBranch before spawning anything", async () => {
      const { ctx, calls } = fakeCtx({});
      await expect(runWorkflow({ mergeBranch: "main", slices: [slice("a")] }, ctx)).rejects.toThrow(/args\.name/);
      await expect(runWorkflow({ name: "x", slices: [slice("a")] }, ctx)).rejects.toThrow(/mergeBranch/);
      expect(calls).toHaveLength(0);
    });
  });

  it("run(ctx) — finalize stage runs one integrate-ON leaf from origin/<mergeBranch>, ignoring startRef", async () => {
    const { ctx, calls } = fakeCtx({ "roadmap-m1 · finalize": "marked 03 complete" });
    const result = await runWorkflow(
      { name: "roadmap-m1", mergeBranch: "main", startRef: "origin/release", stage: "finalize", slices: [slice("a")], landed: [{ id: "a", phase: "03", branch: "codex-peer/aaa", summary: "did a" }] },
      ctx,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ label: "roadmap-m1 · finalize", integrate: true, mergeBranch: "main", startRef: "origin/main" });
    expect(calls[0].opts.schema).toBeUndefined();
    expect(calls[0].prompt).toContain("- a (phase 03) — branch codex-peer/aaa: did a");
    expect(result).toMatchObject({ stage: "finalize", report: "marked 03 complete" });
  });
});
