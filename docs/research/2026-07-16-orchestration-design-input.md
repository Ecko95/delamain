All four briefs are internally consistent and my spot-checks confirm the delamain source claims (`types.ts:22/24`, `runner.ts:34` dispatch + `:210` 6000-char `finalResult`, `gsdRunner.ts:58` terminating cursor loop, `peerManager` spawn/dispatch/wait/`buildRunnerArgv`, `store.ts` whole-file read-modify-write, 11 live MCP tools). Synthesis follows.

---

# Design Input Brief — Expanding delamain into an ultracode-style dynamic-workflow orchestrator

**Provenance legend:** **[V]** verified by local inspection in the source briefs (CLIs run / files read on this machine, several re-confirmed here) · **[W]** web/docs/recall (2026 sources post-dating training) · **[INF]** inferred/design judgment. Where briefs diverged, the reconciliation is called out inline.

**One-line verdict (all four briefs converge, no contradictions):** delamain must **own the workflow engine in TypeScript**. Neither Codex "ultra mode" nor Pi provides code-defined, terminating, multi-phase workflows; Codex sub-agents are model-driven and don't reliably terminate, and Pi ships no workflow/orchestration layer at all. Codex/Cursor/Pi are **leaf executors**; Codex `multi_agent`/`spawn_agents_on_csv` is at most a *bounded* accelerator *inside* a leaf. delamain's existing `gsdRunner` is the working proof-of-concept of a terminating code-defined loop — generalize it.

---

## 1. Current State (delamain today) [V]

A Node ESM MCP server + CLI that spawns/supervises headless coding peers in isolated git worktrees.

- **Engines:** `PeerEngine = "codex" | "cursor"` (`types.ts:24`). **No plugin registry** — engine is a string union dispatched at **exactly one runtime fork**: `runner.ts:34` (`if (args.engine === "cursor") runCursorPeer(...); else` → inline codex path). Codex is the fall-through default; cursor lives in `cursorRunner.ts` + `cursorEvents.ts`, normalizing to a shared `ParsedCodexEvent`.
- **Primitives (`peerManager.ts`):** `spawnPeer` (`:28`, non-blocking, detached child, own worktree+branch), `spawnPeerAndWait` (`:152`), `waitForPeer` (`:225`, polls `state.json`, waits only while status ∈ `starting|working`), `resumePeer`/`send_peer_reply` (`:162`, codex resume-by-threadId), `peerStatus`/`listPeers` (`:213`), `killPeer` (`:262`, kills `runnerPid`+`codexPid`+`enginePid`). argv seam `buildRunnerArgv` (`:386`) is unit-tested.
- **State:** single `state.json` under `~/.delamain/` (`store.ts`), **whole-file read-modify-write** per mutation (`updatePeer` `:43` → `writeState` temp-file + `renameSync`). Atomic rename but **non-atomic RMW** → lossy under burst parallel writers.
- **Status vocab (`types.ts:1`):** `starting,working,waiting,idle,done,failed,frozen,killed` + a GSD set. `PeerKind = "generic" | "gsd_phase_batch"` (`:22`). Lazy `reconciledPeer` flips stale/dead active peers → `frozen` (>120 s stale heartbeat); GSD-kind peers are **exempted via early-return**.
- **Result shape:** `runner.ts:210` — `finalResult` = **free text trimmed to 6000 chars**. No structured output. On `done`, auto-pushes the peer branch; `integratePeer` opens a PR + GitHub auto-merge.
- **MCP surface (`mcpServer.ts`, hand-rolled JSON-RPC/stdio):** 11 tools — `spawn_peer, list_peers, wait_for_peer, peer_status, read_peer_log, send_peer_reply, spawn_peer_and_wait, kill_peer, spawn_gsd_phase_batch, inspect_gsd_milestone, integrate_peer, classify_frozen_batch`.
- **Embryonic orchestration:** `spawnGsdPhaseBatch` (enqueue, pure record) + `dispatchGsdPeer` (`peerManager.ts:295`, fire-and-forget via a `Map<peerId,Promise>`, test-awaitable) + `runGsdPhaseBatch` (`gsdRunner.ts:58`). The latter is a **hand-rolled sequential phase loop that provably terminates** (advances a `cursor` over `selected_phases`, `codex exec` per phase, polls `STATE.md`, `gsd_completed` when the cursor exhausts). Injected `{updatePeer, appendLog}` deps → fully testable. **But:** fan-out = 1, no verify/loop/retry, no schema, **runs in `peer.repo` in-place (no worktree)**, codex-hardcoded, no auth isolation, no heartbeat.
- **Runtime split:** server/CLI/runner/gsd all run under **Node** (`engines.node>=20`; `spawnRunner` re-invokes `process.execPath`). Only the v2 dashboard is Bun (`@opentui/core`). The workflow engine must live on the **Node** side (shares `store.ts`/`peerManager.ts`).

---

## 2. Target Capability (ultracode-style dynamic workflows) [W-DOCS/YT]

Claude Code "Workflows" (`ultracode`, v2.1.154, 2026-05-28) is the design target. The distinguishing property: **a workflow is code** — a JS/TS file executed top-to-bottom by a background runtime — so **it returns and therefore terminates**, and the model's context only ever sees the final return value, not per-agent transcripts. Theo: same/better quality, **~¼ the tokens** vs Codex Ultra which "just goes forever."

**Primitive set to replicate (engine-agnostic across codex/cursor/pi):**
- `agent(prompt, opts?)` — spawn ONE sub-agent. Opts: `schema` (JSON Schema, **validated at the tool-call layer → model auto-retries on mismatch**), `label`, `phase`, `model`, `isolation:"worktree"`.
- `parallel(thunks)` — **barrier** fan-out (awaits all; a throwing thunk → `null`, not a reject).
- `pipeline(items, ...stages)` — **no-barrier** streaming fan-out (item A can be in stage 3 while B is in stage 1); stage fn gets `(prev, item, i)`. Docs default: prefer `pipeline`, use `parallel` only when a stage needs all prior results.
- `phase(title)` — progress-group label, race-safe inside parallel/pipeline.
- **Library patterns (not primitives):** adversarial `verify()` (N skeptics refute a finding; keep only if majority survive), perspective-diverse judges, **loop-until-dry** (spawn finders until K consecutive empty rounds).

**Runtime guarantees:** concurrency cap 16; **hard 1,000-agent-per-run cap** (structural termination); determinism for resume (`Date.now`/`Math.random`/argless `new Date()` **throw**; each `agent()` call journaled); script has **no fs/shell/network** (only agents touch the world); no mid-run user input.

---

## 3. Reality Check on Enabling Tech

### 3a. Codex "ultra mode" / sub-agents — what it actually provides [V + W]
- **"Ultra mode" is a product-tier behavior, not a CLI flag.** The mechanism is the `multi_agent` feature (stable, on by default in this install) + the `spawn_agent` tool family. Distinct from the `Ultra` *reasoning-effort* enum level (which the current default model `gpt-5.6-luna` **rejects** — orthogonal, unusable now). **[V]**
- **DECISIVE [V]:** `spawn_agent` **works headless in `codex exec`.** A ground-truth test spawned a real sub-agent (`SpawnAgent → Wait → PING`) with existing `-c` passthrough — **zero delamain code change** needed to enable per-peer. Cost: **~11.5k tokens for one trivial 1-level spawn.** Enable via `-c features.multi_agent=true -c agents.max_depth=1 -c agents.max_threads=4`; delamain's `buildCodexArgs` already appends caller `-c` pairs.
- **Tool surface (V1):** `spawn_agent` (`fork_turns: none|all`), `wait_agent`, `send_input`, `resume_agent`, `close_agent`, and **`spawn_agents_on_csv`** — the one primitive with "starts, maps, terminates" semantics (per-row `report_agent_job_result`, `max_runtime_seconds`, `max_concurrency`).
- **What it does NOT provide:** code-defined terminating control flow. **Control flow is model-decided and prone to non-termination / 6–12× token runaway** (Theo; corroborated by cost docs and a reported runaway that deleted a home dir). Only structural brakes: `agents.max_depth` (nesting, not loops) and `max_runtime_seconds` (CSV path only). **[W]**
- **Caveats [V/W]:** the model won't self-declare `spawn_agent` (system prompt discourages it) → hard to introspect; sub-agent actions needing fresh approval **hard-error back to the parent** in `codex exec`; delamain hard-codes `--disable hooks`, which **suppresses `SubagentStart/Stop` observability** — would need to be conditional. `multi_agent_v2` (deep nesting + context-copying + message passing) is experimental, off, and to be **avoided**.
- **→ Should delamain delegate to it? No.** Not as an orchestrator. Optionally invoke it *inside a single leaf* for embarrassingly-parallel, well-scoped sub-tasks — prefer `spawn_agents_on_csv` (it terminates), cap `max_depth=1` + small `max_threads` + a hard wall-clock timeout owned by delamain.

### 3b. Pi harness — what it actually provides [V]
- **Confirmed: Pi has NO built-in workflow/orchestration engine and NO built-in sub-agent tool.** Theo's "you build all orchestration yourself" is **verified against shipped code.** The agent loop runs 1..N turns and **terminates when the model emits no tool call** — termination is *model-judgment*, there is no phase/iteration/fan-out concept. **[V]**
- **What Pi does provide (its strong suit): excellent headless drivability.** Four modes; three non-interactive: **Print** (`pi -p`), **JSON stream** (`pi --mode json` → typed JSONL event union with per-message `usage`/`cost`/`stopReason` — richer and better-specified than cursor-agent), **RPC** (`pi --mode rpc`, long-lived, bidirectional JSONL, `prompt`/`steer`/`follow_up`/`abort`/`set_model`/`compact` — supports **mid-run steering**, which codex/cursor cannot). 20+ model providers incl. OpenAI codex-max over the API with `--thinking xhigh`. **[V]**
- **"Sub-agents" in Pi = a copyable example extension**, not a feature: `examples/extensions/subagent/` spawns `pi --mode json -p --no-session` subprocesses (single / parallel max-8-conc-4 / chain-with-`{previous}`-handoff). Even its "workflows" are prompt-template `.md` files instructing a driver agent to call the tool — **LLM-orchestrated, not code-defined.** **[V]**
- **No MCP either way [V]:** Pi is not an MCP client and exposes no MCP server (zero real hits across `dist`). Third-party `pi-mcp-adapter` v2.11.0 exists on npm **[W, unverified — audit before trust]**. So "Pi calls delamain MCP tools" needs a bridge.
- **Auth caveat [V]:** Pi has **no CODEX_HOME-style per-peer isolation** — it reads provider env keys / `~/.pi/agent/auth.json`. The stored Anthropic OAuth token is **expired**; with keys unset `pi --mode json` emits the session header then throws `No API key found`. Default provider is `google`. A Pi peer needs a live key via env + its own auth preflight (must **not** call `checkCodexPeerAuth`).
- **Resume handle [V]:** Pi resumes by **session file path** (`--continue`/`--session <path>`), not a thread id — so `PeerRecord.threadId` must store the session path for Pi peers.
- **→ Does delamain need to own the workflow engine? Yes.** Pi confirms it: the loop must live in delamain TypeScript. Pi is best as **(1) a leaf engine** and **(2) optionally a steerable RPC leaf** for interactive verify/repair — **not** the deterministic top driver.

### 3c. Net implication (reconciled across briefs)
> delamain **cannot** safely delegate top-level orchestration to Codex ultra (model-driven, doesn't reliably terminate) **or** to Pi (no orchestration layer; LLM-judged termination). The "code defines control flow, so it ends" property — the entire value prop, and the reason Claude Code Workflows use ~¼ the tokens — lives in the **harness/driver**. delamain's `gsdRunner` already demonstrates exactly this property. **Grow `gsdRunner` into a generalized, engine-agnostic, fan-out/verify/loop engine.** Everything else (codex `multi_agent`, Pi RPC) is a leaf-level option.

---

## 4. Gap Analysis (current → target)

| # | Capability | Today | Gap | Where |
|---|---|---|---|---|
| G1 | **Code-defined workflow runner** | `gsdRunner` = one hardcoded recipe | new detached `run-workflow` subcommand executing a TS module (`meta` + `run(ctx)`); `ctx` = `agent/parallel/pipeline/phase` | sibling to `run-peer` in `buildRunnerArgv`/`spawnRunner` |
| G2 | **Per-agent structured output (schema)** | `finalResult` free text @6000 chars (`runner.ts:210`) — unusable for branching | **biggest code gap.** `schema?` on spawn opts; runner instructs peer to emit JSON / write `.delamain/result.json`; validate on terminal; on mismatch `resumePeer` with error + re-wait (≤2 retries). Gates G3/G5/G6. | `runner.ts`, `SpawnPeerOptions` |
| G3 | **`parallel()` + `pipeline()` fan-out** | fan-out = 1 everywhere | thin async combinators over `agent()` + a shared semaphore; worktree isolation is **free** (each `spawnPeer` = own worktree) | `src/workflow/` |
| G4 | **Concurrency cap** | **none** — `spawnPeer` fires immediately | async **semaphore** gating spawn; default **4–6** (peers are heavyweight, not 16), env-configurable | workflow runtime |
| G5 | **loop-until-dry / loop-until-budget** | none (gsd cursor is bounded `for`) | plain `while` in script + runtime-enforced `roundsSinceNew`, budget accumulators, **hard max-rounds** | `src/workflow/` |
| G6 | **Adversarial `verify()` / judge panels** | none | library helper over `parallel()`+`schema`; jurors = independent (ideally engine/model-diverse) read-only peers | `src/workflow/` |
| G7 | **Token budgeting** | partial (`codexUsage.ts` parses codex usage) | surface per-peer tokens on `PeerRecord`; run-level accumulator checked in the semaphore; hard `budgetTokens`/`maxAgents` | runtime |
| G8 | **Guaranteed termination** | gsd terminates; generic peers don't compose | three runtime stops: script `return` → `done`; `maxAgents` hard cap (~50–200); `budgetTokens` + wall-clock deadline. All checked in semaphore, not script | runtime |
| G9 | **`integrate:false` / ephemeral spawn** | every `done` peer auto-pushes + opens a PR | **mandatory** — fan-out of N would flood N branches/PRs. New `SpawnPeerOptions.integrate` flag; only the final synthesized `return` integrates | `runner.ts` post-`done` path |
| G10 | **Pi as 3rd engine** | `codex|cursor` only | `PeerEngine += "pi"`; `runPiPeer`/`piEvents` (clone cursor); ~2 files + enum widen + ~6 plumbing edits | see §5-A |
| G11 | **`workflow_run` peer kind + frozen exemption + wait path** | gsd has these; workflow doesn't | `PeerKind += "workflow_run"`; `reconciledPeer` early-return exemption (carries no single pid) → **bake heartbeat/timeout into the engine**; own `workflow_status` await (wait_for_peer returns instantly for non-active kinds) | `types.ts`, `peerManager.ts` |
| G12 | **Determinism for resume** (defer) | none | ban `Date.now`/`Math.random`/`new Date()` in sandbox; inject seeded `ctx.now()`/`ctx.rand()`; journal `agent()` calls. Only needed if resume is in scope. | v2 |
| G13 | **state.json fan-out safety** | whole-file RMW race (`store.ts:43`) | keep hot writes at leaf-peer granularity (existing pattern) + low concurrency; or land SQLite (M3) before high fan-out | `store.ts` |

**Two adaptations Claude Code never faced (both briefs 3 & 4 flag as mandatory):** (a) delamain "agents" are **heavyweight** (full `codex exec` process + worktree + branch + optional PR) → caps in single digits, `maxAgents`≈50–200, not 16/1000; (b) **auto-push/auto-PR on every `done` must be suppressible** (G9) or fan-out floods the remote.

---

## 5. Candidate Architectures

### Architecture A — delamain-as-workflow-engine (RECOMMENDED)
**Diagram-in-words:** MCP tool `run_workflow(spec)` → `spawnWorkflowRun` (a `kind:"workflow_run"` record) → `dispatchWorkflow` (fire-and-forget, `Map<id,Promise>`, mirrors `dispatchGsdPeer`) → detached **`run-workflow`** child executes a TS module `run(ctx)`. `ctx.agent/parallel/pipeline/phase` are async combinators that call **`spawnPeer`→`waitForPeer`** per node, gated by one **semaphore** (cap 4–6). Each node is `engine:"codex"|"cursor"|"pi"`, `isolation:"worktree"` (free), `integrate:false` (ephemeral). Schema-validated results (G2) drive branching/dedup/voting. `verify()` = `parallel()` of read-only juror peers. Termination = script `return` ∨ `maxAgents` ∨ `budgetTokens` ∨ wall-clock, all enforced in the runtime. Only the final synthesized artifact integrates.

Proposed layout (Brief 4): `src/workflow/{types.ts, engine.ts (analog of runGsdPhaseBatch), steps/*, manager.ts}`.

- **Pros:** delivers the exact target property (code-defined control flow → guaranteed termination, ~¼ tokens); engine-agnostic by construction (Pi/codex/cursor per node); reuses every existing primitive (worktree isolation, integration, dashboard, kill, resume-as-retry); `gsdRunner` is a proven, tested template; deterministic + observable.
- **Cons:** most net-new code (runner + combinators + schema layer + caps + `integrate:false`); must respect state.json race (G13) and add heartbeat to the workflow record (G11); worktree install latency/disk per fan-out unit.
- **Effort:** **M–L.** v1 slice (§6) ≈ 1 new subcommand + `src/workflow/` (~4–6 files) + `schema`/`integrate` flags on `SpawnPeerOptions` + `runner.ts` post-`done` edit + semaphore. Pi engine (G10) is an independent ~2-file add.

### Architecture B — Pi-as-top-orchestrator calling delamain MCP tools
**Diagram-in-words:** a long-lived `pi --mode rpc` session (or interactive TUI) runs a driver agent; a Pi extension (`registerTool`) exposes `spawn_peer`/`wait_for_peer`/`list_peers`/… — implemented by importing delamain's TS in-process, shelling the CLI, or opening an MCP stdio client to `mcpServer.ts`. (Or use `pi-mcp-adapter` for zero delamain change **[W, unverified]**.) The human/driver issues NL requests; Pi decides what peers to spawn.

- **Pros:** conversational, human-steerable supervisor; Pi RPC `steer`/`follow_up` is genuinely better than codex/cursor for interactive verify→steer→loop; typed TUI-rendered toolset; minimal delamain change (Option B) or a single extension (Option A).
- **Cons:** **the loop is LLM-driven → termination depends on model judgment**, exactly the property the user wants to *escape*. Fails the "guaranteed-terminating batch workflow" goal. Bridge needed (Pi has no MCP). Reconciliation across briefs 2 & 4: **use this as a complementary interactive front-end, NOT as the deterministic batch driver.**
- **Effort:** **S–M** (one extension + bridge). Low value for the stated core goal; real value only for human-in-the-loop supervision.

### Architecture C — thin wrapper delegating to codex-cli ultra mode
**Diagram-in-words:** delamain sets `features.multi_agent=true` (+`max_depth`/`max_threads`) on a single `codex exec` peer via existing `-c` passthrough and lets the Codex model spawn its own sub-agents.

- **Pros:** **zero code change** to enable (verified headless); genuine model-decided parallel fan-out; `spawn_agents_on_csv` gives bounded map-terminate semantics for embarrassingly-parallel batches.
- **Cons:** **rejected as the primary architecture** — model-driven control flow, **no structural termination**, 6–12× token runaway, headless approval trap, `--disable hooks` blinds observability, model won't self-declare tools. Does not yield code-defined workflows.
- **Effort:** **XS**, but wrong layer. **Keep only as a bounded leaf option inside Architecture A** (prefer `spawn_agents_on_csv`, hard timeout owned by delamain, `max_depth=1`, make `--disable hooks` conditional to regain `SubagentStart/Stop`).

**Recommendation:** **A** as the spine; **C** as an opt-in bounded leaf accelerator; **B** as an optional later interactive front-end. **Pi enters via G10 (leaf engine) and optionally as a Pi-RPC steerable leaf** for interactive repair steps — not as the top driver.

---

## 6. Recommended v1 slice (smallest real end-to-end dynamic workflow)

Ship these five (Brief 3 Part D order; all on the Node side; codex leaves only so Pi auth isn't on the critical path):

1. **`run-workflow` runner + `agent()` wrapper (G1).** Detached subcommand mirroring `run-peer`; `agent(prompt,opts)` = `spawnPeer`→`waitForPeer`. Workflow file = TS module (`export const meta`, `export default async run(ctx)`), human- or agent-authored. This is `runGsdPhaseBatch` generalized: replace the hardcoded phase cursor with arbitrary user code.
2. **Structured output + schema-retry (G2).** `schema` on spawn opts; validate peer result; `resumePeer` on mismatch (≤2 retries). *Gates 3/5/6 — without it, results can't drive control flow.*
3. **Semaphore + `parallel()` + `pipeline()` (G3/G4) with default cap ≈4–6**, plus **`integrate:false` ephemeral spawn mode (G9)** so fan-out doesn't emit N PRs — only the final `return` integrates.
4. **Termination guards (G8):** `maxAgents` + `budgetTokens` + run-level `timeoutMs`, enforced in the semaphore. *This is the feature that makes it "end."*
5. **One quality harness:** `verify()` (G6) over `parallel()`+`schema`, plus **loop-until-dry with a max-rounds ceiling (G5).** Delivers the "adversarially review before reporting" headline behavior cheaply.

**Concrete demo that proves the target:** a workflow that fans out N codex peers over a file list (`pipeline`), verifies each finding with a 3-juror read-only panel (`verify`), loops-until-dry with `maxRounds=3`, and returns a synthesized result — and **provably terminates** on budget/agents/return, using ~¼ the tokens of a Codex-Ultra equivalent.

**Parallel low-cost add (independent of the 5 above):** **G10 Pi engine** (~2 files: `piRunner.ts`, `piEvents.ts` + enum widen + ~6 plumbing edits). Structurally identical to the cursor engine; gives multi-model juror diversity and a path to codex-max/xhigh via API. Recommend landing it right after the v1 slice (or in parallel) since the user explicitly wants Pi — but it is **not required** for the terminating-workflow demo.

**Defer to v2:** `phase()` dashboard UI (G11 tagging is cheap; the *view* is not load-bearing); full journaling/deterministic resume (G12 — needs the `Date.now`/`Math.random` ban); SQLite (G13, unless fan-out cap is raised); size-guideline advice + live token warnings; `multi_agent`/`spawn_agents_on_csv` leaf accelerator (C); Pi-RPC steerable interactive front-end (B).

---

## 7. Open Questions for the User

1. **Who authors workflow scripts?** Human-written TS files, or does an agent write the workflow code per task (Theo's "the model writes the JS")? The latter needs a sandboxed execution model + the determinism ban up front.
2. **Sandbox model for the script:** plain dynamic `import()` of a trusted TS module (simplest, matches `gsdRunner`) vs a real VM/`isolated-vm` with no fs/shell/network (matches Claude Code's guarantee, more work). Which trust level?
3. **Primary goal shape:** guaranteed-terminating **batch** workflows (→ Architecture A only) vs also a conversational **interactive** supervisor (→ add Architecture B / Pi-RPC)? Or both, phased?
4. **Machine budget:** acceptable max concurrent heavyweight peers given cores, disk for worktree installs, and $ per run? (Sets the semaphore cap and whether SQLite (G13) is needed before v1.)
5. **Codex `multi_agent` as a leaf:** wire `spawn_agents_on_csv`/`spawn_agent` as an opt-in bounded accelerator now, or defer? (Enabling costs ~0 code but adds token-runaway blast-radius.)
6. **Pi auth strategy:** provide a live provider API key via env per Pi peer (stored OAuth is expired)? Which default provider/model for the Pi engine (`google` is Pi's default; you likely want `openai/<codex-max>` or `anthropic/...`)?
7. **Resume in scope for v1?** If yes, the `Date.now`/`Math.random` determinism ban + `agent()` journaling (G12) must land in v1, not v2.
8. **PR/integration policy under fan-out:** confirm `integrate:false` ephemeral worktrees for all fan-out leaves, with only the final synthesized artifact integrated (the design assumes this).

---

## 8. Key Risks & Unknowns

- **[V] `state.json` RMW race (highest fan-out risk).** Whole-file read-modify-write (`store.ts:43`); parallel detached peers can lose updates. Mitigate: leaf-granularity writes + low cap, or SQLite (M3) before high fan-out.
- **[V/INF] `workflow_run` frozen-watchdog gap.** The record carries no single pid → needs the `reconciledPeer` early-return exemption like gsd, but then it **can't be auto-frozen** → the engine **must** emit its own heartbeat/timeout (gsdRunner's known missing piece). Leaf peers keep normal frozen detection (good — that's where real hangs are).
- **[V] `gsdRunner` runs in-place (no worktree).** Any fan-out **must** route through `spawnPeer` (which creates a worktree) — never reuse `invokeCodexExec`'s in-`peer.repo` pattern for parallel steps, or writers collide.
- **[V/W] Codex `multi_agent` blast radius & runaway.** 6–12× tokens, non-termination, destructive-command reports, headless approval trap, `--disable hooks` hides `SubagentStart/Stop`. If used as a leaf: hard timeout + `max_depth=1` + small `max_threads`, conditional hooks.
- **[V] Pi auth fragility.** No CODEX_HOME-style isolation; stored OAuth expired; default provider `google`. Needs its own preflight + live env key; must not call `checkCodexPeerAuth`. Resume handle is a **session file path**, not a thread id.
- **[V] Pi RPC framing.** JSONL is **LF-only**; Node `readline` is non-compliant (splits on U+2028/2029) — reuse the manual `indexOf("\n")` buffering the existing runners already use.
- **[V] `Ultra` reasoning effort unusable.** Default model `gpt-5.6-luna` rejects it — don't design around it; it's orthogonal to sub-agents.
- **[V] `wait_for_peer` semantics.** Only waits while status ∈ `starting|working`; `workflow_run`/`gsd_*` are "not active" → returns instantly. The workflow layer must expose its own `workflow_status` await (the runners `Map`), as gsd does via `_awaitGsdRunner`.
- **[V] Worktree install cost.** Fresh worktrees trigger `installWorktreeDeps` (pnpm/yarn/npm) — real latency + disk per fan-out unit; aggressive cleanup needed at scale.
- **[W, unverified] `pi-mcp-adapter`** — only a registry listing; audit before trusting in Architecture B.
- **[INF] Schema-retry reliability.** Claude Code validates at the tool-call layer; delamain would validate *post-hoc* on the final message + resume-on-mismatch. This is a weaker guarantee (the peer already spent tokens) — retry cap (≤2) and a fallback (`.delamain/result.json` write instruction) recommended; effectiveness on codex/cursor/pi is **unverified** and should be smoke-tested in v1.
- **[INF] Independence of jurors.** True adversarial verify wants genuinely independent judges; same-engine same-model jurors may collude on errors. delamain's multi-engine `codex|cursor|pi` diversity is an asset here — but engine/model-diversity in `verify()` is a design choice to confirm.