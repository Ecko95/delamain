// SP1 wave 5 example — loop-until-dry (design §4).
//
// Keep finding bugs until K consecutive rounds surface nothing new, with a hard
// `maxRounds` ceiling so it always terminates. This is a SCRIPT pattern, not a
// new primitive — the runtime brakes (maxAgents / budgetTokens / timeoutMs)
// bound it too. Each round fans out finders with ctx.parallel and adversarially
// confirms fresh findings with ctx.verify before accepting them.
//
// Run: delamain run-workflow examples/workflows/loop-until-dry.ts \
//        --max-agents 40 --budget-tokens 3000000 --timeout-ms 1800000
export const meta = {
  name: "loop-until-dry",
  description: "find bugs until N dry rounds or maxRounds, verifying each finding",
};

const FINDERS = [
  "Scan src/ for correctness bugs (null/undefined, off-by-one, wrong conditions).",
  "Scan src/ for concurrency and resource bugs (races, leaks, unbounded work).",
  "Scan src/ for security bugs (injection, path traversal, missing validation).",
];

const BUG_SCHEMA = {
  type: "object",
  required: ["bugs"],
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "summary"],
        properties: { file: { type: "string" }, summary: { type: "string" } },
      },
    },
  },
};

export default async function run(ctx) {
  const maxRounds = 3; // hard ceiling — always terminates
  const dryStop = 2; // stop after this many consecutive rounds with nothing new
  const seen = new Set();
  const confirmed = [];
  let dryRounds = 0;

  for (let round = 1; round <= maxRounds && dryRounds < dryStop; round += 1) {
    ctx.phase(`round-${round}`);
    ctx.log(`round ${round}: budget ${ctx.budget.remaining()} tokens`);

    // Fan out finders (barrier); a dead finder degrades to null.
    const found = (await ctx.parallel(FINDERS.map((prompt) => () => ctx.agent(prompt, { schema: BUG_SCHEMA, label: "finder" }))))
      .filter(Boolean)
      .flatMap((r) => r.bugs || []);

    // Dedup vs everything seen so far (NOT vs confirmed — else rejected bugs reappear forever).
    const fresh = found.filter((b) => {
      const key = `${b.file}::${b.summary}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (fresh.length === 0) {
      dryRounds += 1;
      continue;
    }
    dryRounds = 0;

    // Adversarially confirm each fresh finding with an engine-diverse jury.
    for (const bug of fresh) {
      const verdict = await ctx.verify(`${bug.file}: ${bug.summary}`, { jurors: 3, lens: ["correctness", "security", "repro"] });
      if (verdict.survived) confirmed.push(bug);
    }
  }

  return { confirmed: confirmed.length, bugs: confirmed };
}
