// workflows/gsd-slices.ts
//
// Spec-driven, branch-per-slice orchestration over an OpenGSD roadmap (or any
// hand-written slice plan). The `delamain-orchestrate` Codex skill
// (.codex/skills/delamain-orchestrate) writes a plan JSON and launches:
//
//   delamain run-workflow workflows/gsd-slices.ts --repo <repo> \
//     --name "<plan name>" --args-json "$(cat .delamain/orchestrate/<slug>.plan.json)" \
//     --max-agents <n> --budget-tokens <n> --timeout-ms <ms> --detach
//
// Two stages, selected by args.stage (default "implement"):
//
//   implement — slices are grouped into dependency waves (planWaves). Every
//               slice in a wave runs concurrently as ONE integrate-ON leaf in
//               its own worktree: it implements its phase from the committed
//               PLAN.md (the spec), never edits .planning/, and on done
//               delamain pushes its branch (codex-peer/<peerId>) rebased on
//               origin/<mergeBranch>. A slice with a dependency starts from
//               the dependency's pushed branch. Optional: after the wave, an
//               adversarial jury (ctx.verify) checks each landed slice.
//   finalize  — after the slice PRs have merged, one integrate-ON leaf does
//               the GSD bookkeeping (.planning/STATE.md + per-phase SUMMARY)
//               for the slices that landed. It always starts from
//               origin/<mergeBranch>, whatever plan.startRef says.
//
// WHY NOT /gsd-autonomous PER SLICE: GSD phases are stateful — each mutates
// .planning/STATE.md (see src/workflow/gsd.ts). Parallel worktrees would fork
// that state. So slices treat .planning/ as read-only input and the single
// finalize leaf reconciles it afterwards.
//
// Determinism: no Date/Math.random/imports (sandbox AST guard); everything the
// run needs is in `args`, which delamain persists for --resume replay. Agent
// calls are issued in a fixed order — implement leaves in plan order per wave,
// then jurors slice by slice — so the journal's index-matched replay holds.

export const meta = {
  name: "gsd-slices",
  description: "Run OpenGSD phases as parallel branch-per-slice leaves, then finalize .planning bookkeeping.",
};

type Slice = {
  /** Stable id, also the PR/branch label (e.g. "P03" or "auth-middleware"). */
  id: string;
  /** OpenGSD phase id when derived from .planning/ (informational). */
  phase?: string | null;
  /** One-line title used as the leaf label. */
  title: string;
  /** What to build. For GSD slices: paths to the committed PLAN.md files. */
  prompt: string;
  planPaths?: string[];
  /** Observable outcomes the leaf must satisfy. */
  acceptance?: string[];
  /** Shell verification (npx form) the leaf must run before reporting. */
  verification?: string[];
  /** At most ONE upstream slice id; this slice starts from its pushed branch. */
  dependsOn?: string[];
  engine?: "codex" | "cursor" | "pi";
  model?: string | null;
};

type Plan = {
  name: string;
  /** Origin branch every slice PR targets (bare name, e.g. "main"). */
  mergeBranch: string;
  /** Origin ref wave-0 worktrees start from (defaults to origin/<mergeBranch>). Ignored by finalize. */
  startRef?: string | null;
  slices: Slice[];
  /** Default engine/model for slices that don't set their own. */
  engine?: "codex" | "cursor" | "pi";
  model?: string | null;
  /** Adversarial jury per landed slice: 0/absent = off. */
  verify?: { jurors?: number; lens?: string[]; engines?: Array<"codex" | "cursor"> } | null;
  /** "implement" (default) or "finalize". */
  stage?: "implement" | "finalize";
  /** finalize stage: the `landed` array the implement run returned. */
  landed?: Array<{ id: string; phase?: string | null; branch?: string | null; summary?: string }>;
};

type SliceResult = {
  status: "done" | "blocked";
  branch: string;
  summary: string;
  filesChanged: string[];
  verification: string;
  residualRisk: string;
};

type JuryOutcome = { survived: boolean; refutedCount: number; jurors: number; note: string | null };

type SliceOutcome = {
  id: string;
  phase: string | null;
  title: string;
  wave: number;
  status: "done" | "blocked" | "failed" | "skipped";
  /** True only when the leaf reported done AND actually committed changes (so a branch was pushed). */
  landed: boolean;
  branch: string | null;
  summary: string;
  filesChanged: string[];
  verification: string;
  residualRisk: string;
  verified: JuryOutcome | null;
  error: string | null;
};

const SLICE_RESULT_SCHEMA = {
  type: "object",
  required: ["status", "branch", "summary", "filesChanged", "verification", "residualRisk"],
  properties: {
    status: { enum: ["done", "blocked"] },
    branch: { type: "string" },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    verification: { type: "string" },
    residualRisk: { type: "string" },
  },
};

/**
 * Group slices into dependency waves. Wave 0 = no dependency; a slice with a
 * dependency lands one wave after it. Pure, so the skill's dry-run and the
 * unit tests can call it. Throws on duplicate ids, unknown or multiple
 * dependencies, and cycles.
 */
export function planWaves(slices: Slice[]): Slice[][] {
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error("plan.slices must be a non-empty array");
  }
  const byId = new Map<string, Slice>();
  for (const s of slices) {
    if (!s || typeof s.id !== "string" || !s.id.trim()) throw new Error("every slice needs a non-empty string id");
    if (byId.has(s.id)) throw new Error(`duplicate slice id ${JSON.stringify(s.id)}`);
    if (typeof s.prompt !== "string" || !s.prompt.trim()) throw new Error(`slice ${s.id} needs a non-empty prompt`);
    if (typeof s.title !== "string" || !s.title.trim()) throw new Error(`slice ${s.id} needs a non-empty title`);
    byId.set(s.id, s);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`dependency cycle through slice ${JSON.stringify(id)}`);
    visiting.add(id);
    const s = byId.get(id)!;
    const deps = (s.dependsOn ?? []).filter(Boolean);
    if (deps.length > 1) {
      throw new Error(`slice ${id} depends on ${deps.length} slices; at most one dependency is supported (a leaf can start from only one branch)`);
    }
    let d = 0;
    if (deps.length === 1) {
      if (!byId.has(deps[0])) throw new Error(`slice ${id} depends on unknown slice ${JSON.stringify(deps[0])}`);
      d = depthOf(deps[0]) + 1;
    }
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  const waves: Slice[][] = [];
  for (const s of slices) {
    const d = depthOf(s.id);
    while (waves.length <= d) waves.push([]);
    waves[d].push(s);
  }
  return waves;
}

/**
 * Did a leaf's result mean a branch actually got pushed? delamain's on-done
 * push is SKIPPED (peer still ends "done") when the worktree has no commits
 * ahead of origin/<mergeBranch>, and ctx.agent cannot see that. A leaf that
 * changed nothing therefore must not become an upstream or a PR candidate.
 */
export function sliceLanded(result: SliceResult | null | undefined): boolean {
  return Boolean(result && result.status === "done" && typeof result.branch === "string" && result.branch.trim() && Array.isArray(result.filesChanged) && result.filesChanged.length > 0);
}

/** A jury where nobody voted is NOT an approval. */
export function juryOutcome(verdict: { survived: boolean; refutedCount: number; jurors: number }): JuryOutcome {
  if (!verdict || verdict.jurors === 0) {
    return { survived: false, refutedCount: 0, jurors: 0, note: "no juror returned a verdict; treat as unreviewed" };
  }
  return { survived: verdict.survived, refutedCount: verdict.refutedCount, jurors: verdict.jurors, note: null };
}

/** The self-contained, spec-driven prompt one slice leaf receives. */
export function buildSlicePrompt(plan: Plan, slice: Slice, upstreamBranch: string | null): string {
  const lines: string[] = [];
  lines.push(`# Slice ${slice.id}: ${slice.title}`);
  if (slice.phase) lines.push(`OpenGSD phase: ${slice.phase}`);
  lines.push(`Plan: ${plan.name}`);
  lines.push(`Merge target: origin/${plan.mergeBranch}`);
  if (upstreamBranch) lines.push(`Your worktree starts from origin/${upstreamBranch} (the upstream slice's branch); build on it, do not redo its work.`);
  lines.push("");
  lines.push("## Task");
  lines.push(slice.prompt.trim());
  if (slice.planPaths && slice.planPaths.length > 0) {
    lines.push("");
    lines.push("## Spec (read first — these files are committed in your worktree)");
    for (const p of slice.planPaths) lines.push(`- ${p}`);
    lines.push("Implement exactly what the plan specifies. If the plan is ambiguous, choose the smallest faithful reading and record it under residualRisk.");
  }
  if (slice.acceptance && slice.acceptance.length > 0) {
    lines.push("");
    lines.push("## Acceptance criteria");
    for (const a of slice.acceptance) lines.push(`- ${a}`);
  }
  lines.push("");
  lines.push("## Rules");
  lines.push("- Work only on this slice. Other slices run in parallel on their own branches; do not touch their files.");
  lines.push("- Treat `.planning/` (and `.gsd/`) as READ-ONLY. Do not edit STATE.md, ROADMAP.md, or any SUMMARY; a finalize step does that after your PR merges.");
  lines.push("- Do not push, merge, or switch branches; delamain pushes your branch when you finish.");
  lines.push("- Commit your work on the current branch with a clear message before finishing. If you end up with no commits, report status \"blocked\" — nothing would be pushed.");
  lines.push("- Use `npx <tool>` for verification, never `npm run <script>` (fresh worktrees may lack node_modules).");
  lines.push("");
  lines.push("## Verification (run before reporting)");
  if (slice.verification && slice.verification.length > 0) {
    for (const v of slice.verification) lines.push(`- ${v}`);
  } else {
    lines.push("- The project's typecheck and the tests covering the files you changed.");
  }
  lines.push("");
  lines.push("## Report");
  lines.push("Return status \"done\" only if every acceptance criterion is met, verification passed, and you committed changes; otherwise \"blocked\" with the reason in summary.");
  lines.push("`branch` must be the output of `git rev-parse --abbrev-ref HEAD` in your worktree; `filesChanged` must list every file you committed.");
  return lines.join("\n");
}

/** The GSD bookkeeping prompt for the finalize stage. */
export function buildFinalizePrompt(plan: Plan): string {
  const landed = plan.landed ?? [];
  const lines: string[] = [];
  lines.push(`# Finalize OpenGSD bookkeeping for plan "${plan.name}"`);
  lines.push(`Merge target: origin/${plan.mergeBranch}. Your worktree starts from it and already contains the merged slice PRs.`);
  lines.push("");
  lines.push("## Landed slices");
  if (landed.length === 0) lines.push("- (none listed — inspect git log against the roadmap and finalize only phases whose code is present)");
  for (const l of landed) lines.push(`- ${l.id}${l.phase ? ` (phase ${l.phase})` : ""}${l.branch ? ` — branch ${l.branch}` : ""}: ${l.summary ?? ""}`);
  lines.push("");
  lines.push("## Task");
  lines.push("For each landed slice, update `.planning/` the way `/gsd-execute-phase` would after a phase completes: write or update the phase SUMMARY, mark the phase complete in STATE.md, and advance the roadmap position. Do not implement or change product code. Do not mark a phase complete whose code is not actually on this branch.");
  lines.push("Commit the bookkeeping on the current branch. Do not push; delamain pushes it.");
  lines.push("Report a short list of the phases you marked complete and anything you could not reconcile.");
  return lines.join("\n");
}

export default async function run(ctx) {
  const plan = (args ?? {}) as Plan;
  if (typeof plan.name !== "string" || !plan.name.trim()) throw new Error("gsd-slices requires args.name");
  if (typeof plan.mergeBranch !== "string" || !plan.mergeBranch.trim()) throw new Error("gsd-slices requires args.mergeBranch (bare origin branch name)");
  const stage = plan.stage ?? "implement";

  if (stage === "finalize") {
    ctx.phase("finalize");
    const report = await ctx.agent(buildFinalizePrompt(plan), {
      label: `${plan.name} · finalize`,
      engine: plan.engine ?? undefined,
      model: plan.model ?? undefined,
      // Always the merged target — a pinned implement startRef (SHA/release
      // branch) would not contain the slice PRs the prompt promises.
      startRef: `origin/${plan.mergeBranch}`,
      mergeBranch: plan.mergeBranch,
      integrate: true,
    });
    return { plan: plan.name, stage, report, tokensSpent: ctx.budget.spent() };
  }
  if (stage !== "implement") throw new Error(`unknown stage ${JSON.stringify(stage)} (use "implement" or "finalize")`);

  const waves = planWaves(plan.slices);
  const jurors = plan.verify?.jurors ?? 0;
  ctx.log(`${plan.slices.length} slices in ${waves.length} wave(s); jurors per landed slice: ${jurors}; budget ${ctx.budget.remaining()} tokens`);

  const outcomes = new Map<string, SliceOutcome>();
  const branchOf = new Map<string, string>();
  const blank = (slice: Slice, wave: number): SliceOutcome => ({
    id: slice.id,
    phase: slice.phase ?? null,
    title: slice.title,
    wave,
    status: "failed",
    landed: false,
    branch: null,
    summary: "",
    filesChanged: [],
    verification: "",
    residualRisk: "",
    verified: null,
    error: null,
  });

  for (let w = 0; w < waves.length; w += 1) {
    const wave = waves[w];
    ctx.phase(`wave-${w + 1}`);
    ctx.log(`wave ${w + 1}: ${wave.map((s) => s.id).join(", ")}`);

    // Implement leaves: every ctx.agent call below is issued synchronously in
    // plan order before any awaits, so journal indices are stable across runs.
    await ctx.parallel(
      wave.map((slice) => async () => {
        const out = blank(slice, w + 1);
        outcomes.set(slice.id, out);
        const dep = (slice.dependsOn ?? []).filter(Boolean)[0];
        const upstream = dep ? branchOf.get(dep) ?? null : null;
        if (dep && !upstream) {
          out.status = "skipped";
          out.summary = `dependency ${dep} did not land`;
          return null;
        }
        try {
          const r = (await ctx.agent(buildSlicePrompt(plan, slice, upstream), {
            label: `${slice.id} · ${slice.title}`,
            schema: SLICE_RESULT_SCHEMA,
            engine: slice.engine ?? plan.engine ?? undefined,
            model: slice.model ?? plan.model ?? undefined,
            startRef: upstream ? `origin/${upstream}` : plan.startRef ?? `origin/${plan.mergeBranch}`,
            mergeBranch: plan.mergeBranch,
            integrate: true,
          })) as SliceResult;
          out.status = r.status;
          out.branch = r.branch || null;
          out.summary = r.summary;
          out.filesChanged = r.filesChanged ?? [];
          out.verification = r.verification ?? "";
          out.residualRisk = r.residualRisk ?? "";
          out.landed = sliceLanded(r);
          if (r.status === "done" && !out.landed) {
            out.status = "blocked";
            out.summary = `reported done but committed no files (nothing pushed); ${r.summary}`;
          }
          return r;
        } catch (err) {
          out.error = err instanceof Error ? err.message : String(err);
          return null;
        }
      }),
    );

    // Jury AFTER the wave, one landed slice at a time in plan order. Running
    // jurors as each slice finished would spawn them in completion order and
    // break --resume's index-matched replay for everything after them.
    for (const slice of wave) {
      const out = outcomes.get(slice.id)!;
      if (!out.landed) continue;
      if (jurors > 0) {
        const verdict = await ctx.verify(
          `Slice ${slice.id} ("${slice.title}") on branch origin/${out.branch} claims: ${out.summary}. Verification run: ${out.verification}. ` +
            `Fetch that branch, inspect its diff against origin/${plan.mergeBranch}, and refute the claim if the acceptance criteria are not met: ${(slice.acceptance ?? []).join("; ") || "(see the slice's PLAN.md)"}.`,
          { jurors, lens: plan.verify?.lens ?? undefined, engines: plan.verify?.engines ?? undefined },
        );
        out.verified = juryOutcome(verdict);
        if (!out.verified.survived) continue; // refuted or unreviewed: not an upstream, not a PR candidate
      }
      branchOf.set(slice.id, out.branch!);
    }
  }

  // Plan order, not completion order, so the result is stable and diffable.
  const results = plan.slices.map((s) => outcomes.get(s.id)!);
  const approved = results.filter((r) => r.landed && (!r.verified || r.verified.survived));
  ctx.log(`landed ${results.filter((r) => r.landed).length}/${results.length}; approved for PR ${approved.length}`);
  return {
    plan: plan.name,
    stage,
    mergeBranch: plan.mergeBranch,
    waves: waves.length,
    slices: results,
    // Feed this straight into the finalize stage's args.landed once the PRs merge.
    landed: approved.map((r) => ({ id: r.id, phase: r.phase, branch: r.branch, summary: r.summary })),
    tokensSpent: ctx.budget.spent(),
  };
}
