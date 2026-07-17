# SP1 Wave 3 — SQLite state + resume/journaling/determinism — Plan

**Date:** 2026-07-17
**Branch:** `feat/sp1-wave3-sqlite-resume` (off `main` @ 528192a, after #19 + #20 merged)
**Design source:** `2026-07-16-sp1-workflow-engine-design.md` §8 (State: SQLite), §14 (Error handling & resume)
**Builds on:** Wave 1 (#19 — engine + ctx.agent + schema + sandbox), Wave 2 (#20 — fan-out + two-pool + guards + OS jail)

---

## 1. Scope (build exactly this)

### A. SQLite state layer (§8)
Replace `store.ts`'s whole-file read-modify-write (the documented lost-update race under burst fan-out) with **`node:sqlite`** (built-in on Node 24.18 — no native dep, consistent with the "no isolated-vm/native addon" stance).

- Tables: `peers`, `workflow_runs`, `workflow_agents` (the per-leaf journal — spec calls it `workflow_nodes`), `token_usage`. (`events` table deferred to wave 4 with the event stream.)
- **Per-write transactions** so concurrent writers (the workflow runner + N detached leaf runners) can't lose updates.
- **Preserve the API shape**: `readState`/`updatePeer`/`upsertPeer`/`getPeer` keep their signatures so every existing caller (`peerManager`, `gsdRunner`, dashboard, CLI, MCP) is untouched. Internally they become row ops instead of whole-file rewrites.
- **One-time migration**: import an existing `state.json` into the DB on first open; keep a backup.

### B. Journaling (§14)
Durably record each `ctx.agent()` call so a run can replay it:
- Per call: `(workflowId, callIndex, promptHash, optsHash, engine, model, phase, result, tokensSpent, status)`.
- `callIndex` is a deterministic per-run counter assigned in the sandbox child (calls are ordered by the bridge id, which is already monotonic) and echoed to the parent so the same script re-run maps calls 1:1.
- Written when a leaf reaches a terminal validated result (the point ctx.ts returns).

### C. Resume / run-until-done (§14)
- On (re-)dispatch of a workflow whose journal exists, replay cached agent results for the **longest unchanged prefix** — a call matches when `promptHash + optsHash` are identical to the journaled call at that `callIndex`. The first changed/new call and everything after runs live.
- A crashed/paused run resumes from its journaled prefix (cached results replay instantly; no codex spend).
- **Lock** (reuse the gsd-pi `.lock` + pid-liveness pattern) so a workflow can't be double-dispatched.
- Determinism is already in place from Wave 1 (seeded `Math.random`, fixed-epoch `Date` in the sandbox child) — journaling makes the *agent* results deterministic too, closing the replay loop.

### D. Wiring
- `run_workflow` / CLI `run-workflow` gain `--resume <workflowId>` (re-dispatch an existing run) and the runner picks up the journal automatically.
- `workflow_status` surfaces journaled/replayed call counts.

## 2. Explicitly DEFERRED (do NOT build this wave)
Event stream + dashboard panel (wave 4), autonomous-GSD + codex `multi_agent` (wave 5), Pi engine, `verify()` helper.

## 3. Hard constraints
- `node:sqlite` only (no `better-sqlite3` native dep). If a host lacks `node:sqlite`, fail loudly with a clear message (don't silently fall back to lossy JSON).
- Preserve ALL existing behavior: the current `store.ts` API, every caller, and the full test suite (vitest + `node --test`) stay green. The 10 pre-existing git-shim environmental failures remain out of scope.
- Keep injected-deps testability; stay Node-side.
- Migration must be idempotent and reversible (keep the `state.json` backup).

## 4. Method
1. Green baseline (`npm run build && npx vitest run`).
2. TDD: a SQLite-backed store behind the existing API, tested for concurrent-writer correctness (burst parallel, no lost updates) with fakes; then journaling + resume with a fake executor that replays.
3. Atomic commits; green before finishing.

## 5. Acceptance (v1 items 5 + 6)
- A burst-parallel workflow (wave-2 fan-out) writes N leaf records with **no lost updates** (SQLite transactions) — asserted by row counts vs. spawns.
- A **killed run resumes from its journaled prefix**: re-dispatch replays the completed leaves' cached results (zero new codex spawns for the unchanged prefix) and only runs the remainder.
- Same script + same inputs → 100% journal-cache hit (no leaves spawned on a completed run's re-dispatch).
- Existing suite stays green; `state.json` is migrated once and backed up.

## 6. Carry-in review debt (from the #19+#20 code review, 2026-07-17)
Fix early — wave 3 builds on the pool/engine:
- **[HIGH] `pool.ts` shared `pendingRelease`** — concurrent leaves release each other's semaphore slots (permit leak / cap violation). Make `acquire()` return the release token and thread it back through `AgentCallDeps` to `release(token)`.
- **[MED] `jail.c` seccomp x32 bypass** — add the `0x40000000` (X32 bit) guard after the arch match.
- **[MED] `jail.ts` interpreter EXEC portability** — degrade loudly when the ELF loader can't be resolved instead of producing a broken EXEC list.
- **[LOW] `sandbox.ts` `getBudgetSpent` double-call** — compute the budget stamp once, guarded, for both reply branches.
- **[LOW] `pool.ts` `spawnedCount` inflation** — count a leaf only once actually spawned (or decrement on the queued-then-aborted path).
