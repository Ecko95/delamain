# Peer Handoff: Swap runner backend from `codex exec --json` to `gsd-sdk auto`

**Date:** 2026-05-09
**Orchestrator:** Ecko95 (devOS)
**Target repo:** `/home/userduffill/dev/codex-mcp-peers-server`
**Worktree start ref:** `origin/main`
**Merge branch:** `main`
**Suggested branch name:** `feat/gsd-sdk-runner`
**Suggested worktree path:** `../codex-mcp-peers-server-gsd-sdk` (sibling to repo)

> **Why this handoff exists:** the orchestrator is actively using the current
> `codex exec --json` runner. This work must happen in an isolated linked
> worktree off `origin/main` and only merge back when the new runner has been
> end-to-end verified against a real repo. The orchestrator will integrate the
> branch manually — **the peer must NOT push, merge, or rebase onto `main`.**

---

## Goal

Replace the peer process backend so peers run the canonical GSD state machine
via `gsd-sdk auto` instead of free-form `codex exec --json`. Today's runner
hands the peer a prompt and trusts it to behave; the new runner delegates the
discuss → plan → execute → advance loop to `gsd-sdk`, which already exists as a
headless binary.

The MCP tool surface (`spawn_peer`, `wait_for_peer`, `peer_status`,
`read_peer_log`, etc.) **stays identical**. The orchestrator's UX and dashboard
should be unchanged from the outside; internals swap.

## Context: what's where

- Runner entry point: `src/runner.ts` — spawns `codex` with `exec --json` and
  parses each stdout line as a Codex JSON event.
- Codex event parser: `src/codexEvents.ts` — parses `agent_message`, thread IDs,
  `CODEX_PEERS_STATUS: WAITING` sentinel.
- Lifecycle / waiting reconciliation: `src/lifecycle.ts` — derives terminal
  response state from the parsed event stream.
- Spawning the runner: `src/peerManager.ts` (`spawnPeer`, `resumePeer`) calls
  `spawnRunner({...})` which fires `node dist/index.js run-peer ...` (see
  `src/cli.ts` for the `run-peer` subcommand wiring).
- Public types: `src/types.ts` (`PeerStatus`, `PeerRecord`, `SpawnPeerOptions`,
  etc.). `threadId` and `codexPid` fields are Codex-specific and become dead.
- README + skill doc reference `codex exec` and `--json`; both need editing.

## `gsd-sdk` reference

Installed globally as the `gsd-sdk` binary (resolves to
`get-shit-done-cc/bin/gsd-sdk.js`). Verify with `which gsd-sdk` and
`gsd-sdk --version`.

```
Usage: gsd-sdk <command> [args] [options]

Commands:
  auto                  Run the full autonomous lifecycle (discover -> execute -> advance)
  init [input]          Bootstrap a new project from a PRD or description
  run <prompt>          Run a full milestone from a text prompt
  query <argv...>       Registered query handlers

Options:
  --init <input>        Bootstrap from a PRD before running (auto only)
                        Accepts @path/to/prd.md or "description text"
  --project-dir <dir>   Project directory (default: cwd)
  --ws <name>           Route .planning/ to .planning/workstreams/<name>/
  --ws-port <port>      WebSocket transport on <port>
  --model <model>       Override LLM model
  --max-budget <n>      Max budget per step in USD
```

Authoritative state lives at:
- `<repo>/.planning/STATE.md` — YAML frontmatter with `status`, `stopped_at`,
  `last_updated`, `progress`, plus markdown body with `Current Position`,
  `Session Continuity`. Always written atomically by gsd-sdk.
- `<repo>/.planning/HANDOFF.json` — JSON snapshot with `status`, `phase`,
  `phase_name`, `next_action`, `human_actions_pending`, `blockers`. Written at
  session pause / handoff points.

The SDK does **not** emit a JSON event stream on stdout. Status comes from
polling these two files (and from process exit code).

## Operational contract

- Work only on this task. If scope feels unclear, write a `QUESTION:` to the
  handoff log (`.codex/peer-handoffs/20260509-1726-gsd-sdk-runner-swap.md`,
  append at the bottom under a `## Questions` section) and stop.
- You are running in an isolated linked worktree off `origin/main`. Do NOT
  push, do NOT merge into `main`, do NOT rebase. Commit on the local branch only.
- The orchestrator integrates the branch by reviewing the diff manually. Keep
  commits small and well-named.
- Keep changes minimal. Do not refactor unrelated modules. Do not bump
  unrelated dependencies.
- `npm run build` and `npm test` (which runs `node --test tests/*.test.mjs`)
  must pass. `npm run check` (tsc noEmit) must be clean.

## Implementation plan

### 1. Replace the runner spawn target (`src/runner.ts`)

Remove:
- `import { parseCodexJsonLine, trim } from "./codexEvents.js";` (keep `trim`
  by re-locating it — see step 3).
- `import { initialTerminalResponseState, updateTerminalResponseState } from "./lifecycle.js";`
- All `child.stdout` JSON line parsing and `terminalResponse` tracking.
- `wrapPrompt(...)` body that hand-writes the Codex peer contract.
- `buildCodexArgs(...)`.
- The `CODEX_PEERS_STATUS: WAITING` sentinel parsing path.

Add:
- `buildGsdArgs(args)` that returns:
  - `["auto", "--project-dir", args.repo]`
  - + `["--model", args.model]` when set
  - + `["--max-budget", String(args.maxBudget)]` when set (new optional arg)
  - + `["--ws-port", String(args.wsPort)]` when set (new optional arg, used by
    dashboard streaming if/when we wire it)
  - + `["--init", "@" + args.promptFile]` **only when this is a fresh run**
    (i.e. `<args.repo>/.planning/STATE.md` does NOT exist). On resume, omit
    `--init` — `gsd-sdk auto` reads STATE.md and continues.
- Spawn `gsd-sdk` (not `codex`):
  ```ts
  const child = spawn("gsd-sdk", buildGsdArgs(args), {
    cwd: args.repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  ```
  No stdin; the prompt is consumed via `--init @file`.
- Replace JSON-event-driven `lastEvent` updates with a periodic
  STATE.md/HANDOFF.json poller. Reuse the existing 5s `heartbeat` interval — on
  each tick, attempt to read `<args.repo>/.planning/STATE.md` and
  `<args.repo>/.planning/HANDOFF.json` and translate into `lastEvent` /
  `status` / `question`. See **State translation table** below.
- Forward stdout + stderr verbatim into the existing log file (`append(log,
  ...)`). Keep `[stderr] ` prefix on stderr lines.
- On `child.on("close", (code) => ...)`:
  - If `code === 0`: read final STATE.md/HANDOFF.json one more time. If
    HANDOFF.json `status === "paused"` AND has any `human_actions_pending`,
    set status to `"waiting"` and put the first pending action into
    `peer.question`. Otherwise set `"done"` and run the existing
    `integratePeerWorktree(...)` path.
  - If `code !== 0`: `"failed"`, populate `peer.error` from the last stderr
    line.

### 2. State translation table (poller in runner)

```
HANDOFF.json status   STATE.md status     →  PeerRecord.status     PeerRecord.lastEvent source
"in_progress"         "executing"             "working"            STATE.md `stopped_at` || `Current Position`
"paused"              "planning"|"executing"  "waiting" if `human_actions_pending` non-empty, else "working"
                                              (question = first pending action)
"complete"            "complete"              "done" (only on process exit)
(file missing)        (any/missing)           preserve current status; lastEvent = "awaiting first STATE.md"
```

Implementation note: the poller should **not** transition into `"done"` from
file state alone — only the process exit handler may set `"done"` /
`"failed"`. The poller updates `working` / `waiting` / `lastEvent` /
`question` only.

Use `safeRead(path)` that swallows ENOENT and returns `undefined`. Parse
STATE.md frontmatter with a small inline reader (split on first
`---\n.*\n---\n`); do not pull in a YAML library.

### 3. Cull / relocate Codex-specific code

- **Delete** `src/codexEvents.ts`. Move the small `trim(text, max)` helper
  (lines 151-157) into a new `src/util/text.ts` and re-export from there. Any
  call site that imported `trim` from `./codexEvents.js` updates accordingly
  (grep — there are likely callers in `mcpServer.ts`, `peerManager.ts`,
  `dashboard/*`).
- **Delete** `src/lifecycle.ts` and replace it with `src/gsdState.ts` exporting:
  - `readGsdState(repo: string): { state?: ParsedState; handoff?: ParsedHandoff }`
  - `reconcileFinishedWaitingPeer(peer)` reimplemented against HANDOFF.json
    (mirrors current behaviour: a peer left in `waiting` after process exit
    code 0 should reconcile to `"done"` if HANDOFF.json shows no pending human
    actions).
- Update imports across `peerManager.ts`, `runner.ts`, and tests.

### 4. Type cleanup (`src/types.ts`)

- Remove `codexPid` from `PeerRecord` (no longer meaningful).
- Remove `threadId` from `PeerRecord` and `PeerStatus`-adjacent code. Resume
  is now stateless — `gsd-sdk auto` resumes from STATE.md, not from a thread
  ID.
- Remove `resumeThread` from `RunnerArgs` and `ResumePeerOptions`.
- Keep `sandbox` and `yolo` fields **off** the new runner — gsd-sdk does not
  forward them. Add a `// deprecated, no-op under gsd-sdk runner` comment;
  removing them is a breaking change to the MCP tool surface so leave the
  field accepted-and-ignored for one release.
- Add optional `maxBudget?: number` and `wsPort?: number` to
  `SpawnPeerOptions` and thread them through `peerManager.spawnRunner` →
  `runner.parseArgs` → `buildGsdArgs`.

### 5. `peerManager.ts` adjustments

- `resumePeer(...)`: remove the "no known thread id" guard. Resume now means
  re-spawning `gsd-sdk auto` against the same worktree; the SDK reads the
  worktree's STATE.md to continue. The `prompt` arg becomes optional — when
  provided, it's appended to STATE.md notes via a small helper, OR ignored
  for now (preferred: ignored, with a TODO comment pointing here, since
  `gsd-sdk` doesn't have a public "inject orchestrator note" API yet).
- Remove `codexPid` writes throughout.

### 6. CLI subcommand (`src/cli.ts`)

- The `run-peer` subcommand keeps the same flag surface but drops
  `--resume-thread`, `--sandbox`, `--yolo` from the help text. (Leaving them
  parsed-and-ignored for one release is fine.)
- Add `--max-budget` and `--ws-port` to the help text.

### 7. MCP tool schemas (`src/mcpServer.ts`)

- Mirror the `SpawnPeerOptions` change: drop `sandbox`/`yolo` from the input
  schemas (or mark deprecated); add `maxBudget` and `wsPort`.
- No tool names change.

### 8. Tests

- `tests/lifecycle.test.mjs`: rewrite as `tests/gsdState.test.mjs`. Cover:
  - STATE.md `status: complete` + HANDOFF.json `status: complete` → poller
    leaves status alone (terminal handler decides).
  - HANDOFF.json `status: paused` + `human_actions_pending: ["foo"]` →
    poller sets `waiting` + `question: "foo"`.
  - Missing `.planning/` → poller is a no-op.
  - `reconcileFinishedWaitingPeer`: `waiting` peer with exit 0 and empty
    pending list → reconciled to `done`.
- `tests/dashboard.test.mjs`, `tests/git.test.mjs`: no functional change
  expected, but update fixtures if they reference `threadId` or `codexPid`.
- Add one new integration test: invoke `runPeer` against a temp repo with a
  fake `gsd-sdk` shim (a `bin/gsd-sdk-fake.sh` that writes a STATE.md +
  HANDOFF.json + exits 0). Use `PATH=...:$PATH` to make the shim resolve as
  `gsd-sdk`.

### 9. Documentation

- `README.md`:
  - Rewrite the Install section to remove the `codex mcp add` line that ties
    us to Codex specifically (the MCP server still registers under Codex; the
    *runner* just changed). Update prose: peers now run `gsd-sdk auto`, not
    `codex exec`.
  - Remove the `CODEX_PEERS_STATUS: WAITING` sentinel section. Replace with
    "peers signal `waiting` via HANDOFF.json `human_actions_pending`."
  - Update `Dashboard status notes` if any string changes.
- `.codex/skills/codex-peers-worktree-routing/SKILL.md` is currently dirty on
  the orchestrator's `main` branch — **do not touch it** in this worktree.
  The orchestrator will reconcile their working tree separately.

## Out of scope

- Changing the MCP tool names or removing tools.
- Adding a "select runner" knob (codex vs gsd-sdk). One release = one
  backend; the swap is total.
- Wiring `--ws-port` into the dashboard. Plumb the option through; dashboard
  consumption is a follow-up.
- Updating the orchestrator (devOS) side. Different repo.
- Touching the dirty files on the orchestrator's `main` working tree.

## Acceptance criteria

1. `npm install && npm run build && npm run check && npm test` all pass on
   the new branch.
2. `node dist/index.js run-peer --peer-id test --repo /tmp/sample-repo
   --prompt-file /tmp/p.md --log-path /tmp/p.log` runs `gsd-sdk auto`
   visibly (`pgrep -af gsd-sdk` finds the child) and writes STATE.md /
   HANDOFF.json under `/tmp/sample-repo/.planning/`.
3. `peer_status` MCP tool returns `status: "working"` while gsd-sdk is mid-
   loop; transitions to `"waiting"` when HANDOFF.json reports
   `human_actions_pending`; transitions to `"done"` only on clean exit;
   `"failed"` on non-zero exit.
4. `read_peer_log` shows raw gsd-sdk stdout interleaved with `[stderr]` lines
   and `[codex-peers]` framing lines (the framing prefix can stay — it
   remains accurate as the supervisor's own log voice).
5. After a clean run, `integratePeerWorktree` still merges the peer's
   commits onto `origin/main` exactly as before.
6. Codebase has no remaining import of `./codexEvents.js` or `./lifecycle.js`.
7. README no longer instructs the user to run `codex exec`.

## Verification recipe

Run from inside the worktree after build:

```bash
# 1. Create a throwaway repo
TMPREPO=$(mktemp -d)
git -C "$TMPREPO" init -q
git -C "$TMPREPO" commit -q --allow-empty -m "init"
git -C "$TMPREPO" branch -M main
git -C "$TMPREPO" remote add origin "$TMPREPO"  # self-origin for preflight

# 2. Drop a small PRD as the prompt
cat >/tmp/peer-prompt.md <<'EOF'
Build a one-file CLI that prints "hello, peer" when invoked.
Single phase, single plan.
EOF

# 3. Spawn via the rebuilt MCP server
node dist/index.js run-peer \
  --peer-id smoke01 \
  --repo "$TMPREPO" \
  --prompt-file /tmp/peer-prompt.md \
  --log-path /tmp/smoke01.log

# 4. In another terminal: tail the log + watch state
watch -n 2 'echo "--- STATE ---"; cat "$TMPREPO/.planning/STATE.md" 2>/dev/null | head -20; \
            echo "--- HANDOFF ---"; cat "$TMPREPO/.planning/HANDOFF.json" 2>/dev/null'
```

Expect: `gsd-sdk` runs, populates `.planning/`, eventually exits with
HANDOFF.json `status: complete` and `phase` populated.

## Risks / things to flag back to orchestrator

- If `gsd-sdk auto` insists on a model that requires API keys not present in
  the worktree environment, the runner will fail on first spawn. Surface the
  stderr clearly. Do NOT bake an API key into the runner.
- `--init @file` semantics on a repo that already has `.planning/` are
  unverified at handoff time. The plan above gates `--init` on STATE.md
  absence — verify this matches gsd-sdk's actual behaviour and adjust if not.
- gsd-sdk's exit code on "completed milestone" vs "paused waiting human" may
  both be 0. The terminal handler must rely on HANDOFF.json contents, not
  exit code, to distinguish `done` from `waiting`.

## Questions

(append below if you need orchestrator input before proceeding)
