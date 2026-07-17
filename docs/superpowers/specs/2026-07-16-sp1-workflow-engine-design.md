# SP1 — delamain Workflow Engine + Event Stream — Design Spec

**Date:** 2026-07-16
**Status:** Design agreed; ready for spec review → implementation plan
**Parent:** `2026-07-16-agent-orchestration-system-overview.md`
**Research:** `../../research/2026-07-16-orchestration-design-input.md` (+ siblings)

---

## 1. Purpose & scope

Build delamain's **code-defined, terminating, multi-phase workflow engine** — ultracode parity — as a new
`src/workflow/` subsystem that drives the existing peer primitives, plus the **workflow event stream** that
all cockpits subscribe to. This is the generalization of the proven `runGsdPhaseBatch` loop
(`src/gsdRunner.ts:58`) from one hard-coded recipe into an arbitrary `run(ctx)` program.

**In scope (v1):** the runner + `ctx` API (`agent`/`parallel`/`pipeline`/`phase`/`verify`/`log`/`budget`);
per-agent `schema`; child-process + `node:vm` + OS-jail sandbox with the async `ctx` bridge; two-pool
concurrency + termination guards; `integrate:false` ephemeral leaves; SQLite state; resume/determinism via
lock + tool-call replay; codex `multi_agent` bounded-leaf option; the event stream; a live workflow panel in
the OpenTUI dashboard. **Pi leaf engine** (SP2) lands in parallel but is specced separately.

**Out of scope (this spec):** gitscode/T3 coordinator (SP3); the standalone Pi extension (SP4 — consumes
the event stream defined here); raising the peer-sandbox layer to a pluggable provider model.

## 2. Current state (delamain today) — the seams we build on

Verified in `src/` on 2026-07-16:

- **Engine dispatch:** `PeerEngine = "codex" | "cursor"` (`types.ts:24`); branched at exactly one fork,
  `runner.ts:34` (`if engine==="cursor" → runCursorPeer else codex`). Cursor normalizes to a shared
  `ParsedCodexEvent`.
- **Primitives** (`peerManager.ts`): `spawnPeer` (`:28`, detached child, own worktree+branch),
  `spawnPeerAndWait` (`:152`), `waitForPeer` (`:225`, polls state, active ⟺ `starting|working`),
  `resumePeer`/`send_peer_reply` (`:162`), `killPeer` (`:262`), argv seam `buildRunnerArgv` (`:386`),
  `dispatchGsdPeer` (`:295`, fire-and-forget `Map<id,Promise>`).
- **State:** single `state.json`, **whole-file read-modify-write** (`store.ts:43`) — lossy under burst
  parallel writers → replaced by SQLite (§8).
- **Result shape:** `runner.ts:210` — `finalResult` = free text trimmed to 6000 chars. No structure → §6.
- **Statuses** (`types.ts:1`): `starting,working,waiting,idle,done,failed,frozen,killed` (+GSD set).
  `PeerKind = "generic" | "gsd_phase_batch"` (`types.ts:22`). `reconciledPeer` flips stale active peers →
  `frozen` (>120s); GSD kinds are exempt via early-return.
- **MCP surface** (`mcpServer.ts`, hand-rolled JSON-RPC/stdio): 12 tools incl. `spawn_peer`,
  `wait_for_peer`, `send_peer_reply`, `spawn_gsd_phase_batch`, `inspect_gsd_milestone`, `integrate_peer`,
  `classify_frozen_batch`.
- **Prior-art loop:** `runGsdPhaseBatch` (`gsdRunner.ts:58`) — terminating `for` over `selected_phases`,
  `codex exec` per phase, polls `STATE.md`, `gsd_completed` on cursor exhaustion. Injected
  `{updatePeer, appendLog}` deps → fully testable. Gaps: fan-out=1, no verify/loop/schema, runs **in-place
  in `peer.repo`** (no worktree), codex-hardcoded.
- **Runtime split:** server/CLI/runner/gsd on **Node** (≥20); only the v2 dashboard is Bun (OpenTUI). The
  workflow engine lives on the **Node** side.

## 3. Module layout (new)

```
src/workflow/
  types.ts         WorkflowSpec (meta + run), WorkflowRunRecord, NodeRecord, event types
  ctx.ts           the injected API surface (agent/parallel/pipeline/phase/verify/log/budget)
  sandbox.ts       child-process executor + node:vm global + OS-jail policy + async ctx bridge (host side)
  sandbox-child.ts entry run inside the jailed child: builds node:vm global, loads script, proxies ctx→IPC
  engine.ts        the run driver: semaphore(two-pool), budget, termination guards, node scheduling
  schema.ts        JSON-Schema validation + resume-on-mismatch retry
  events.ts        the workflow event stream (emit + local transport)
  manager.ts       spawnWorkflowRun / dispatchWorkflow (Map<id,Promise>) + workflow_status await
  gsd.ts           autonomous-GSD workflow built on the engine (hardened gsdRunner, §10)
```

New peer/record kinds: `PeerEngine += "pi"` (SP2); `PeerKind += "workflow_run"`; statuses reuse existing
set plus a workflow-level `running|done|failed|halted`.

## 4. The `ctx` API (ultracode parity)

The workflow script is `export const meta = {...}; export default async function run(ctx) { ... }`.
`ctx` is the ONLY capability the script has (no fs/shell/net — §7).

| `ctx` member | Semantics | Maps to |
|---|---|---|
| `agent(prompt, opts?)` | spawn ONE leaf; returns validated result (string, or object if `schema`). `null` on death. | `spawnPeer`(worktree, `integrate:false`) → `waitForPeer` → `schema.ts` |
| `parallel(thunks)` | **barrier** fan-out; awaits all; throwing thunk → `null` | `Promise.all` under semaphore |
| `pipeline(items, ...stages)` | **no-barrier** streaming; stage gets `(prev, item, i)`; item drops to `null` on throw | per-item chains under semaphore |
| `phase(title)` | progress-group label; race-safe inside parallel/pipeline | tags nodes → event stream |
| `verify(claim, {jurors, lens?})` | N read-only, engine-diverse jurors refute; majority-survive verdict | `parallel()` of `schema`'d juror agents |
| `log(msg)` | narrator line | event stream |
| `budget` | `{ total, spent(), remaining() }` (tokens) | run-level accumulator (§5) |

`agent` opts: `{ schema?, engine?: "codex"|"cursor"|"pi", model?, phase?, label?, effort?, isolation? ("worktree" default), integrate? (false default), multiAgent? (§9) }`.

**Library helpers** (built on the primitives, not new primitives): adversarial `verify`, perspective-diverse
juries, **loop-until-dry** (`while` in script + runtime `roundsSinceNew` + hard `maxRounds`),
loop-until-budget (`while (budget.remaining() > k)`).

## 5. Concurrency, budget & termination (the "it ends" guarantees)

**Two-pool concurrency** (the VPS-exploitation model):
- **Script pool** — workflow_run children are cheap and almost always IO-blocked on `ctx.agent()`.
  Oversubscribe (hundreds). One cgroup v2 slice per child (`memory.max`, `cpu.max`, `pids.max`).
- **Agent pool** — leaf peers are heavyweight (full `codex/cursor/pi` process + worktree +
  `installWorktreeDeps`). One **semaphore** gates every `spawnPeer`; default cap env-tuned (`DELAMAIN_MAX_AGENTS`,
  small-double-digits default, sized to VPS RAM/CPU). This is the real ceiling.

**Termination = runtime brakes, enforced in `engine.ts` (never in the script):**
1. script `return` → workflow `done`;
2. `maxAgents` hard cap (default ~50–200) → `halted`;
3. `budgetTokens` exhausted → `halted`;
4. run-level `timeoutMs` wall-clock → `halted`.
All four are checked at the semaphore, so a runaway script cannot outlive them.

**Heartbeat:** a `workflow_run` record carries no single pid, so it is **exempt from `reconciledPeer`
frozen detection** (like GSD kinds). Therefore `engine.ts` **emits its own heartbeat + enforces its own
timeout** (this is the gap `gsdRunner` has today — close it here). Leaf peers keep normal frozen detection.

## 6. Structured output (`schema`) — the keystone

Without machine-readable results, fan-out/verify/loop cannot branch. Design:
- `agent(prompt, {schema})` appends an instruction: emit a single fenced JSON object **and** write it to
  `.delamain/result.json` in the worktree (belt-and-suspenders across codex/cursor/pi).
- On terminal `done`, the runner reads the result (prefer `.delamain/result.json`, else parse the final
  message), validates against `schema` (Ajv).
- On mismatch: `resumePeer` with the validation error appended, re-wait; **≤2 retries**, then the node
  resolves to `null` (a throwing node, so `parallel`/`pipeline` degrade gracefully).
- Caveat (design risk, must be smoke-tested v1): unlike Claude Code (which validates at the tool-call
  layer), delamain validates *post-hoc* — the peer already spent tokens. The retry cap + dual-write
  mitigate; effectiveness on each engine is verified in the v1 acceptance demo.

## 7. Sandbox (v1: child-process + node:vm + OS jail)

isolated-vm is **verified broken on Node 25.5.0** (segfaults on `new ivm.Isolate()`); adopted later behind
the identical `ctx` interface (Node-24 pin or Node 26 + 7.x). v1 uses layered isolation:

- **Executor:** `sandbox.ts` spawns `sandbox-child.ts` as a detached child (native to delamain's model).
- **Language boundary (`node:vm`):** the child compiles the workflow module in a `vm` context whose global
  is **built from empty** — inject `ctx`, `console→log`, and **deterministic** `Date`/`Math.random`/`crypto`
  shims (§ resume); omit `require`/`process`/`fetch`. `node:vm` is **not** a security boundary on its own
  (documented escapes; vm2 is dead) — it only controls the language-level global.
- **Security boundary (OS jail):** the child runs under an unprivileged uid, **seccomp/landlock** syscall
  filter, a **network namespace** (deny-all), **read-only FS** except a scratch tmp, and a **cgroup v2**
  slice. This is the real deny-fs/shell/net boundary.
- **Defence-in-depth:** AST-validate the script with the existing `tree-sitter` / `tree-sitter-typescript`
  deps to reject `require`/`import`/`process`/dynamic-eval before it runs.
- **Async `ctx` bridge:** the in-child `ctx` is a proxy; each call serializes `{id, method, args}` over a
  length-framed JSON-RPC line protocol on a dedicated fd → the **delamain parent** invokes the real peer
  machinery (spawn leaf in a worktree, itself sandboxed) → replies `{id, result|error}` → the child
  correlates by `id` and resolves/rejects the pending promise. `parallel`/`pipeline` = multiple outstanding
  `id`s the parent fans out and joins. All real-world capability stays in the parent.

## 8. State: SQLite

Replace `store.ts`'s whole-file RMW with SQLite (better-sqlite3 or node:sqlite):
- Tables: `peers`, `workflow_runs`, `workflow_nodes`, `events` (append-only), `token_usage`.
- Per-write transactions → safe under the two-pool fan-out. Existing `PeerRecord` fields
  (`sourceRepo, baseRef, mergeBranch, worktreePath, integrationStatus, threadId, engine, model, …`) map to
  columns; keep the `updatePeer`/`peerStatus`/`listPeers` API shape so callers don't change.
- Migration: one-time import of any existing `state.json`.

## 9. codex `multi_agent` as a bounded leaf (opt-in)

`agent(prompt, {multiAgent: {maxThreads, csv?}})` enables codex's stable `multi_agent` inside that single
leaf via existing `-c` passthrough (`buildCodexArgs`): `-c features.multi_agent=true -c agents.max_depth=1
-c agents.max_threads=N`. Prefer `spawn_agents_on_csv` (it terminates). delamain owns a **hard wall-clock
timeout** on the leaf; make the peer's `--disable hooks` **conditional** so `SubagentStart/Stop`
observability returns. Off by default (token-runaway blast radius).

## 10. Autonomous GSD (harden `gsdRunner`, keep its shape)

`gsd.ts` expresses the GSD phase loop as a workflow on this engine, keeping delamain's differentiators
(multi-engine, **frozen-gate** `gateFrozenPhase`, **frozen-eligibility** `classify_frozen_batch`) and
grafting gsd-pi's proven auto-mode patterns:
- `deriveState(repo)` → next unit (read `.planning/`/`.gsd/` STATE/ROADMAP/phases);
- **fresh leaf per unit** with context pre-inlined; **stuck detection** (same unit dispatched twice → one
  diagnostic retry → halt); **three-tier timeout** (soft/idle/hard); **crash-recovery** via `.lock` +
  tool-call replay; **provider-error classification** (rate-limit → auto-resume; permanent → pause);
  **reassess/replan** after each slice; optional `KNOWLEDGE.md` memory; **headless auto-restart** w/ backoff.
- The existing `runGsdPhaseBatch` becomes a thin caller of `gsd.ts`; `spawn_gsd_phase_batch` /
  `inspect_gsd_milestone` MCP tools keep working.

## 11. Workflow event stream (single source of truth)

`events.ts` emits an append-only lifecycle stream consumed by every view (delamain TUI, SP4 Pi extension,
SP3 T3 bridge). One producer, many subscribers — no view re-derives state.

- **Events:** `workflow_start{id,name,meta}`, `phase_start{phase}`, `agent_spawn{node,engine,model,phase}`,
  `agent_progress{node,tokens,elapsed}`, `agent_done{node,status,tokens,elapsed}`, `agent_failed{node,err}`,
  `phase_done{phase}`, `workflow_end{id,status,totals}`.
- **Transport:** append to the SQLite `events` table (durable, replayable) **and** publish on a local
  transport — a Unix domain socket at `~/.delamain/events.sock` (line-delimited JSON) that subscribers tail;
  a tailable `~/.delamain/events.jsonl` is the fallback. (This is also the substrate SP3 bridges to T3's
  `orchestration.domainEvent` and SP4 renders.)

## 12. MCP + CLI surface (additions)

- MCP: `run_workflow({ script | scriptPath, args?, budgetTokens?, maxAgents?, timeoutMs? })` →
  `spawnWorkflowRun` → returns `{ workflowId }`; `workflow_status({ workflowId })`;
  `list_workflows()`; `workflow_events({ workflowId, since? })`.
- CLI: `delamain run-workflow <file> [--args …] [--budget …] [--max-agents …]` (detached, mirrors
  `run-peer`); `delamain workflows` (list); `delamain workflow <id>` (status/json).

## 13. Dashboard workflow panel (OpenTUI, `delamain -d`)

Mirror Claude Code's `/workflows` view (reference screenshot 2026-07-16), driven by the event stream:
- **Footer status:** `❊ Waiting for N dynamic workflows to finish` (via existing status line).
- **Workflow list:** id, name, `done/in-progress/open` counts, elapsed.
- **Detail (two-pane):** left **Phases** (`› 1 Build 6/7`, `2 Verify` greyed until started); right **Agents**
  per phase — status icon (✓ done / ● running / ○ open / ✗ failed), label, engine+model, elapsed; header
  `6/7 agents · 1h13m`; token totals.
- Data model is Node-side (subscribes to `events.ts`); rendering stays Bun/OpenTUI. Vendor/adapt gsd-pi's
  visualizer layout where useful.

## 14. Error handling & resume

- A throwing node → `null` (never crashes the run); schema mismatch → bounded retry (§6).
- **Resume/determinism (in v1):** ban `Date.now`/`Math.random`/argless `new Date()` in the sandbox global;
  inject seeded `ctx.now()`/`ctx.rand()`; **journal each `agent()` call** (id, prompt-hash, opts, result) to
  SQLite. A crashed/paused run resumes from the longest unchanged prefix (cached node results replay
  instantly), reusing gsd-pi's lock + tool-call-replay recovery. Enables overnight run-until-done.
- Leaf peers retain normal frozen detection; only the final synthesized artifact integrates (all other
  leaves `integrate:false`, ephemeral worktrees, aggressively cleaned).

## 15. Testing strategy

- **Unit:** `engine.ts`, `ctx.ts`, `schema.ts`, `manager.ts` take **injected deps**
  (`{spawnPeer, waitForPeer, resumePeer, updatePeer, appendLog, now, rand}`) — exactly how `gsdRunner` is
  tested today — so the loop, semaphore, budget, termination, retries, and pipeline/parallel semantics are
  covered with fake peers and no real processes.
- **Sandbox:** tests that fs/shell/net are denied; that determinism shims hold; that the async `ctx` bridge
  round-trips and correlates `id`s; that AST validation rejects `require`/`process`.
- **Integration (live smoke, the v1 acceptance demo):** a workflow that `pipeline`s N codex peers over a
  file list, `verify()`s each finding with a 3-juror read-only panel, loops-until-dry (`maxRounds=3`), and
  returns a synthesized result — and **provably terminates** on `return`/`maxAgents`/`budget`, using ~¼ the
  tokens of a codex-Ultra equivalent. Confirms schema-retry works on the real engine.

## 16. Risks (carried from research)

- **schema-retry post-hoc** is weaker than tool-call-layer validation — smoke-test per engine (§6/§15).
- **Sandbox jail correctness** (seccomp/landlock/cgroup policy) is the load-bearing security boundary —
  `node:vm` alone is not; needs careful review + tests.
- **SQLite under high fan-out** — transaction discipline; watch for write contention at the top of the
  agent pool.
- **Worktree install cost** — `installWorktreeDeps` latency + disk per leaf; aggressive cleanup for
  ephemeral `integrate:false` leaves.
- **Pi auth (SP2)** — live env key required (stored OAuth expired); resume by session-file path.

## 17. v1 acceptance criteria

1. `delamain run-workflow demo.ts` runs a human-authored TS workflow to completion and returns a synthesized result.
2. `parallel`/`pipeline` fan out under the agent semaphore; `verify()` runs engine-diverse jurors; loop-until-dry terminates on `maxRounds`.
3. The run **provably terminates** on each of `return`, `maxAgents`, `budgetTokens`, `timeoutMs`.
4. Structured `schema` results drive branching; schema-retry works on codex (and cursor).
5. Sandbox denies fs/shell/net; determinism shims hold; a killed run **resumes** from its journaled prefix.
6. SQLite state survives a burst-parallel run with no lost updates.
7. `delamain -d` shows the live workflow panel (phases, agents, counts, tokens, elapsed) via the event stream.
8. Autonomous GSD (`gsd.ts`) runs a milestone via the engine with crash-recovery + frozen-gate intact.
