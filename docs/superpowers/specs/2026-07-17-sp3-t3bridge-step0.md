<!-- Provenance: SP3 step-0, verified against gitscode branch `gits` (packages/contracts/src/orchestration.ts + apps/server) AND a LIVE T3 server booted on this host (owner token minted, POST /api/orchestration/dispatch → 200 {sequence:1}). 8-agent fan-out + 2 adversarial verifiers. 2026-07-17. -->

All findings confirmed against source. Here is the SP3 STEP-0 doc.

---

# SP3 STEP-0 — delamain → T3 (gitscode) orchestration bridge

Status: STEP-0 design, grounded in code. Live-run confirmations noted inline. One item still needs a running T3 (crit path); the recommended path does **not** depend on it.

Scope reminder (user's words): orchestration flow visible in a "Delamain side panel", upgrading to a viewer with logs + selectable running peers, a full orchestration suite + API endpoints an autonomous agent ("Motoko") can later drive. SP3 is **thin, API-ONLY, no deep apps/* fork**.

---

## 1. VERIFIED T3 orchestration surface

### Domain-event union + aggregates
- `OrchestrationEvent` is a 38-variant discriminated union — `packages/contracts/src/orchestration.ts:1337`. Type literals at `:962-1002`.
- Aggregates are **only** `project | thread | worktree` — `orchestration.ts:1005` `OrchestrationAggregateKind = Schema.Literals(["project","thread","worktree"])`. **There is no workflow/phase/multi-agent aggregate.** delamain's `workflow_start / phase_start / phase_done / workflow_end` have no first-class T3 counterpart.
- The display-ready side-panel row is `OrchestrationThreadActivity {id, tone(info|tool|approval|error), kind, summary, payload, turnId, sequence?, createdAt}` — `orchestration.ts:327-337`, carried on the thread at `:383 activities: Schema.Array(OrchestrationThreadActivity)`.

### Command surface (two-tier)
- 17 **client-dispatchable** commands: `ClientOrchestrationCommand` union — `orchestration.ts:716-734` (project.create/meta.update/delete, thread.create/fork/delete/archive/unarchive/meta.update/runtime-mode.set/interaction-mode.set/turn.start/turn.interrupt/approval.respond/user-input.respond/checkpoint.revert/session.stop).
- 21 **internal/provider** commands incl. `thread.activity.append` — `orchestration.ts:930-953`. **`thread.activity.append` is NOT in the client union** and is authorized only for actor `provider`/`server` — `apps/server/src/orchestration/commandInvariants.ts:205-215, 276-282`.

### HTTP endpoints (verified live on this host)
- `POST /api/orchestration/dispatch` — `apps/server/src/orchestration/http.ts` (route reg near end of file). Body schema = `ClientOrchestrationCommand` (`schemaBodyJson(ClientOrchestrationCommand)`), runs `normalizeDispatchCommand`, then **`orchestrationEngine.dispatch(normalizedCommand, "operator")`** — actor is hardcoded `"operator"`, NOT `"delamain"`. Returns `200 {sequence:number}`; invalid body → `400 {"error":"Invalid orchestration command payload."}`.
- `GET /api/orchestration/snapshot` — returns `OrchestrationReadModel`.
- Both are **owner-gated**: `authenticateOwnerSession` → non-owner 403, missing/invalid 401. Bearer from `authorization: Bearer <token>` or session cookie (`apps/server/src/auth/Layers/ServerAuth.ts:100-102`).
- `POST /api/crit/turn` dispatches `thread.turn.start` as actor `"delamain"` — `apps/server/src/crit/critHttp.ts:202`. **`checkActorAuthorization` denies delamain for session-start commands** (`commandInvariants.ts:291-297`). The crit unit test uses a stub engine. **⚠️ NEEDS LIVE T3 RUN to confirm the denial** — but the recommended bridge does not use crit, so this is moot for us.
- **There is NO raw-event ingestion endpoint.** Events are produced internally by the CQRS engine from dispatched commands. A bridge must translate, not passthrough.

### Live streaming surface (for the viewer, later)
- WS-RPC `orchestration.subscribeShell` (snapshot + thread upsert/remove deltas = selectable list), `orchestration.subscribeThread` (per-thread snapshot + live `OrchestrationEvent` items = logs), `orchestration.replayEvents(fromSequenceExclusive)` — `orchestration.ts:35-43, 1640-1669`.

### Running the server locally (verified end-to-end)
Confirmed working bring-up on this host (server booted, owner token minted, `{"sequence":1}` returned):
1. **One-time native fix** (node-pty has no linux-x64 prebuild): `cd /srv/gits/repos/gitscode/node_modules/.bun/node-pty@1.1.0/node_modules/node-pty && npx --yes node-gyp rebuild`.
2. **Start with node, not bun** (bun 1.3.14 fails: `No such built-in module: node:sqlite`): `cd apps/server && T3CODE_HOME=/tmp/t3-home T3CODE_PORT=3799 T3CODE_HOST=127.0.0.1 node src/bin.ts serve`. Binds after ~30-40s (36 migrations + graveyard scan) — poll `/api/orchestration/snapshot` or grep log for `Listening on http://`.
3. **Mint owner bearer** (the `Token:`/pairing URL printed by `serve` is a pairing token, rejected 401 as bearer): `node src/bin.ts auth session issue --role owner --token-only` against the **same** `T3CODE_HOME`.
Defaults: port `3773` (`apps/server/src/config.ts:17`), env `T3CODE_PORT/T3CODE_HOST/T3CODE_HOME`.

---

## 2. delamain → T3 EVENT MAPPING TABLE

delamain's real emitted payloads (confirmed in `src/workflow/engine.ts`, NOT the brief's shapes). Field names are `elapsedMs`/`tokensSpent`; every `agent_*` carries `callIndex`; `id` lives in the JSONL envelope (`workflowId`), never in-payload.

There is **no client command that appends a log line** — `thread.activity.append` is internal/provider-only. So the mapping's target for every "log" event is `thread.activity.append` stamped actor `server`, which requires the one additive ingress route (Section 4). The thread itself is born from `thread.create`.

| delamain event (real payload, cite) | T3 target command → domain event | activity kind / tone | notes / gap |
|---|---|---|---|
| `workflow_start {name,scriptPath,maxAgents,budgetTokens}` (`engine.ts:106-111`) | `thread.create` → `thread.created` (ONCE) + `thread.activity.append` | info | births the thread; `title=name`. No workflow aggregate. |
| `phase_start {phase}` (`engine.ts:169`) | `thread.activity.append` → `thread.activity-appended` | `kind:"phase"`, info | synthetic log row; no phase aggregate. |
| `agent_spawn {node,engine,model,phase,callIndex}` (`engine.ts:181`) | `thread.activity.append` → `thread.activity-appended` | `kind:"task.started"`, `payload:{taskType:"subagent", taskId:node, description:"${engine}/${model}"}` | **lights up existing SubagentTaskSurface, zero UI work** (see §3). |
| `agent_progress` (declared `events.ts:21`, **emitted NOWHERE**) | — | — | **DEAD event.** No source data. Skip. |
| `agent_done {node,status,phase,callIndex,elapsedMs,tokensSpent}` (`engine.ts:212`) | `thread.activity.append` → `thread.activity-appended` | `kind:"task.completed"`, `payload:{taskId:node, status:"completed", elapsedMs, tokensSpent}` | `tokensSpent` is CUMULATIVE run spend, not per-agent. |
| `agent_failed {node,phase,callIndex,elapsedMs,err}` (`engine.ts:215`) | `thread.activity.append` → `thread.activity-appended` | `kind:"task.completed"`, tone:`error`, `payload:{taskId:node, status:"failed", err}` | `node` may be null if leaf never spawned. |
| `phase_done {phase,index}` (`gsdRunner.ts:300` only — **workflow engine never emits**) | `thread.activity.append` | info | only reaches you from GSD-batch runs. |
| `workflow_end {status,elapsedMs,totalAgents,replayedAgents,tokensSpent(,error)}` (`engine.ts:286-292 / 314-321`) | `thread.activity.append` (final summary) | info (or error tone if failed/halted) | no "close" command; thread just stops receiving. |

**Minimal per-workflow command sequence the t3Bridge POSTs** (all via the ingress route, actor `server`):
1. Pre-provision once: a fixed `"Delamain"` project (`project.create`), store its `projectId` in bridge config.
2. On `workflow_start`: `thread.create` under that project → capture returned thread; store `workflowId → threadId` in bridge state.
3. On every later event: `thread.activity.append(threadId, {kind, tone, summary, payload})` per table. Derive `commandId` deterministically from `(workflowId, seq)` for idempotency.
4. On `workflow_end`: one final `thread.activity.append` summary. No close command.

Watch-outs (all bridge-side, no T3 change): dedupe on `(workflowId, seq)`; `seq=0` rows can appear in the JSONL if the SQLite write failed (`events.ts:34-44`); filter to `kind:"workflow_run"` records — the `events` table also carries GSD-batch events with overlapping type names + an extra `phase_retry` type (`gsdRunner.ts:281`).

---

## 3. REUSE vs BUILD

**A `DelamainSidebar` already ships** and is wired into `ChatView` (`apps/web/src/components/DelamainSidebar.tsx`, lazy-mounted `ChatView.tsx:119`). But it is **CLI-peer-centric**: it polls `client.delamain.listPeers()` (10s) + `readPeerLog()` (5s) — the reverse direction (T3 shells out to the delamain binary via `DelamainCliAdapter`). It does **not** touch the OrchestrationThread model or event bus. Do not extend it for SP3 — it is the wrong data source.

**The lazy win is path (A): render delamain workflows as real OrchestrationThreads.**
- A real thread appears in the thread list for free — `Sidebar.tsx SidebarThreadRow` over `OrchestrationThreadShell` (`orchestration.ts:409`).
- Thread detail renders from `OrchestrationThread` via `applyThreadDetailEvent` over the `subscribeThread` snapshot+event stream (`packages/client-runtime/src/threadDetailReducer.ts:69`, `wsRpcClient.ts:42`) — no fork.
- `agent_spawn/agent_done/agent_failed` mapped to `task.started`/`task.completed` activities **light up the already-built `SubagentTaskSurface`** — `deriveSubagentTasks` keys on `activity.kind==="task.started"` + `payload.taskType==="subagent"` (`apps/web/src/session-logic.ts:526-577`), rendered at `ChatView.tsx:1614`. This already gives "selectable per-agent + logs" with **zero web-UI code**.

**Recommendation:** REUSE the existing thread UI (path A). Build **one thin additive backend route** in gitscode (Section 4) — no new panel, no web fork. A bespoke "Delamain side panel" is only warranted later if the workflow/phase structure needs first-class rendering the activity feed can't express.

**The one BUILD required:** `thread.activity.append` is internal/provider-only and absent from `ClientOrchestrationCommand`, so `/api/orchestration/dispatch` cannot carry it. You need **one additive server route** that stamps actor `server`. This is additive (`isStructuralCommand`→server-allowed for `thread.create`; `isProviderCommand`→server-allowed for `thread.activity.append`), not a deep fork — exactly SP3's "thin, API-ONLY" scope.

---

## 4. LAYER-0 t3Bridge DESIGN (minimal first build)

Two files. No new deps (Node `fetch`, `node:fs`).

**gitscode side (additive, ~40 lines):** `apps/server/src/delamain/ingestHttp.ts` — one route `POST /api/delamain/ingest`, owner-gated (reuse `authenticateOwnerSession`), body = a small union `{op:"thread.create",...} | {op:"activity.append", threadId, activity}`, dispatches via `orchestrationEngine.dispatch(cmd, "server")`. Register in `server.ts makeRoutesLayer` alongside `orchestrationDispatchRouteLayer`. This is the only gitscode change.
> Why not reuse `/api/orchestration/dispatch`: its body schema is `ClientOrchestrationCommand` (excludes `thread.activity.append`) and it hardcodes actor `"operator"` (can create threads but can't append the internal activity command). Confirmed `http.ts`.

**delamain side:** `src/workflow/t3Bridge.ts` — a thin subscriber:
- Config from env: `T3_BASE_URL` (e.g. `http://127.0.0.1:3799`), `T3_TOKEN` (owner bearer), `T3_PROJECT_ID` (pre-provisioned Delamain project). If any unset → no-op (bridge is optional, never fails a workflow — mirror `emitWorkflowEvent`'s best-effort contract).
- Subscribe by **tailing `~/.delamain/events.jsonl`** (`eventsJsonlPath()`, `paths.ts:71`) — the only cross-workflow append-ordered stream, currently zero readers. Own a byte offset. `ponytail: naive tail + in-memory workflowId→threadId map, no persistence across bridge restart; add offset+map persistence when the bridge needs to survive restarts mid-workflow.`
- Filter to `workflow_run` events, map per Section 2, POST to `/api/delamain/ingest`. Dedupe on `(workflowId, seq)`.

**Single acceptance test** (`src/workflow/t3Bridge.test.ts`, assert-based, no framework): feed a synthetic 4-line JSONL sequence (`workflow_start`, `agent_spawn`, `agent_done`, `workflow_end`) through the mapper against a stub `fetch` that records calls; assert exactly `thread.create` once then three `activity.append` with kinds `task.started`/`task.completed`/info and a stable `commandId` per `(workflowId,seq)`. (Live end-to-end against a booted T3 is a manual smoke, not the unit test.)

→ skipped: WS push, log rotation, offset persistence, `agent_progress`. Add when: viewer needs live tail (WS), JSONL grows unbounded (rotation), bridge restarts mid-run (persistence), delamain actually emits progress.

---

## 5. UPGRADE LADDER

- **(a) Logs viewer** — needs: nothing new; the mapped `task.started`/`task.completed` activities already render in `SubagentTaskSurface` + thread detail. **Owner: neither** (free once Layer-0 lands). Richer live tail → `subscribeThread` (gitscode, exists).
- **(b) Selectable running peers to check logs** — needs: each leaf = a subagent task in the thread (selectable in `SubagentTaskSurface`); OR one T3 thread per leaf peer. **Owner: delamain** (mapping choice — one thread + N subagent activities is leanest).
- **(c) Full orchestration suite + API endpoints** — needs: broaden the ingress route to accept the phase/workflow structure as structured activities, plus a read/replay surface. **Owner: gitscode** (additive routes) + delamain (emit richer events, e.g. wire the dead `agent_progress`).
- **(d) Motoko autonomous-loop driver** — needs: an **operator**-credentialed client (NOT the `delamain` actor, which `commandInvariants.ts` denies for create/start) calling `orchestration.dispatchCommand` to steer + `subscribeShell`/`subscribeThread`/`replayEvents` to observe. **Owner: gitscode** (the actor/credential model + WS transport already exist; Motoko is a client of them). Note `/api/orchestration/dispatch` already stamps `operator` — Motoko can create/start today over HTTP.

---

## 6. OPEN QUESTIONS / LIVE-RUN CHECKLIST

Confirm against a running T3 (bring-up in §1) before/while writing the bridge:

1. **Exact `thread.create` wire shape** — branded IDs (`threadId`, `projectId`, `IsoDateTime`), and what `normalizeDispatchCommand` (`Normalizer.ts`) rewrites. Live-run: POST a `project.create` then `thread.create`, capture the accepted body + returned sequence/threadId. (Verified live: `project.create` needs `title`+`workspaceRoot`+`createdAt`, NOT `name`; wrong shape → 400.)
2. **Does `thread.create` require the project to pre-exist?** Live-run to observe decider invariants (`decider.ts`/`commandInvariants.ts`). Assume yes → pre-provision the Delamain project.
3. **`thread.activity.append` accepted as actor `server`?** Confirm the new ingress route's dispatch is authorized and the appended activity surfaces in `subscribeThread` / `SubagentTaskSurface`. (Static read says server-allowed via `isProviderCommand`; verify live.)
4. **Exact `OrchestrationThreadActivity` payload `SubagentTaskSurface` needs** — `kind:"task.started"`, `payload.taskType:"subagent"`, `payload.taskId`, optional `description/detail`; completion `kind:"task.completed"` + `payload.status ∈ {failed,stopped,completed}` (`session-logic.ts:533-568`). Confirm field names against a live append that actually renders.
5. **How does an authenticated session resolve to an actor on each path?** Confirmed: HTTP `/dispatch` = `operator`; crit = `delamain`. Confirm the WS dispatch path (`ws.ts`) actor for when Motoko goes WS.
6. **(Non-blocking) crit denial** — whether `POST /api/crit/turn` actually denies `thread.turn.start` for a delamain caller. Not on the bridge path; resolve only if crit is later reused.

---

Files to create: `/srv/gits/repos/delamain/src/workflow/t3Bridge.ts`, `/srv/gits/repos/delamain/src/workflow/t3Bridge.test.ts`, and (gitscode) `/srv/gits/repos/gitscode/apps/server/src/delamain/ingestHttp.ts` + one registration line in `/srv/gits/repos/gitscode/apps/server/src/server.ts`.