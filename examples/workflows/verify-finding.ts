// SP1 wave 5 example — adversarial verify with an engine-diverse jury (§4).
//
// One agent proposes the biggest risk in a file; a 3-juror panel (rotating
// codex/cursor engines and correctness/security/repro lenses) tries to refute
// it. The finding is only accepted if it survives the majority-refute vote.
//
// Run: delamain run-workflow examples/workflows/verify-finding.ts \
//        --max-agents 8 --timeout-ms 900000
export const meta = { name: "verify-finding", description: "propose a risk, then adversarially verify it" };

export default async function run(ctx) {
  ctx.phase("propose");
  const finding = await ctx.agent("Review src/store.ts and state its single biggest risk in one sentence. Output JSON only.", {
    schema: {
      type: "object",
      required: ["risk", "severity"],
      properties: { risk: { type: "string" }, severity: { enum: ["low", "med", "high"] } },
    },
    label: "proposer",
  });

  ctx.phase("verify");
  const verdict = await ctx.verify(finding.risk, {
    jurors: 3,
    lens: ["correctness", "security", "repro"],
    engines: ["codex", "cursor"],
  });

  return {
    risk: finding.risk,
    severity: finding.severity,
    accepted: verdict.survived,
    refutedBy: verdict.refutedCount,
    jurors: verdict.jurors,
  };
}
