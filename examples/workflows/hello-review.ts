export const meta = { name: "hello-review", description: "single-agent schema demo" };
export default async function run(ctx) {
  const r = await ctx.agent(
    "Review src/store.ts and report the single biggest risk. Output JSON only.",
    { engine: "codex",
      schema: { type: "object", required: ["risk", "severity"],
        properties: { risk: { type: "string" },
                      severity: { enum: ["low", "med", "high"] } } } });
  return { topRisk: r.risk, severity: r.severity };
}
