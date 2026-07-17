# SP2 — Pi Engine (piRunner + piEvents + `PeerEngine += "pi"`) — Plan

## Context

delamain drives headless coding peers through a single **engine abstraction**: `PeerEngine = "codex" | "cursor"` (`src/types.ts:40`), threaded through the `PeerRecord` and dispatched at exactly **one runtime fork** (`src/runner.ts:40`, `if engine==="cursor"`). Cursor was the 2nd engine; **Pi is the 3rd** — the design doc and `docs/research/2026-07-16-delamain-extension-map.md §1` mark it as "you are now the 3rd engine," and SP1 wave 4 already **reserved the slot**: `WorkflowAgentOpts.engine` accepts `"pi"` but `ctx.agent` rejects it today with an "arrives in SP2" message (`src/workflow/ctx.ts`).

**Why now / outcome:** Pi (`@mariozechner/pi-coding-agent`, installed as `pi` v0.73.1) adds a third provider-diverse engine. Its immediate payoff is unblocking **engine-diverse `ctx.verify()` jurors** (SP1 wave 5 shipped `ctx.verify`, but all jurors are codex until a second engine is usable inside workflows) and giving `spawn_peer`/workflows a Pi option. Pi's structural template is **cursor** — this is a clone-and-adapt, not a new architecture: **1 enum value + 1 dispatch branch + ~6 option-plumbing edits + 2 new files.** No changes to the frozen watchdog, `killPeer`, `integrate_peer`, dashboard, or wait machinery (they all key off `enginePid`/`threadId`/`status`/`finalResult`).

**Scope:** Pi as a **leaf engine in print mode** (`pi --print --mode json`), mirroring `cursorRunner`. Pi-as-top-level-RPC-driver (`--mode rpc`, better for steer/verify loops per the research) is **out of scope** here — a later enhancement.

---

## Verified current seams (what to touch)

- **Type:** `PeerEngine = "codex" | "cursor"` — `src/types.ts:40`. `normalizePeerRecord` defaults a missing engine to `"codex"` (`types.ts`), so on-disk migration is a no-op. `PeerRecord.enginePid?` (`:78`), `engine?` (`:79`), `threadId?` (`:88`).
- **Dispatch fork (the seam):** `src/runner.ts:40` — `if (args.engine === "cursor") { await runCursorPeer({...}); return; }` then the codex fall-through. `parseArgs` maps `--engine` raw → union (`runner.ts:415`); `RunnerArgs.engine?: "codex"|"cursor"` (`:24`).
- **Spawn defaulting:** `src/peerManager.ts:109` (`engine: options.engine || "codex"`), `:110` (`cursorOptions` gated on `engine==="cursor"`).
- **argv builder (unit-tested):** `buildRunnerArgv` — `src/peerManager.ts`; `--engine` push (`:531`), cursor-only flags block (`:533`). Add a pi block here.
- **Resume:** `resumePeer` re-spawns with `resumeThread: peer.threadId` (`src/peerManager.ts:232`). **Codex resumes by thread id; Pi resumes by SESSION FILE PATH/id** (`pi --session <path|id>` / `--continue`) — the load-bearing difference (see Resume below).
- **killPeer:** already kills `codexPid` + `enginePid` + `runnerPid` (`peerManager.ts:374-375`) — pi sets `enginePid`, so kill/frozen-watchdog cover it for free.
- **MCP boundary:** engine enums `["codex","cursor"]` at two sites (`src/mcpServer.ts:96`, `:273`); `engineValue()` (`:872`, accepts only cursor|codex); `cursorOptionsValue()` (`:878`); the codex-only-knobs guard `codexTuningOptions`.
- **CLI:** engine cast + help text in `src/cli.ts`.
- **Event contract:** all runners normalize to `ParsedCodexEvent` (`src/codexEvents.ts:20`: `{type,itemType,isAgentMessage,threadId,text,label,waitingQuestion}`); `parseWaitingQuestion`/`trim` are reused by `cursorEvents.ts`. `lifecycle.ts` (`updateTerminalResponseState`) and the waiting/resume protocol work off this shape unchanged.

## Pi CLI contract (verified against installed pi 0.73.1)

`pi --print --mode json --model <provider/id[:thinking]> [--tools read,bash,edit,write] [--session <path|id> | --no-session] [--session-dir <dir>] "<wrapped prompt>"`
- **Prompt is a positional arg** (print mode reads the initial message, NOT stdin — unlike codex which pipes to stdin). Pass the wrapped prompt as the last argv element.
- **Resume:** `--session <path|id>` / `--continue` / `--resume`; session storage under `--session-dir` (default `PI_CODING_AGENT_DIR` ≈ `~/.pi/agent`). Provider prefix via `--model provider/id` or `--provider`.
- **RISK — re-verify the NDJSON event schema first.** The research doc pinned pi **0.57.1**; installed is **0.73.1**. The flags above are confirmed present, but the JSON event shapes below are from 0.57.1 and must be re-checked against 0.73.1 (`pi --print --mode json ...` with a live key) as **implementation step 0** before writing `piEvents.ts`.

---

## Build (exactly this)

### 1. `src/types.ts` — add the engine
- `PeerEngine = "codex" | "cursor" | "pi"`. `normalizePeerRecord` unchanged. Add an optional `PiRunOptions` type (`tools?: string[]`, `thinking?: string`, `provider?: string`, `sessionDir?: string`) and `PeerRecord.piOptions?` / `SpawnPeerOptions.piOptions?`, mirroring `cursorOptions`.

### 2. `src/piEvents.ts` — `parsePiJsonLine(line): ParsedCodexEvent` (clone of `cursorEvents.ts`)
Map pi NDJSON → the shared `ParsedCodexEvent` so `lifecycle.ts`/dashboard/waiting-protocol work unchanged. Per the research (re-verify vs 0.73.1):
- First line `{"type":"session","id":"<uuid>",...}` → **`threadId = .id`** as a **special case** (do NOT add generic `id` to `THREAD_ID_KEYS` in `codexEvents.ts` — too broad).
- `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"…"}}` → accumulate `.delta` into text.
- `{"type":"message_end","message":{role:"assistant",content:[{type:"text",text}]}}` → final assistant text; run through `parseWaitingQuestion` (reuse) so `CODEX_PEERS_STATUS: WAITING` / `QUESTION:` still drives `status:"waiting"`.
- `{"type":"agent_end"}` → turn/agent terminal marker.
- `{"type":"tool_execution_start|end","toolName","args","isError"}` → `label` for the log.
Reuse `trim`, `parseWaitingQuestion`; keep the `collectText`/`findThreadId` walker shape from `cursorEvents.ts`.

### 3. `src/piRunner.ts` — `runPiPeer(args)` (clone of `cursorRunner.ts`, ~300 lines)
Same skeleton: `buildPiArgs`, detached `spawn`, set `enginePid = child.pid`, 5s heartbeat, line-buffered stdout → `parsePiJsonLine` → `updatePeer`, close → terminal status + branch push. Differences from cursor:
- **Invocation** per the contract above; prompt positional; reuse a `wrapPiPrompt` copy of `wrapCursorPrompt` (same operational contract incl. the `CODEX_PEERS_STATUS: WAITING` sentinel).
- **Auth preflight (NOT `checkCodexPeerAuth`):** Pi uses provider API-key envs (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`) or pi `/login` OAuth — there is **no CODEX_HOME-style per-peer isolation**. Add a `checkPiAuth(provider)` that fails fast with a clear relogin/key hint when the target provider's key is absent (verified: with all keys unset, `pi --print --mode json` errors `No API key found`). Pi's default provider is `google`; **always pass `--model <provider>/<id>` explicitly.**
- **`integrate:false`** must hold exactly as codex/cursor: skip the branch push on done when the record's `integrate === false` (workflow leaves). Mirror the wave-1 runner change.
- **Session/resume:** capture the session `id` from the first NDJSON line → store as `threadId` **and** compute the deterministic session file path under a stable `--session-dir` (per-peer, e.g. under `peersHome()/pi-sessions/<peerId>`), so resume can pass `--session <path|id>`.

### 4. `src/runner.ts` — dispatch + parse
- Add `if (args.engine === "pi") { await runPiPeer({...}); return; }` at the fork (`runner.ts:40`), before the codex fall-through.
- `parseArgs`: widen the engine union to include `"pi"` (`:415`); parse pi flags (`--pi-tools`, `--pi-thinking`, `--pi-provider`, `--pi-session-dir`). For pi, `--resume-thread` carries the session path/id → pass as `--session`.
- `RunnerArgs.engine?: "codex"|"cursor"|"pi"` + pi fields.

### 5. `src/peerManager.ts` — plumbing
- `buildRunnerArgv`: add a `if (args.engine === "pi")` block pushing `--pi-*` flags (mirror the cursor block at `:533`); `piOptions` gated like `cursorOptions`.
- `spawnPeer` defaulting (`:109-110`): thread `piOptions` when `engine==="pi"`.
- `resumePeer` (`:232`): unchanged in shape — `resumeThread: peer.threadId` already carries the pi session id/path; the runner translates it to `--session`.
- No change to `killPeer`/`reconciledPeer` (enginePid-based; pi sets it).

### 6. `src/mcpServer.ts` — boundary
- Add `"pi"` to the two engine enums (`:96`, `:273`); `engineValue()` accepts `"pi"` (`:872`).
- Add a `pi_options` input shape + `piOptionsValue()` (mirror `cursorOptionsValue` `:878`): `tools`, `thinking`, `provider`, `session_dir`.
- Extend the codex-only-knobs guard so `reasoning_effort`/`developer_instructions`/`codex_config` are rejected with `engine="pi"` (they're codex-only), same as the cursor guard.

### 7. `src/cli.ts` — surface
- Accept `pi` in the engine cast; add `--pi-tools/--pi-thinking/--pi-provider/--pi-session-dir`; update help text and the engine list.

### 8. Workflow payoff — flip the wave-4 reservation
- `src/workflow/ctx.ts` `runAgentCall`: **stop rejecting `engine:"pi"`**; forward `engine:"pi"` + `piOptions` to `spawnPeer` (the wave-4 commit already forwards `cursorOptions`; add the `piOptions` analog). Widen `WorkflowAgentOpts` with `piOptions?`.
- This makes `ctx.verify({ jurors: [...], engines: ["codex","pi"] })` genuinely engine-diverse. Add/enable a diverse-juror path in `sandbox-child.ts`'s `ctx.verify` if it currently hard-codes codex.

---

## Resume nuance (the one real design point)

Codex resume = thread id (`codex exec resume --json <threadId>`). **Pi resume = session file path/id** (`pi --session <path|id>`). Reuse the existing `threadId` field as the opaque resume handle (no schema change), but:
- `piRunner` must set `threadId` to the pi session **id** captured from the first NDJSON `session` line, and run with a **stable `--session-dir`** so the id resolves back to a file on resume.
- `buildRunnerArgv`/`runner.ts` translate `resumeThread` → `--session <id>` for pi (vs `--resume-thread`→codex `exec resume` / cursor `--resume=`).
- This keeps `resumePeer`, `send_peer_reply`, the inbox turn-boundary delivery, and workflow schema-retry (`resumePeer` on mismatch) working unchanged for pi leaves.

## Tests (TDD, mirror existing patterns)

- **`tests/piEvents.test.mjs`** (pure, like `cursorEvents.test.mjs`): `parsePiJsonLine` over the 5 NDJSON shapes; `threadId` from `session.id`; `parseWaitingQuestion` detection on `message_end`; tool-execution labels. Pin fixtures to **0.73.1** output captured in step 0.
- **`tests/piRunner.test.mjs`** (fake `pi` shim binary, like `gsdRunner.test.mjs`'s fake-codex): NDJSON in → `starting→working→done` transitions; `done` pushes a branch **unless** `integrate:false`; `waiting` on the sentinel; auth-preflight failure path.
- **`tests/runner.test.mjs`** additions: `buildRunnerArgv({engine:"pi", piOptions, resumeThread})` → `parseArgs` round-trip recovers pi flags and maps `--resume-thread`→`--session`.
- **MCP/vitest**: `spawn_peer engine="pi"` validation; codex-only-knob guard rejects `reasoning_effort` + `pi`; `piOptionsValue` parsing.
- **Workflow (`src/workflow/ctx.test.ts`)**: `ctx.agent({engine:"pi"})` now spawns a pi leaf (fake) and forwards `piOptions` (replaces the current "rejects pi with SP2 message" test).

## Verification (end-to-end)

- **Unit/integration**: `npm run build && npx vitest run` + `node --test tests/pi*.test.mjs tests/runner.test.mjs` green; keep the 10 pre-existing git-shim baseline failures filtered.
- **Live smoke (needs a provider key — currently NONE set):** export `ANTHROPIC_API_KEY` (or OpenAI/Gemini), then `delamain spawn --engine pi --model anthropic/claude-... --repo <r> --prompt <t>` → observe `working→done`, branch pushed; then `delamain resume <id> --prompt <follow-up>` to prove session-path resume. Finally an **engine-diverse `verify()` workflow** (codex + pi jurors) via `run-workflow`. The research flags pi OAuth as expired → a live env key is required; call this out to the operator.

## Risks

1. **NDJSON schema drift 0.57.1→0.73.1** — the top risk; step 0 re-verifies before `piEvents.ts`. Pin fake-shim fixtures to the installed version.
2. **Pi auth** — no per-peer isolation like CODEX_HOME; live provider key required for any real run. `checkPiAuth` must fail loudly, not silently spawn a peer that dies with `No API key found`.
3. **Resume-by-session-path** — the one behavioral divergence from codex/cursor; needs the stable `--session-dir` + id-capture wiring and a resume test.
4. **Model id surface** — pi model ids differ from cursor/codex; unlike cursor's alias map, keep pi pass-through and require explicit `provider/id` (default provider `google` is usually wrong).

## Out of scope

- Pi as a **top-level RPC driver** (`--mode rpc`, steer/follow_up/abort) — stronger for interactive verify→steer loops per the research, but a separate enhancement after the leaf engine lands.
- SP3 (T3 bridge) / SP4 (standalone Pi extension) — consume SP1's event stream; separate specs.
