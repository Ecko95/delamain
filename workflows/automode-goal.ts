// workflows/automode-goal.ts
//
// Slice D — run an automode goal as a labeled delamain workflow. The gitscode
// automode dispatcher calls:
//
//   delamain run-workflow workflows/automode-goal.ts --repo <goalRepoPath> \
//     --name "Motoko Proposal - Verified (Automated) · <goal title>" \
//     --args-json '{"title":"...","prompt":"...","startRef":"<branch|null>","mergeBranch":"<branch|null>","model":"<model|null>"}' \
//     --detach
//
// One phase, one leaf: the goal prompt verbatim (the caller already prepends
// the Episode line). The leaf reproduces standalone automode spawn semantics —
// start from startRef when given, push/merge to mergeBranch when given,
// integrate-ON (branch pushed on done as usual). automode's own verify pipeline
// runs post-land, so there is no plan/verify stage here.
//
// The workflow NAME (--name) becomes the T3 thread title via t3Bridge; it is
// owned by the caller and passes through untouched. `args` is the --args-json
// payload injected as a sandbox global.

export const meta = {
  name: "automode-goal",
  description: "Run an automode goal as a single integrate-ON delamain leaf.",
};

type GoalArgs = {
  title: string;
  prompt: string;
  startRef?: string | null;
  mergeBranch?: string | null;
  model?: string | null;
};

export default async function run(ctx) {
  const a = (args ?? {}) as GoalArgs;
  if (!a || typeof a.prompt !== "string" || !a.prompt.trim()) {
    throw new Error("automode-goal requires args.prompt (the goal prompt)");
  }
  if (typeof a.title !== "string" || !a.title.trim()) {
    throw new Error("automode-goal requires args.title (the leaf label)");
  }

  ctx.phase("Implement");
  return ctx.agent(a.prompt, {
    label: a.title,
    model: a.model ?? undefined,
    startRef: a.startRef ?? undefined,
    mergeBranch: a.mergeBranch ?? undefined,
    integrate: true,
  });
}
