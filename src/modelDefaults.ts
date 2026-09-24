/**
 * Models that already reason well at Codex's own default effort, so delamain
 * does not force `model_reasoning_effort="high"` on them: gpt-5.5 and the
 * whole GPT-6 family (gpt-6-astra, gpt-6-sol, gpt-6-luna, ...).
 */
export function usesOwnReasoningDefault(model: string | undefined): boolean {
  return !model || model === "gpt-5.5" || model.startsWith("gpt-6");
}
