# config.json schema

Roadmap-level configuration. Lives at `<state-dir>/config.json`. Read at the top of every supervisor tick; not cached. Edit and the next tick picks up changes.

```json
{
  "repo_path": "/abs/path/to/repo",
  "default_branch": "main",
  "merge_strategy": "rebase",
  "delete_branch_on_merge": true,
  "pr_title_prefix": "chore",
  "peer_name_prefix": "autopilot",
  "path_prefix": ["/.../node/bin", "/usr/local/bin", "/usr/bin"],
  "forbidden_paths": ["src/preserved/", "src/critical.ts"],
  "forbidden_exception_slices": ["H0.4"],
  "verification_commands": [
    {"label": "npm run lint", "cmd": ["npm", "run", "lint"]},
    {"label": "tsc --noEmit", "cmd": ["npx", "tsc", "--noEmit"]},
    {"label": "npm test -- --run", "cmd": ["npm", "test", "--", "--run"]},
    {"label": "npm run build", "cmd": ["npm", "run", "build"], "timeout_seconds": 900}
  ]
}
```

## Required fields

| Field | Notes |
|---|---|
| `repo_path` | Absolute path. Must be a git repo with `origin`. |
| `default_branch` | Default origin branch. Usually `main`. The supervisor fetches `origin/<default_branch>` to detect merges and bases new feature branches off it. |
| `verification_commands` | At least one command. Each entry is `{label, cmd, timeout_seconds?}`. All run sequentially in the peer's worktree. Must all exit 0 or the chain halts. |

## Optional fields with defaults

| Field | Default | Notes |
|---|---|---|
| `merge_strategy` | `"rebase"` | `gh pr merge --<strategy>`. Valid: `rebase`, `squash`, `merge`. |
| `delete_branch_on_merge` | `true` | Adds `--delete-branch` to `gh pr merge`. |
| `pr_title_prefix` | `"chore"` | PR title becomes `<prefix>(<slice_id_lower>): <slice_id>`. |
| `peer_name_prefix` | `"peer"` | Peer name becomes `<prefix>-<slice_id_lower>`. |
| `path_prefix` | `[]` | Prepended to `PATH` so cron can find `node`, `codex-peers`, `gh`, `npm`, `git`. Most setups need at least the nvm-managed node bin dir. |
| `forbidden_paths` | `[]` | File paths or directory prefixes (trailing `/`). If a peer's diff (against `origin/<default_branch>`) modifies any, halt. |
| `forbidden_exception_slices` | `[]` | Slice IDs explicitly allowed to touch `forbidden_paths` (e.g. one slice's job is migrating those files). |

## Forbidden-path matching

A diff entry `f` matches a forbidden entry `p` if either:
- `f == p` (exact file match), or
- `f.startswith(p)` (directory prefix; ensure `p` ends with `/`).

If `current_slice_id` is in `forbidden_exception_slices`, the check is skipped for that slice.

## verification_commands semantics

Run sequentially in the peer's `worktreePath` after the diff check passes. Each command:
- Runs with the peer's `node_modules` (peer ran `npm install` already).
- Captures stdout+stderr; on non-zero exit, the last 1500 chars are sent to Telegram.
- If multiple fail, the first failure is the one whose tail is sent; all are listed by label.

Set realistic `timeout_seconds` for slow builds (default 600). The auto-review step is still bounded by your max sane single-tick budget — keep total under ~4 minutes so successive cron ticks don't pile up against the lock.

## When to add to forbidden_paths

Add an entry when:
- A file holds a contract a peer should never silently change (API client internals, generated code, test fixtures, spec files).
- A directory contains preserved sections the redesign explicitly mustn't break.
- A config file (CI, deploy) where peer edits would have outsized blast radius.

Do **not** add entries to substitute for the peer prompt. Keep the prompt strict; the forbidden list is a backstop, not the primary gate.
