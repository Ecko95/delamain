# Plan file schema (`<slug>.plan.json`)

The plan is passed verbatim as `--args-json` and becomes the `args` global inside `gsd-slices.ts`. delamain persists it on the run record, so `--resume` replays the identical plan.

## Top level

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Run name; becomes the workflow `--name` and each leaf label prefix. |
| `mergeBranch` | string | yes | Bare origin branch every slice PR targets (`main`, not `origin/main`). |
| `startRef` | string | no | Origin ref wave-0 worktrees start from. Default `origin/<mergeBranch>`. Ignored by the `finalize` stage, which always starts from `origin/<mergeBranch>`. |
| `slices` | Slice[] | yes | The work. Non-empty. |
| `engine` | `"codex"` \| `"cursor"` \| `"pi"` | no | Default engine for slices (default `codex`). `pi` requires `model`. |
| `model` | string | no | Default model for slices (e.g. `gpt-6-sol`). |
| `verify` | object | no | `{ "jurors": 3, "lens": ["correctness","security","repro"], "engines": ["codex","cursor"] }`. Absent or `jurors: 0` disables the jury. |
| `stage` | `"implement"` \| `"finalize"` | no | Default `implement`. |
| `landed` | object[] | finalize only | The `landed` array from the implement result. |
| `runs` | object[] | no | Bookkeeping the skill appends: `{ stage, workflow_id, startedAt }`. Ignored by the workflow. |

## Slice

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Unique, short (`P03`, `auth-middleware`). Used in labels and dependency references. |
| `title` | string | yes | One line; the leaf's display name is `<id> · <title>`. |
| `phase` | string | no | OpenGSD phase id when derived from `.planning/`. |
| `prompt` | string | yes | What to build, in plain words. Not how. |
| `planPaths` | string[] | no | Repo-relative paths to PLAN.md / frozen contract. Must be committed on the start ref. |
| `acceptance` | string[] | no | Observable outcomes; the leaf reports `blocked` if any is unmet. |
| `verification` | string[] | no | `npx …` commands scoped to the slice. Default: project typecheck + tests for changed files. |
| `dependsOn` | string[] | no | **At most one** slice id. The slice starts from that slice's pushed branch and runs one wave later. |
| `engine`, `model` | | no | Per-slice overrides. |

## Result (what `workflow_status.result` contains after `implement`)

```json
{
  "plan": "roadmap-m1",
  "stage": "implement",
  "mergeBranch": "main",
  "waves": 2,
  "slices": [
    {
      "id": "P03", "phase": "03", "title": "Auth middleware", "wave": 1,
      "status": "done | blocked | failed | skipped",
      "landed": true,
      "branch": "codex-peer/<peerId>",
      "summary": "...", "filesChanged": ["src/auth.ts"],
      "verification": "npx vitest run src/auth — 12 passed",
      "residualRisk": "...",
      "verified": { "survived": true, "refutedCount": 0, "jurors": 3, "note": null },
      "error": null
    }
  ],
  "landed": [{ "id": "P03", "phase": "03", "branch": "codex-peer/<peerId>", "summary": "..." }],
  "tokensSpent": 812345
}
```

- `slices[]` is in plan order (not completion order).
- `landed` (per slice) is true only when the leaf reported `done` **and** committed at least one file — delamain skips the push when nothing is ahead of `origin/<mergeBranch>`, so a no-change "done" has no branch and is downgraded to `blocked`.
- `verified.jurors: 0` (no juror voted) is reported as `survived: false` with a `note`; it is never treated as approval.
- Top-level `landed[]` = slices that landed and were not refuted. It is exactly what the finalize stage expects in `args.landed`, and the only slices Step 7 should open PRs for.

## Validation rules enforced by the workflow (it throws before spawning anything)

- `slices` non-empty; every slice has non-empty `id`, `title`, `prompt`.
- Ids unique.
- `dependsOn` references an existing slice, has at most one entry, and forms no cycle.
- `name` and `mergeBranch` present.
