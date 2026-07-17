// SP1 wave 2 acceptance demo — fan out N agents with parallel + pipeline, each
// in its own throwaway worktree (integrate:false), gated by the agent
// semaphore (at most DELAMAIN_MAX_AGENTS alive at once), then synthesize.
//
// Run: delamain run-workflow examples/workflows/fanout-review.ts \
//        --max-agents 12 --budget-tokens 2000000 --timeout-ms 1800000
export const meta = {
  name: "fanout-review",
  description: "parallel + pipeline schema review over a file list, then synthesize",
};

const FILES = [
  "src/store.ts",
  "src/peerManager.ts",
  "src/runner.ts",
  "src/git.ts",
  "src/mcpServer.ts",
  "src/cli.ts",
  "src/lifecycle.ts",
  "src/sweep.ts",
];

const RISK_SCHEMA = {
  type: "object",
  required: ["risk", "severity"],
  properties: {
    risk: { type: "string" },
    severity: { enum: ["low", "med", "high"] },
  },
};

export default async function run(ctx) {
  ctx.phase("review");
  ctx.log(`reviewing ${FILES.length} files; budget ${ctx.budget.remaining()} tokens`);

  // pipeline: each file streams through review → tag independently (no barrier).
  const reviewed = await ctx.pipeline(
    FILES,
    (file) =>
      ctx.agent(`Review ${file} and report its single biggest risk. Output JSON only.`, {
        schema: RISK_SCHEMA,
        label: file,
      }),
    (result, file) => ({ file, ...result }),
  );

  const findings = reviewed.filter(Boolean);
  const high = findings.filter((f) => f.severity === "high");

  ctx.phase("synthesize");
  const summary = await ctx.agent(
    `You are given ${findings.length} per-file risk findings as JSON:\n` +
      `${JSON.stringify(findings, null, 2)}\n` +
      `Identify the single most important cross-cutting risk. Output JSON only.`,
    {
      schema: {
        type: "object",
        required: ["topRisk", "rationale"],
        properties: { topRisk: { type: "string" }, rationale: { type: "string" } },
      },
      label: "synthesis",
    },
  );

  return {
    reviewed: findings.length,
    highSeverity: high.length,
    topRisk: summary.topRisk,
    rationale: summary.rationale,
    tokensSpent: ctx.budget.spent(),
  };
}
