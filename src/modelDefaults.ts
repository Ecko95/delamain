/**
 * Models that already reason well at Codex's own default effort, so delamain
 * does not force `model_reasoning_effort="high"` on them: gpt-5.5 and the
 * whole GPT-6 family (gpt-6-astra, gpt-6-sol, gpt-6-luna, ...).
 */
// Boundary-aware: "gpt-6", "gpt-6-sol", "gpt-6.1", "gpt-5.5-codex" match;
// "gpt-60" or "gpt-6x" do not. Same family rule pricing.ts applies by prefix.
const OWN_DEFAULT_FAMILY = /^gpt-(?:5\.5|6)(?:[-.]|$)/;

export function usesOwnReasoningDefault(model: string | undefined): boolean {
  return !model || OWN_DEFAULT_FAMILY.test(model);
}
