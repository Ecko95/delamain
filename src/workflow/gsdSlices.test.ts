// workflows/gsd-slices.ts — the branch-per-slice orchestrator behind the
// delamain-orchestrate Codex skill.
//   1. the shipped script passes the sandbox AST guard
//   2. planWaves: dependency waves, and the plan errors the skill relies on
//   3. buildSlicePrompt: the spec-driven rules every slice leaf must see
//   4. the slice opts reach the leaf spawn with integrate ON and the right refs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PeerRecord, SpawnPeerOptions } from "../types.js";
import { runAgentCall, type AgentCallDeps } from "./ctx.js";
import { validateWorkflowSource } from "./sandbox.js";

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflows", "gsd-slices.ts");

// The workflow lives outside tsconfig's rootDir (it is sandbox source, not
// library code), so load its exported helpers dynamically for the unit tests.
const { buildFinalizePrompt, buildSlicePrompt, planWaves, sliceLanded, juryOutcome } = (await import(/* @vite-ignore */ WORKFLOW_PATH)) as {
  planWaves: (slices: unknown[]) => Array<Array<{ id: string }>>;
  buildSlicePrompt: (plan: unknown, slice: unknown, upstreamBranch: string | null) => string;
  buildFinalizePrompt: (plan: unknown) => string;
  sliceLanded: (result: unknown) => boolean;
  juryOutcome: (verdict: { survived: boolean; refutedCount: number; jurors: number }) => { survived: boolean; jurors: number; note: string | null };
};

const slice = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `title ${id}`, prompt: `do ${id}`, ...extra });

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
      expect(p).not.toContain("upstream slice");
    });

    it("tells a dependent slice which upstream branch it starts from", () => {
      const p = buildSlicePrompt(plan, slice("P04", { dependsOn: ["P03"] }) as any, "codex-peer/abc123");
      expect(p).toContain("starts from origin/codex-peer/abc123");
    });
  });

  it("sliceLanded requires done + a branch + at least one committed file (a no-change done is not pushed)", () => {
    const ok = { status: "done", branch: "codex-peer/x", summary: "", filesChanged: ["a.ts"], verification: "", residualRisk: "" };
    expect(sliceLanded(ok)).toBe(true);
    expect(sliceLanded({ ...ok, filesChanged: [] })).toBe(false);
    expect(sliceLanded({ ...ok, branch: "" })).toBe(false);
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

  it("slice opts reach the leaf spawn with integrate ON and the wave's start ref", async () => {
    const spawns: SpawnPeerOptions[] = [];
    const basePeer: PeerRecord = { id: "leaf-1", repo: "/tmp/wt", task: "task", status: "done", startedAt: "t", updatedAt: "t", logPath: "/tmp/log", finalResult: "ok" };
    const deps: AgentCallDeps = {
      spawnPeer: (options) => {
        spawns.push(options);
        return { ...basePeer };
      },
      waitForPeer: async ({ peerId }) => ({ peer: { ...basePeer, id: peerId }, timedOut: false, elapsedMs: 1 }),
      resumePeer: () => ({ ...basePeer }),
      readAgentResultFile: () => undefined,
      removeAgentResultFile: () => {},
    };
    // Exactly the opts workflows/gsd-slices.ts builds for a wave-2 slice.
    await runAgentCall(deps, { repo: "/repo" }, "slice prompt", {
      label: "P04 · title",
      model: "gpt-6-sol",
      startRef: "origin/codex-peer/abc123",
      mergeBranch: "main",
      integrate: true,
    });
    expect(spawns[0]).toMatchObject({ repo: "/repo", name: "P04 · title", model: "gpt-6-sol", startRef: "origin/codex-peer/abc123", mergeBranch: "main", integrate: true });
  });
});
