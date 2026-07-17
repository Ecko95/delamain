I have everything needed: the transcript, the official Claude Code workflows docs, the alexop deep-dive on the primitive semantics, and delamain's actual source (spawn/wait/resume/status + the existing terminating `gsdRunner` loop). Returning the distilled research.

---

# Ultracode/Workflows → delamain: the primitives and their peer-primitive mappings

Legend: **[V-DOCS]** verified from official Claude Code docs (code.claude.com/docs/en/workflows). **[V-WEB]** verified from alexop.dev deep-dive. **[V-YT]** stated by Theo in the transcript. **[V-SRC]** verified by reading delamain source. **[REC]** recall/inference.

## Part A — What ultracode/Workflows actually is (the DESIGN TARGET)

**The core idea [V-DOCS][V-YT]:** a *dynamic workflow* is a **single JavaScript file that Claude writes on the fly**, executed top-to-bottom by a background runtime, that orchestrates subagents. The plan lives *in code* (loops, branches, intermediate vars) instead of in the model's turn-by-turn context. Because it is code, **it returns and therefore terminates** — the model's context only ever receives the final return value, not the per-agent transcripts. Theo: same/better output quality, **~1/4 the token usage** vs Codex "Ultra" which "just goes forever." Trigger = literal keyword `ultracode` in a human-typed prompt, or `/effort ultracode` (xhigh reasoning + auto-workflow per task). Introduced v2.1.154 (2026-05-28).

**Saved-script shape [V-DOCS]** (`.claude/workflows/<name>.js`, or `~/.claude/workflows/`):
```javascript
export const meta = { name: 'audit-routes', description: '...' }
const found = await agent('List every .ts file under src/routes/.', {
  schema: { type:'object', required:['files'],
            properties:{ files:{ type:'array', items:{ type:'string' } } } },
})
const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)
return audits.filter(Boolean)
```
Body = plain JS with **top-level await**. Input arrives as a global `args` (structured, not a string) for saved workflows.

**The primitive set [V-DOCS][V-WEB]:**
- `agent(prompt, opts?)` — spawn ONE subagent. Opts: `schema` (JSON Schema; **validation at the tool-call layer → model auto-retries on mismatch**, "far more reliable than 'please return JSON'"), `label` (UI name), `phase` (progress group), `model` (per-call model override), `isolation:"worktree"` (run in a separate git worktree so parallel writers don't collide).
- `parallel(thunks)` — **barrier** fan-out: runs thunks concurrently, *waits for every thunk* before returning; a throwing thunk becomes `null` rather than rejecting the whole call.
- `pipeline(items, ...stages)` — **no-barrier** streaming fan-out: each item flows through stages independently ("item A can be in stage 3 while item B is still in stage 1"); each stage receives `(prevResult, originalItem, index)`. **Docs guidance: default to `pipeline()`; use a `parallel()` barrier only when a stage needs all prior results at once.**
- `phase(title)` — start/label a progress group; used *inside* parallel/pipeline so agents attribute to the right phase without racing global phase state.

**Runtime constraints / guarantees [V-DOCS][V-WEB]:**
- **Concurrency cap = 16** concurrent agents (fewer on low-core machines); excess queues.
- **Hard cap = 1,000 agents total per run** ("prevents runaway loops") — a structural termination guarantee.
- **Determinism for resume:** `Date.now()`, `Math.random()`, argless `new Date()` are **prohibited/throw** — every `agent()` call is *journaled* so a paused run resumes (completed agents return cached results; an in-flight agent restarts). ⇒ fan-out into many small agents preserves more progress than one long agent.
- Script has **no direct fs/shell/network**; only agents touch the world. Script only coordinates.
- **No mid-run user input** (only permission prompts pause). For human sign-off between stages → run each stage as its own workflow.
- **Cost governance:** `/config` size guideline (small<5 / medium<15 / large<50 agents) sent as advice to the model; advisory "Large workflow" warning at >25 agents or >1.5M projected tokens; per-model routing via per-agent `model` or `CLAUDE_CODE_SUBAGENT_MODEL`.
- **Quality harnesses [V-WEB] (library patterns, not language primitives):** *adversarial verify* — "spawn N independent skeptics prompted to refute a finding; kill it unless a majority survive"; *perspective-diverse verify* — different lenses (correctness/security/perf) instead of identical judges; *loop-until-dry* — keep spawning finders until K consecutive rounds find nothing new. The bundled `/deep-research` fans readers across angles, cross-checks/**votes on each claim**, filters unsurvived claims.

## Part B — delamain's existing substrate [V-SRC]

| delamain capability | file | shape |
|---|---|---|
| `spawnPeer(opts)` → `PeerRecord{id,status}` | `src/peerManager.ts:28` | **non-blocking**; creates isolated linked **worktree** + branch, writes prompt file, spawns a **detached** `run-peer` child, returns immediately. Engine `codex`\|`cursor`. |
| `spawnPeerAndWait` | `:152` | `spawnPeer` + `waitForPeer` (blocking convenience). |
| `waitForPeer({peerId,timeoutMs,pollIntervalMs,logLines})` | `:225` | **polls the on-disk store** every `pollIntervalMs` until status leaves `starting/working`; default timeout 30min. |
| `resumePeer`/`send_peer_reply` | `:162` | resume the Codex thread with a new prompt; requires `threadId` + peer not active. This is the reply channel for `CODEX_PEERS_STATUS: WAITING`. |
| `peerStatus`/`listPeers` | `:213` | read `PeerRecord`s from `state.json` store. |
| `killPeer` | `:262` | SIGTERM/SIGKILL the runner + engine. |
| status vocab | `src/types.ts:1` | `starting,working,waiting,idle,done,failed,frozen,killed` (+ gsd_* set). |
| runner result | `src/runner.ts` | emits status from `codex exec --json` events; `finalResult` = **free-text collected output trimmed to 6000 chars** (`:210`); captures `threadId`; `CODEX_PEERS_STATUS: WAITING` sentinel → `waiting`. On `done`, **auto-pushes the peer branch**; `integratePeer` opens a PR + GitHub auto-merge. |
| **existing terminating loop** | `src/gsdRunner.ts:58` `runGsdPhaseBatch` | a hand-rolled **single-track sequential pipeline**: `for i in selected_phases` → (optional frozen gate) → `codex exec` one phase → wait exit → poll `STATE.md` → advance `cursor` or fail → **terminates when cursor exhausts**. Cursor persisted in `gsdBatch` (resume seed). **No fan-out, no concurrency, no verify, no schema.** |
| token accounting | `src/codexUsage.ts` | codex usage parsing exists (partial budgeting substrate). |

**Key substrate facts for the mapping:**
1. `spawnPeer` is already **async/detached** — the exact non-blocking primitive an `agent()` await-wrapper needs.
2. Peers already run in **isolated worktrees by default** → `isolation:"worktree"` is *free* in delamain (it's the always-on mode, not an opt-in).
3. `gsdRunner` proves delamain can host a **code-defined loop that terminates on a bounded cursor** and journals progress — but it's hardcoded to one recipe.
4. **Scale mismatch to design around:** a delamain "agent" is a *heavyweight* peer (full `codex exec` process + worktree + branch + optional PR). 1,000 concurrent is unrealistic; realistic cap ≈ **4–8 heavy peers**. Barrier/pipeline *semantics* still apply; only the numbers change.
5. **Auto-integration conflict:** `runner.ts` auto-pushes every `done` peer and `integratePeer` opens a PR each. Fan-out of 20 agents ⇒ 20 branches/PRs. A workflow needs a **`integrate:false` / ephemeral-worktree spawn mode** so only the *final synthesized* result integrates.

## Part C — Required primitives → delamain mapping

For each: what it must do, and how it composes from `spawnPeer / waitForPeer / send_peer_reply / peerStatus`. Proposed engine lives as a new lib module (e.g. `src/workflow/`) exposing `agent/parallel/pipeline/phase` over `peerManager`, plus a `run-workflow <script.ts>` runner process (mirrors the detached `run-peer` runner) so orchestration executes in the background with its context isolated from the caller.

### (1) Code-defined workflow scripts (deterministic control flow)
**Target [V-DOCS][V-YT]:** a JS/TS file, top-to-bottom, top-level await, `return` at the end; loops/branches/intermediate results in script vars, not model context.
**delamain map:** add a `run-workflow` subcommand (sibling to `run-peer` in `buildRunnerArgv`/`spawnRunner`, `peerManager.ts:386/437`) that imports and executes a user/agent-authored TS module exporting `meta` + a default async `run(ctx)`. `ctx` provides `agent/parallel/pipeline/phase`. Each `agent()` = `spawnPeer(...)` then `await waitForPeer(...)`, returning the peer's structured result. This is exactly `gsdRunner.runGsdPhaseBatch` **generalized**: replace its hardcoded phase-cursor `for`-loop with arbitrary user code. Determinism guard: **forbid `Date.now`/`Math.random`/`new Date()`** in the sandbox (needed for §5/§9 resume) — inject a seeded `ctx.now()`/`ctx.rand()` instead. Engine-agnostic: `agent(prompt,{engine})` dispatches to `codex|cursor|pi` via the existing `engine` param — this is where **Pi becomes an added engine** and/or the workflow script itself is the "top-level driver" Theo says Pi lacks.

### (2) `phase()` grouping
**Target [V-DOCS]:** assign an agent to a named progress group; safe inside parallel/pipeline (no racing on global phase state).
**delamain map:** add an optional `phase?: string` + `label?: string` to `PeerRecord` (`types.ts:43`) and to `SpawnPeerOptions`. The dashboard (`src/dashboard/model.ts`) groups peers by `phase` for the `/workflows`-style progress view. No new control primitive — purely a tagging + rollup concern (agent-count / token-total / elapsed per phase, matching the docs' progress view columns).

### (3) `parallel()` barrier vs `pipeline()` no-barrier fan-out
**Target [V-DOCS][V-WEB]:** `parallel(thunks)` awaits ALL, throws→null; `pipeline(items,...stages)` streams per-item with no barrier, stage fn gets `(prev, item, i)`. Default to pipeline.
**delamain map:** both are thin async combinators over the `agent()` wrapper + a shared semaphore (§4):
- `parallel(thunks)` = `Promise.all(thunks.map(t => sem.run(() => t().catch(()=>null))))`. Each thunk is `spawnPeer`→`waitForPeer`. Barrier = the `Promise.all`.
- `pipeline(items,...stages)` = per item, chain `stages.reduce((p,stage,i)=> p.then(prev=>sem.run(()=>stage(prev,item,i))))`; collect with `Promise.allSettled`. No cross-item barrier ⇒ item A's stage 3 overlaps item B's stage 1, exactly as specified. **Worktree isolation is automatic** (each `spawnPeer` = own worktree), so parallel writers never collide — delamain gets the docs' `isolation:"worktree"` semantics for free.

### (4) Concurrency cap
**Target [V-DOCS]:** ≤16 concurrent (fewer on low-core), rest queues.
**delamain map:** delamain currently has **no cap** — `spawnPeer` fires immediately. Add an async **semaphore** in the workflow runtime that gates the `spawnPeer` call (acquire before spawn, release in `waitForPeer`'s terminal branch). Default cap **much lower than 16** because peers are heavyweight — suggest `min(cpuCount, N)` with N≈4–6, configurable via `.planning/config.json` or env (`DELAMAIN_MAX_CONCURRENT_PEERS`). The semaphore is the single choke point all of parallel/pipeline/loop route through.

### (5) loop-until-dry / loop-until-budget
**Target [V-WEB]:** keep spawning finders until K consecutive rounds add nothing new (dry); or stop at a token/agent budget.
**delamain map:** plain `while` in the script — no new primitive, but needs **two counters the runtime enforces**: (a) `roundsSinceNew` for dry detection, driven by comparing each round's structured results (dedup keyed by a schema field); (b) budget accumulators. `gsdRunner`'s `cursor` loop is the existing precedent (bounded `for`); loop-until-dry is the same shape with a data-driven exit. Enforce a **max-rounds hard stop** regardless (see §9). Budget stop reads per-peer token usage via `codexUsage.ts` accumulated into a run-level counter checked before each `spawnPeer`.

### (6) Adversarial verify / judge panels
**Target [V-WEB]:** spawn N independent skeptics to refute a finding; keep only if majority survive. Perspective-diverse: different lenses. `/deep-research` votes per claim, filters unsurvived.
**delamain map:** a **library function over the primitives**, not an engine feature:
```
async function verify(finding, {jurors=3, lenses}) {
  const votes = await parallel(range(jurors).map((_,i) =>
    () => agent(refutePrompt(finding, lenses?.[i]),
                { schema: { survives:'boolean', reason:'string' } })));
  return votes.filter(v=>v?.survives).length > jurors/2;
}
```
Each juror = an independent `spawnPeer` (own worktree, ideally `engine`/`model`-diverse to get genuine independence — delamain's multi-engine `codex|cursor|pi` is an asset here). Uses §7 schema so votes are machine-countable. Jurors should be **read-only / `integrate:false`** peers (they judge, they don't push).

### (7) Per-agent structured output (schema)
**Target [V-DOCS][V-WEB]:** `agent(prompt,{schema})`; **validation at the tool-call layer → auto-retry on mismatch**; far more reliable than asking for JSON.
**delamain map:** **biggest gap.** Today `finalResult` is free text trimmed to 6000 chars (`runner.ts:210`) — unusable for control flow. Add: (a) `schema?` on `SpawnPeerOptions`; (b) the runner appends a "return a JSON object matching this schema as your final message / write it to `.delamain/result.json`" instruction to the prompt; (c) on peer terminal, parse+validate against the schema; (d) **on mismatch, `send_peer_reply` (`resumePeer`) with the validation error and re-wait** — this reuses the existing resume channel as the "auto-retry" loop, capped at e.g. 2 retries. The parsed object becomes `agent()`'s return value. This unlocks §3/§5/§6 (they all need machine-readable results to branch/dedup/count).

### (8) Token budgeting
**Target [V-DOCS]:** per-agent token totals in progress view; size guidelines; advisory warning at >25 agents or >1.5M tokens; per-stage model routing.
**delamain map:** `codexUsage.ts` already parses codex usage → surface per-peer tokens on `PeerRecord`, accumulate a **run-level total** in the workflow runtime. Enforce a **hard `budgetTokens` and `maxAgents`** passed into the run (checked in the semaphore before each spawn → refuse/stop when exceeded). Emit the docs-style advisory warning at thresholds. Per-stage cost control is already native: `agent(prompt,{model, engine, reasoningEffort})` maps straight to `spawnPeer`'s existing `model`/`reasoningEffort`/`engine` knobs — cheap models/engines for wide fan-out, expensive for synthesis.

### (9) Guaranteed TERMINATION
**Target [V-DOCS][V-YT]:** the run ends because (a) the script `return`s, (b) hard 1,000-agent cap, (c) no infinite model turn-taking — the loop is *code*, not model discretion. This is the whole value prop ("~1/4 tokens; Ultra goes forever").
**delamain map:** termination is guaranteed by **three independent stops**, all enforced by the runtime not the script: (a) **script returns** → runtime marks the workflow peer `done` with the return value as `finalResult`; (b) **`maxAgents` hard cap** (delamain analog of 1,000; set ~50–200 given heavy peers) — spawn refused past it; (c) **`budgetTokens` cap** (§8) and a **wall-clock deadline** (reuse `waitForPeer`'s `timeoutMs`, but at *run* level). Every `agent()` inherits a per-peer timeout so no single peer hangs forever (delamain already downgrades stale peers to `frozen` via heartbeat in `reconciledPeer`, `peerManager.ts:464`). Loop-until-dry (§5) always pairs its data-driven exit with a **max-rounds** ceiling. Net: unlike Codex Ultra's model-driven "continue until solved," delamain's stop conditions are structural and checked in the semaphore/runtime — the same reason Claude Code workflows terminate.

## Part D — Minimal viable subset for delamain v1

Ship these five; defer the rest. Ordered by dependency.

1. **`run-workflow` runner + `agent()` wrapper** [enables everything]. New detached subcommand mirroring `run-peer`; `agent(prompt,opts)` = `spawnPeer`→`waitForPeer`, returning a result. Reuse `buildRunnerArgv`/`spawnRunner` (`peerManager.ts:386`). The workflow file is a TS module (`export const meta`, `export default async run(ctx)`), authored by the human OR by an agent — matching Theo's "the model itself writes the workflow code."
2. **Structured output + schema-retry (§7)** [gates 3/5/6]. `schema` on spawn opts; validate peer result; `resumePeer` on mismatch (≤2 retries). Without this, fan-out results can't drive control flow.
3. **Concurrency semaphore + `parallel()` and `pipeline()` (§3,§4)** with a **low default cap (≈4–6)**. Add a **`integrate:false` ephemeral spawn mode** so fan-out doesn't emit N PRs — only the final `return` value integrates via `integratePeer`.
4. **Termination guards (§9)**: `maxAgents` + `budgetTokens` + run-level `timeoutMs`, enforced in the semaphore. This is the feature that makes it "end" — the entire point.
5. **One quality harness — `verify()` (§6)** as a library helper over `parallel()`+`schema`, plus **loop-until-dry with a max-rounds ceiling (§5)**. This delivers the "adversarially review before reporting" behavior the docs headline, cheaply.

**Defer to v2:** `phase()` progress-grouping UI (§2 — nice for the dashboard, not load-bearing); full journaling/mid-session **resume** (delamain's `state.json` + `gsdBatch.cursor` pattern is the seed, but real resume needs deterministic replay — the `Date.now`/`Math.random` ban — which is scope); the 1,000-scale numbers (irrelevant for heavyweight peers); size-guideline advice-to-model and live token warnings.

**Two adaptations delamain MUST make that Claude Code didn't face:** (a) heavyweight peers ⇒ caps in the single digits, not 16/1000; (b) auto-push/auto-PR on `done` must be **suppressible per-agent** or fan-out floods the remote — introduce an ephemeral/read-only worktree spawn mode where only the orchestrator's final synthesized artifact is integrated. Both are small changes to `runner.ts`'s post-`done` path and a new `SpawnPeerOptions.integrate` flag.

**Strategic note (Pi):** the workflow script *is* the "top-level driver." Theo: "Pi is great, but you'll have to build all these workflows and orchestration tools yourself" — delamain's v1 workflow engine is precisely that missing layer, and because `agent()` dispatches by `engine`, Pi can be either the harness running the script or just one more selectable sub-agent engine alongside `codex`/`cursor`.

Sources: [Claude Code Workflows docs](https://code.claude.com/docs/en/workflows) · [alexop.dev — Deterministic Multi-Agent Orchestration](https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/) · [Developers Digest — Ultracode explained](https://www.developersdigest.tech/blog/ultracode-effort-level-explained) · Theo t3.gg transcript (`newsletter-curator/transcripts/…Noo0NWD0gHU.md`). delamain source verified: `src/peerManager.ts`, `src/mcpServer.ts`, `src/types.ts`, `src/gsdRunner.ts`, `src/runner.ts`.