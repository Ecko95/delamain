I have everything I need. All findings below are VERIFIED by local inspection (ran the CLIs, read the source) unless explicitly tagged `[recall]`.

---

# delamain architecture map + extension points for (a) a Pi engine and (b) a code-defined workflow layer

Scope verified locally: all of `src/*.ts` listed in the task, `tests/spawnGsdPhaseBatch.test.mjs`, `tests/gsdRunner.test.mjs`, `docs/IMPLEMENTATION-PLAN.md`, and the installed CLIs (`codex-cli 0.144.5`, `cursor-agent`, `pi 0.57.1` = `@mariozechner/pi-coding-agent@0.57.1`, `gsd`, `gsd-sdk`). Pi is already installed and its `--mode json` / `--mode rpc` / SDK contracts were read from the package's bundled docs.

---

## 1. The ENGINE abstraction — where `codex` vs `cursor` is branched, and the seam for `pi`

There is **no plugin registry**. Engine is a string union threaded through the record and dispatched at exactly **one runtime fork** plus a few option-plumbing sites. This matches `docs/IMPLEMENTATION-PLAN.md:85` ("Defer — `engine: codex | cursor` enum is enough until we have a 3rd engine") — you are now the 3rd engine.

### The type
- `src/types.ts:24` — `export type PeerEngine = "codex" | "cursor";` ← **add `"pi"` here.**
- `src/types.ts:102-104` — `normalizePeerRecord` defaults missing `engine` to `"codex"` (on-disk migration).
- `PeerRecord.engine?` at `src/types.ts:63`; `PeerRecord.enginePid?` at `src/types.ts:62` (cursor/pi use this; codex uses `codexPid`).

### The single dispatch fork (the real seam)
- `src/runner.ts:31-48` — `runPeer(argv)` is the child-process entrypoint (`index.ts:24` routes `run-peer` → `runPeer`). At `src/runner.ts:34`:
  ```
  if (args.engine === "cursor") { await runCursorPeer({...}); return; }
  ```
  Everything after line 48 is the inline **codex** path (no `runCodexPeer` function — codex is the fall-through default). **Add `if (args.engine === "pi") { await runPiPeer({...}); return; }` right here.**

### Option plumbing that also branches on engine (must be touched for `pi`)
- **Spawn defaulting:** `src/peerManager.ts:66-67` (`engine: options.engine || "codex"`, `cursorOptions` gated on `engine === "cursor"`), and `:75` log line.
- **argv builder (unit-tested seam):** `src/peerManager.ts:386-435` `buildRunnerArgv` — serializes options → `run-peer` flags; `:415` pushes `--engine`, `:418-422` pushes cursor-only flags. Add a `pi` block here (e.g. `--pi-tools`, `--pi-thinking`, `--pi-provider`).
- **argv parser (child side):** `src/runner.ts:332-386` `parseArgs` — `:365-367` maps `--engine` raw → union. Add `pi` case and parse any pi flags.
- **MCP boundary:** `src/mcpServer.ts:628-632` `engineValue()` (accepts only `cursor|codex`), the two `engine` enum schema literals (`:63-67` spawn_peer, `:198-202` spawn_peer_and_wait), `cursorOptionsValue` (`:634-646`), and the codex-only-knobs guard `codexTuningOptions` (`:694-707`). Add `pi` to the enum + a `pi_options` shape + guard adjustments.
- **CLI:** `src/cli.ts:23` (`engine` cast), help text `:11,:133-134`.
- **Resume path:** `src/peerManager.ts:162-211` `resumePeer` re-spawns with `resumeThread: peer.threadId` (`:184`). **Key nuance:** codex resumes by *thread id* (`codex exec resume --json <threadId>` at `src/runner.ts:278-280`); **pi resumes by *session file path*** (`pi --continue` / `--resume` / `--session <path>` — verified in `pi --help`). So for pi, `PeerRecord.threadId` must store the **session file path** (or you store the pi session id and keep a stable `--session-dir`). The JSON header line pi emits (`{"type":"session","version":3,"id":"<uuid>",...}`) gives the id; the file path is deterministic under `PI_CODING_AGENT_DIR`/`--session-dir`.

### What a `pi` engine adapter must implement (mirror `cursorRunner.ts`)
The cursor adapter is the exact template. `src/cursorRunner.ts` (311 lines) is a self-contained function `runCursorPeer(args)` that: builds args (`buildCursorArgs` `:71-81`), spawns detached (`:106-111`), sets `enginePid` (`:113-118`), 5s heartbeat (`:120-126`), line-buffers stdout → `parseCursorJsonLine` → `updatePeer` (`:239-265`), and on close pushes the branch via `pushPeerBranch` and sets terminal status (`:174-237`).

**New files to add:**
1. **`src/piRunner.ts`** — `runPiPeer(args)` clone of `cursorRunner.ts`. Invocation (verified from `pi --help` + `docs/json.md`):
   ```
   pi --print --mode json --model <provider/id[:thinking]> [--tools read,bash,edit,write] [--session <path> | --no-session] "<wrapped prompt>"
   ```
   - Prompt is a **positional arg** (print mode reads `initialMessage`/`messages`, NOT stdin — `dist/modes/print-mode.js:63-70`). Unlike codex which pipes the prompt to stdin (`runner.ts:99`). Pass the wrapped prompt as the last argv element (spawn array-escapes it).
   - Set `enginePid = child.pid` so the frozen watchdog + `killPeer` cover it (`killPeer` already kills `enginePid` — `peerManager.ts:264-266`).
   - Reuse `wrapCursorPrompt`-style operational contract (`cursorRunner.ts:268-293`).
2. **`src/piEvents.ts`** — `parsePiJsonLine(line): ParsedCodexEvent` (reuse the shared `ParsedCodexEvent` type from `codexEvents.ts:20-28` so `lifecycle.ts` and the dashboard log formatter work unchanged). Pi's NDJSON schema (verified `docs/json.md`, `docs/rpc.md`):
   - First line `{"type":"session","id":"<uuid>",...}` → **threadId = `.id`** (special-case; do NOT add `id` to the global `THREAD_ID_KEYS` in `codexEvents.ts:1-8` — too generic).
   - `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}` → accumulate `.delta` into text.
   - `{"type":"message_end","message":{role:"assistant",content:[{type:"text",text}]}}` → final assistant text (this is where `CODEX_PEERS_STATUS: WAITING` / `QUESTION:` is detected — reuse `parseWaitingQuestion` from `codexEvents.ts:143-149`, keeps the whole waiting/resume protocol intact).
   - `{"type":"agent_end"}` → turn/agent terminal marker.
   - `{"type":"tool_execution_start|end","toolName","args","isError"}` → labels for the log.

Net: adding pi = **1 enum value + 1 dispatch branch + 2 new files (piRunner, piEvents) + ~6 option-plumbing edits.** No architectural change. The frozen watchdog, killPeer, integrate_peer, dashboard, and resume/wait machinery all work off `enginePid`/`threadId`/`status`/`finalResult` and need no per-engine changes.

---

## 2. Peer lifecycle + state model

### On-disk state (`src/store.ts`, `src/paths.ts`)
- Single JSON file `state.json` under `~/.delamain/` (`paths.ts:39`, legacy `~/.codex-peers/`, envs `DELAMAIN_HOME`/`CODEX_PEERS_HOME`). Shape `PeerState { version:1, updatedAt, peers: PeerRecord[] }` (`types.ts:108-112`).
- **Read-modify-write, whole-file rewrite** on every mutation: `updatePeer` (`store.ts:43-58`) reads all → maps → `writeState` → temp-file + `renameSync` (`store.ts:34-41`). Atomic *rename*, **non-atomic read-modify-write** — a burst of parallel writers (fan-out peers, each a separate detached process) can lose updates. Flagged in `IMPLEMENTATION-PLAN.md:250` (M3: replace with SQLite). **This is the #1 constraint for a high-fan-out workflow engine.**
- `getPeer` accepts id **or id-prefix** (`store.ts:67-69`).

### Status enum (`src/types.ts:1-18`)
Generic: `starting → working → {waiting|done|failed}`, plus `idle`, `frozen`, `killed`. GSD state machine (Phase 33): `gsd_pending → gsd_running_phase → gsd_polling_state → (gsd_running_gate_check) → {gsd_completed | gsd_failed | gsd_halted_on_gate_failure}`. Integration substatus `PeerIntegrationStatus = pending|skipped|pushed|failed` (`types.ts:20`). Peer kind `PeerKind = "generic" | "gsd_phase_batch"` (`types.ts:22`) ← **add `"workflow_run"` here for the new layer.**

### Transition mechanics (who mutates status, when)
- **Generic peer:** the detached runner child mutates status inline as codex/cursor stdout arrives — `runner.ts:239-256` (starting→working, working↔waiting on `waitingQuestion`) and on close `runner.ts:204-222` (→ done/failed/waiting + push). `spawnPeer` sets initial `starting` (`peerManager.ts:64`).
- **Lazy reconciliation on read:** `listPeers`/`peerStatus` run every record through `reconciledPeer` (`peerManager.ts:448-470`). For **active** peers it checks `pidAlive(runnerPid)` + `pidAlive(codexPid)` → if both dead → `frozen` (`:461-462`); if `lastHeartbeatAt` older than `CODEX_PEERS_FROZEN_AFTER_MS` (default **120000 ms**, `:465`) → `frozen`. `reconcileFinishedWaitingPeer` (`lifecycle.ts:39-55`) rewrites a stale `waiting`+`finishedAt`+`exit 0` peer to `done` by replaying its log.
- **Heartbeat:** the runner writes `lastHeartbeatAt` every 5s while alive (`runner.ts:102-108`, `cursorRunner.ts:120-126`).
- **`isActive` = only `starting|working`** (`peerManager.ts:472-474`, and dashboard `model.ts:547`). `waitForPeer` polls until `!isActive` (`peerManager.ts:232`). **Consequence:** any GSD/workflow status is *not* "active", so `wait_for_peer` returns immediately for them — the GSD/workflow layers do their own awaiting (`gsdRunners` map, below).

### GSD-kind peers deviate (important precedent)
- `reconciledPeer` **early-returns** for `kind === "gsd_phase_batch"` (`peerManager.ts:452-454`) — they carry no `runnerPid`/`codexPid`, so the frozen check would false-positive. Test-pinned at `tests/spawnGsdPhaseBatch.test.mjs:153-177`. **A `workflow_run` kind needs the same exemption** (or must emit heartbeats).

---

## 3. `spawnGsdPhaseBatch` as an orchestration foundation — usable, but partial

**Two pieces, cleanly separated (this separation is the reusable pattern):**

**(a) Enqueue — `spawnGsdPhaseBatch` (`peerManager.ts:117-150`):** creates a `kind:"gsd_phase_batch"`, `status:"gsd_pending"` record with a `GsdBatchSpawnConfig { planning_mode, selected_phases[], milestone?, cursor }` (`types.ts:36-41`). **Creates NO worktree, spawns NO process** — pure schema record (test-pinned `spawnGsdPhaseBatch.test.mjs:38-66`). MCP handler (`mcpServer.ts:462-494`) expands phase ranges via `expandSelectedPhases` (`gsdPhaseList.ts:97-120`) then persists.

**(b) Dispatch + run — `dispatchGsdPeer` (`peerManager.ts:295-335`) → `runGsdPhaseBatch` (`gsdRunner.ts:58-248`):** fire-and-forget; a module-level `Map<peerId, Promise>` (`peerManager.ts:293`) dedupes and lets tests await via `_awaitGsdRunner` (`:346-348`). `runGsdPhaseBatch` takes injected deps `{ updatePeer, appendLog }` (`gsdRunner.ts:41-51`) — **fully testable with fakes** (`gsdRunner.test.mjs:51-70` uses in-memory fakes + a fake-codex shim binary).

**The per-phase loop (`gsdRunner.ts:74-236`) is a working code-defined state machine that TERMINATES:**
1. (frozen only) gate-check → on fail, write artifact + `gsd_halted_on_gate_failure` + **short-circuit** (`:81-143`).
2. `gsd_running_phase` → `invokeCodexExec` (`:257-291`): `spawn("codex", ["exec","--cwd",repo,"--json","--disable","hooks",...reasoningEffortArgs,"--","/gsd-autonomous","--only",phaseId])`, streams stdout to log, awaits close.
3. non-zero exit → `gsd_failed` + return (`:182-192`).
4. `gsd_polling_state` → `readStateDocument(repo)` (external state read — `.planning/STATE.md` via `gsdState.ts`).
5. `isPhaseComplete(state, phaseId)` (`gsdState.ts:220-235`, numeric-prefix advance heuristic) → advance `cursor` + loop; else `gsd_failed` "did not advance".
6. cursor exhausts `selected_phases` → `gsd_completed` (`:238-247`).

**Verdict: a usable *template*, not a usable *engine*.** It already gives you: (i) enqueue/dispatch/run split, (ii) injected-deps testability, (iii) status-machine-as-code, (iv) cursor-based resume (`gsdRunner.test.mjs:172-223` proves mid-batch resume without replay), (v) guaranteed termination, (vi) spawn-a-CLI-per-step. **What it lacks for "ultracode workflows":**
- **Sequential, fan-out = 1.** No parallel step execution.
- **No verify/loop/retry** — a phase either advances or hard-fails; no retry budget, no verifier step, no branch-on-result.
- **Runs in `peer.repo` directly** (`invokeCodexExec` cwd = `current.repo`) — **no per-step worktree isolation**, so it cannot safely fan out.
- **No heartbeat during the (long) codex exec** — relies on the frozen-exemption, so a genuinely hung phase is never auto-detected.
- **Codex-hardcoded:** `invokeCodexExec` spawns literal `"codex"` and codex-only `--disable hooks`; no engine parameter.
- **No auth isolation:** unlike the generic runner (which sets `CODEX_HOME` + preflights, `runner.ts:65-83`), `invokeCodexExec` inherits ambient env.

Reuse the **skeleton** (enqueue/dispatch/deps/status-loop/terminate); generalize the **executor** (engine-agnostic, worktree-isolated, add fan-out/verify/loop).

---

## 4. MCP tool surface + where `run_workflow` plugs in

`src/mcpServer.ts` is a **hand-rolled JSON-RPC-over-stdio** server (no SDK dep): `TOOLS` array (`:28-359`) + `handleRequest` (`:384-410`, methods `initialize`/`tools/list`/`tools/call`) + `callTool` switch (`:412-552`) + `StdioJsonRpcTransport` (`:728-810`, supports both line-delimited and `Content-Length` framing). Started from `index.ts:19` (`server` command).

**Current 11 tools:** `spawn_peer`, `list_peers`, `wait_for_peer`, `peer_status`, `read_peer_log`, `send_peer_reply`, `spawn_peer_and_wait`, `kill_peer`, `spawn_gsd_phase_batch`, `inspect_gsd_milestone`, `integrate_peer`, `classify_frozen_batch`.

**To add `run_workflow` (+ `workflow_status`, `list_workflows`, `cancel_workflow`):**
1. Append tool schema objects to `TOOLS` (`mcpServer.ts:28`) — same literal-object style; reference validation constants near top (`REASONING_EFFORTS` etc, `:20-26`).
2. Add `case "run_workflow":` to the `callTool` switch (`mcpServer.ts:414`). Mirror the gsd handler at `:462-494`: validate args, call a new `spawnWorkflowRun(...)` + `dispatchWorkflow(...)` (fire-and-forget like `dispatchGsdPeer`), return `json({ workflow_id, status })`.
3. Import from a new `workflowManager` (or extend `peerManager`).
4. **Register new terminal statuses with `integrate_peer`:** `peerIntegration.ts:59-78` has explicit `REFUSE_STATUSES`/`ACCEPT_STATUSES` sets and **unknown → refuse** (`:80-85`). A `workflow_completed` status must be added to `ACCEPT_STATUSES` or per-unit peers integrated individually.
5. If workflow runs are `PeerRecord kind:"workflow_run"`, they surface in `list_peers` automatically — but add the `reconciledPeer` exemption (`peerManager.ts:452`) and dashboard colors/labels (`dashboard/model.ts:70-106`) as GSD did.

---

## 5. Recommended module layout for the workflow engine

Keep everything on the **Node side** (see §6 Bun split). Model it on the gsd enqueue/dispatch/run trio; call the **existing spawn/wait primitives** as leaf executors rather than re-spawning CLIs directly (that gets you worktree isolation + auto-integration for free).

```
src/workflow/
  types.ts        WorkflowSpec (code-defined), StepSpec, WorkflowRunRecord, WorkflowStatus
  engine.ts       runWorkflow(run, deps) — the DAG driver (analog of runGsdPhaseBatch)
  steps/
    spawnStep.ts  → calls spawnPeer + waitForPeer (per-step engine/model/worktree)
    fanoutStep.ts → N× spawnPeer, Promise.all(waitForPeer) — parallel, each isolated
    verifyStep.ts → spawn a verifier peer OR run a command; parse pass/fail
    loopStep.ts   → retry-with-budget wrapper around a sub-step
    gateStep.ts   → reuse frozen-gate/ or classifyFrozenBatch as a precondition
  manager.ts      spawnWorkflowRun() + dispatchWorkflow() + workflowRunners Map
```

**`types.ts` — the code-defined spec.** A `WorkflowSpec` is a TypeScript object (steps + edges + per-step `{ engine: PeerEngine, model, prompt, dependsOn[], retry, verify }`). Persist a `WorkflowRunRecord` — either as a `PeerRecord` with `kind:"workflow_run"` + a `workflow` config blob (cheapest; reuses `store.ts`/`updatePeer`/`listPeers`/dashboard), or a sibling `workflows[]` array in `state.json`. Given the read-modify-write race (§2), prefer **one record per workflow + one child `PeerRecord` per spawned unit**, so the hot writers are the leaf peers (already the existing pattern).

**`engine.ts` — `runWorkflow(run, deps)`** copies `runGsdPhaseBatch`'s shape (`gsdRunner.ts:58-248`): injected `{ updatePeer, appendLog }` deps, a status loop, guaranteed termination. Differences:
- **Fan-out:** a step spawns K peers via `spawnPeer` (`peerManager.ts:28-103`) — each gets its **own linked worktree** (`createPeerWorktree`, `git.ts:62-92`) and auto-pushes on success — then `await Promise.all(ids.map(id => waitForPeer({peerId:id})))` (`peerManager.ts:225-254`). Or use `spawnPeerAndWait` (`:152-160`) per unit.
- **Verify/loop:** after a step's peers reach `done`, run a verify step; on fail, re-dispatch with a repair prompt up to a retry budget (the IMPLEMENTATION-PLAN's "watchdog repair injection" / "fingerprinted CI-failure loop", `:60-61`, are the intended shape).
- **Terminate:** DAG exhausted or budget blown → `workflow_completed` / `workflow_failed`.
- **Heartbeat:** touch `updatedAt`/`lastHeartbeatAt` around each step so a hung workflow is observable (unlike gsdRunner).

**`manager.ts`** mirrors `dispatchGsdPeer` exactly (`peerManager.ts:293-348`): a `Map<workflowId, Promise>` for dedupe + test-await, `.catch()` → `workflow_failed` patch.

**Primitives to call (do not reinvent):** `spawnPeer`, `spawnPeerAndWait`, `waitForPeer`, `peerStatus`, `killPeer`, `resumePeer` (`peerManager.ts`), `integratePeer` (`peerIntegration.ts:100-109`), and the `buildRunnerArgv`/`runPeer` path (which already handles engine selection — so a workflow step just sets `engine: "pi"|"codex"|"cursor"`).

**Where Pi fits:**
- **As an engine (leaf executor):** free once §1 lands — any step sets `engine:"pi"`.
- **As a top-level DRIVER — use `pi --mode rpc`, not print mode.** Verified `docs/rpc.md`: RPC mode is a persistent stdin/stdout JSON process supporting `prompt`/`steer`/`follow_up`/`abort`/`new_session`/`get_state`/`get_session_stats`/`compact`, streaming events, and an `extension_ui_request`/`extension_ui_response` sub-protocol for approvals. This is **strictly more capable than codex** for verify→steer→loop patterns: codex is exec-per-turn + resume-by-thread (no mid-run steer); cursor is one-shot stream. A pi RPC session can be kept alive by the workflow controller and *steered* between verify passes. Two integration depths (both from `docs/sdk.md` + `docs/rpc.md`):
  - **subprocess RPC** (language-agnostic, matches delamain's "shell out" philosophy `IMPLEMENTATION-PLAN.md:44`): spawn `pi --mode rpc`, JSONL framing (**LF-only; `docs/rpc.md:29-36` warns Node `readline` is non-compliant — reuse the manual `indexOf("\n")` buffering the existing runners already use**, e.g. `cursorRunner.ts:134-143`).
  - **in-process SDK** (`import { createAgentSession } from "@mariozechner/pi-coding-agent"`, `docs/sdk.md:18-38`): `session.prompt/steer/followUp/subscribe/compact/abort`. Adds a heavy dep to the Node process; only worth it if you want the workflow controller and the agent in one process.

Recommendation: keep the **workflow engine in TypeScript** (like gsdRunner) with peers as leaf executors; reach for pi-rpc only where a step genuinely needs a long-lived, steerable conversation (interactive verify/repair loops).

---

## 6. Risks / constraints to respect

1. **Node vs Bun split.** Server/CLI/runner/workflow all run under **Node** (`package.json` `engines.node>=20`; `spawnRunner` re-invokes `process.execPath` = node, `peerManager.ts:440`; codex runner sets `CODEX_HOME` etc.). Only the **v2 dashboard** is Bun (`@opentui/core@0.2.4` dep; `src/dashboard/bunEntryV2.ts`, `opentuiRuntime.ts`). **Put the workflow engine on the Node side** — it must share `store.ts`/`peerManager.ts`. Do not couple workflow logic to the Bun dashboard.

2. **`state.json` concurrency (biggest fan-out risk).** Whole-file read-modify-write per mutation (`store.ts:43-58`); atomic rename but non-atomic RMW. Parallel detached peers each write it → lost updates under burst fan-out. Mitigations: keep hot writes at leaf-peer granularity (existing pattern), cap concurrency (IMPLEMENTATION-PLAN Path A hard-caps 4, `:133`), or land the M3 SQLite move (`:250`) before high fan-out.

3. **Worktree integration assumes codex-shaped isolation.** `createPeerWorktree` hardcodes branch `codex-peer/<id>` (`git.ts:78`) and commit author `Codex Peer` (`git.ts:251-259`); `pushPeerBranch` needs origin + a current branch (`git.ts:287-319`). Fine for pi peers (engine-agnostic), but: (a) **`gsdRunner.invokeCodexExec` runs in `peer.repo` with no worktree** — any parallel gsd/workflow-in-place step will collide; **fan-out MUST go through `spawnPeer`** (which does create a worktree). (b) Fresh worktrees trigger `installWorktreeDeps` (`git.ts:94-108`, pnpm/yarn/npm install) — real latency + disk per fan-out unit; the plan's aggressive-cleanup guidance applies (`IMPLEMENTATION-PLAN.md:142-146`).

4. **CODEX_HOME / auth asymmetry across engines.**
   - Codex generic runner: `CODEX_HOME = ~/.delamain/peer-codex-home`, preflighted by `checkCodexPeerAuth` (`runner.ts:65-83`), relogin hint on refresh failure (`:196-202`).
   - **`gsdRunner.invokeCodexExec` does NOT set CODEX_HOME or preflight** — inherits ambient env (latent inconsistency; a workflow codex step should decide which it wants).
   - **Pi uses provider API-key envs** (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`/… — verified `pi --help`) **or pi `/login` OAuth**, session dir `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). **There is no CODEX_HOME-style per-peer auth isolation for pi** — verified locally that with all keys unset, `pi --print --mode json` emits the session header then throws `Error: No API key found for google`. A `piRunner` needs its own preflight (check the target provider's key present) and must **not** call `checkCodexPeerAuth`. Pi's default provider is `google`; pass `--model <provider>/<id>` explicitly.

5. **Frozen-peer handling.** `reconciledPeer` flips active peers → `frozen` on dead pids or >120s stale heartbeat (`peerManager.ts:459-467`). GSD-kind peers are **exempted via early-return** (`:452-454`, test-pinned). **A `workflow_run` record must be exempted too** (it carries no single pid) — but then it can't be auto-frozen, so bake heartbeat/timeout into the engine (gsdRunner's known gap). Individual fan-out **leaf peers** keep normal frozen detection (good — that's where hangs actually happen). `killPeer` already kills `codexPid`+`enginePid`+`runnerPid` (`:264-266`), so pi/cursor/codex leaves are all killable; a `cancel_workflow` tool should kill every child peer id it spawned.

6. **Waiting/resume protocol is engine-neutral but text-based.** The whole halt/resume loop keys off the peer's final message containing `CODEX_PEERS_STATUS: WAITING` + `QUESTION:` (`codexEvents.ts:143-149`), surfaced as `status:"waiting"`, resumed by `send_peer_reply`→`resumePeer` (thread/session resume). Pi peers get this for free **iff** the pi prompt wrapper includes the same contract (copy `cursorRunner.ts:280-288`) and `piEvents.ts` runs the final assistant text through `parseWaitingQuestion`. Remember pi's resume handle is a **session file path**, not a codex thread id (§1).

7. **`wait_for_peer` only waits on `starting|working`.** Non-generic statuses (`gsd_*`, future `workflow_*`) are "not active" (`peerManager.ts:472-474`) so `wait_for_peer` returns instantly — the workflow layer must expose its own `workflow_status`/await path (the `workflowRunners` Map), exactly as gsd does via `_awaitGsdRunner`.