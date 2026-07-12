# Citadel Adoptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt five verified mechanisms from SethGammon/Citadel (MIT) into delamain: merged-state tracking, dependency-ordered integration gating, a stale-peer sweep with a real archive writer, path-prefix claim collision checks at spawn, and per-peer cost metering from codex rollout logs.

**Architecture:** Everything lands as small pure-function modules (`mergeState`, `mergeOrder`, `waves`, `claims`, `peerCost`, `pricing`, `sweep`) with thin touchpoints in the existing chokepoints: `types.ts` (two new optional PeerRecord fields + one new status), `spawnPeer` (claims pre-flight), `peerIntegration.ts` (merge-order refusal), and `cli.ts` (four new subcommands). State mutations go through the existing `withStateLock`/`updatePeer` primitives; nothing new touches state.json directly.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import suffixes), vitest for co-located unit tests (`npx vitest run src/<file>.test.ts`), `node --test tests/*.test.mjs` for integration tests against `dist/`. No new dependencies. Repo style: 2-space indent, no lint step (there is none — do not invent one). Verify with `npm run check` (tsc --noEmit) and scoped vitest runs.

**Source provenance:** Mechanisms verified against Citadel 2026-07-12: merge-order gate (`core/fleet/session.js:191-228`), wave readiness (`session.js:178-228`), stale sweep (`core/coordination/sweep.js:12-37`), scope claims (`core/coordination/claims.js:20-73`), pricing/metering pattern (`runtimes/claude-code/adapters/session-tokens.js` — Claude-only there; the codex rollout parser here is ours). Patterns only; no code copied.

**Facts about the current codebase this plan relies on** (verified 2026-07-12):
- `PeerIntegrationStatus = "pending" | "skipped" | "pushed" | "failed"` — `src/types.ts:22`.
- `integrationMergeCommitSha` / `integrationCommitSha` are declared (`types.ts:85-86`) but written nowhere.
- Integration sets `pushed` + `integrationPrNumber`/`integrationPrUrl` after `gh pr create` + auto-merge enable (`src/peerIntegration.ts:207-214`); nothing ever observes whether the PR actually merged.
- `state.archive.json` has NO writer in the repo (external/manual only).
- `spawnPeer` (`src/peerManager.ts:32`) already runs a warn-only sizing pre-flight (`checkTaskSize`); the existing `scope` option is *numeric sizing* (`TaskScope` in `src/taskSizing.ts`) — the new path-prefix field is deliberately named `claims` to avoid collision.
- Store primitives: `readState/writeState/withStateLock/updatePeer/upsertPeer/getPeer` (`src/store.ts`); paths: `peersHome/statePath/runsDir/promptsDir/worktreesDir` (`src/paths.ts`).
- Peers run with `CODEX_HOME=~/.delamain/peer-codex-home` (set by the runner, `src/runner.ts:67`); the supervisor CLI process does NOT have that env — cost discovery must look in `join(peersHome(), "peer-codex-home", "sessions")` first, then fall back to `codexHome()` from `src/codexContext.ts:42`.
- Rollout JSONL carries cumulative totals: `{"type":"token_count","info":{"total_token_usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,...}}}` inside `{"type":"event_msg","payload":{...}}` lines; the LAST such event is the session total.
- CLI = one `switch` in `src/cli.ts` (`runCliCommand`); add a `case` + a `printHelp()` line per command. `parseFlags`/`flagString` helpers live in that file.
- `reconciledPeer` (`src/peerManager.ts:533`) already derives `frozen` on read (heartbeat > 120s or dead pids) — the sweep REUSES that idea but persists the outcome and archives.

---

## Task order & dependency

1. `merged` state + merge-state refresh (foundation: the new status)
2. `dependsOn` + merge-order gate (needs Task 1's status)
3. Stale sweep + archive writer (independent)
4. Path-prefix claims + spawn pre-flight (independent)
5. Wave/readiness views (consumes Tasks 2 & 4)
6. Cost metering (independent)

Each task compiles, tests green, and commits on its own.

---

### Task 1: `merged` integration state + `merge-state` command

**Files:**
- Modify: `src/types.ts:22`
- Create: `src/mergeState.ts`
- Create: `src/mergeState.test.ts`
- Modify: `src/cli.ts` (new case + help line)

- [ ] **Step 1: Extend the status union**

In `src/types.ts` line 22 change:

```ts
export type PeerIntegrationStatus = "pending" | "skipped" | "pushed" | "failed" | "merged";
```

- [ ] **Step 2: Write the failing unit test**

Create `src/mergeState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyPrState, type PrView } from "./mergeState.js";
import type { PeerRecord } from "./types.js";

function pushedPeer(overrides: Partial<PeerRecord> = {}): PeerRecord {
  return {
    id: "abc12345",
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    logPath: "/tmp/x.log",
    integrationStatus: "pushed",
    integrationPrNumber: 12,
    ...overrides,
  } as PeerRecord;
}

describe("applyPrState", () => {
  it("marks MERGED PRs merged and records the merge sha", () => {
    const pr: PrView = { state: "MERGED", mergeCommit: { oid: "deadbeef" } };
    const next = applyPrState(pushedPeer(), pr);
    expect(next?.integrationStatus).toBe("merged");
    expect(next?.integrationMergeCommitSha).toBe("deadbeef");
  });

  it("returns undefined (no change) while the PR is still OPEN", () => {
    expect(applyPrState(pushedPeer(), { state: "OPEN" })).toBeUndefined();
  });

  it("records closed-without-merge as integrationError, status stays pushed", () => {
    const next = applyPrState(pushedPeer(), { state: "CLOSED" });
    expect(next?.integrationStatus).toBe("pushed");
    expect(next?.integrationError).toMatch(/closed without merge/i);
  });

  it("ignores peers that are not pushed or have no PR number", () => {
    expect(applyPrState(pushedPeer({ integrationStatus: "pending" }), { state: "MERGED" })).toBeUndefined();
    expect(applyPrState(pushedPeer({ integrationPrNumber: undefined }), { state: "MERGED" })).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/mergeState.test.ts`
Expected: FAIL — `Cannot find module './mergeState.js'`

- [ ] **Step 4: Implement `src/mergeState.ts`**

```ts
import { execFileSync } from "node:child_process";
import { listPeers } from "./peerManager.js";
import { updatePeer } from "./store.js";
import type { PeerRecord } from "./types.js";

export type PrView = {
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  mergeCommit?: { oid?: string } | null;
};

/**
 * Pure: given a peer and its PR's current view, return the updated record, or
 * undefined when nothing should change. Citadel-style "merged is a first-class
 * status" — see .codex/plans/20260712-citadel-adoptions.md.
 */
export function applyPrState(peer: PeerRecord, pr: PrView): PeerRecord | undefined {
  if (peer.integrationStatus !== "pushed" || !peer.integrationPrNumber) return undefined;
  if (pr.state === "MERGED") {
    return {
      ...peer,
      integrationStatus: "merged",
      integrationMergeCommitSha: pr.mergeCommit?.oid,
      lastEvent: `PR #${peer.integrationPrNumber} merged`,
    };
  }
  if (pr.state === "CLOSED") {
    return {
      ...peer,
      integrationError: `PR #${peer.integrationPrNumber} closed without merge`,
      lastEvent: `PR #${peer.integrationPrNumber} closed without merge`,
    };
  }
  return undefined;
}

export type GhPrViewFn = (peer: PeerRecord) => PrView;

export function ghPrView(peer: PeerRecord): PrView {
  const out = execFileSync(
    "gh",
    ["pr", "view", String(peer.integrationPrNumber), "--json", "state,mergeCommit"],
    { cwd: peer.sourceRepo ?? peer.repo, encoding: "utf8" },
  );
  return JSON.parse(out) as PrView;
}

/** Refresh one peer; returns the updated record or undefined when unchanged. */
export function refreshMergeState(peer: PeerRecord, view: GhPrViewFn = ghPrView): PeerRecord | undefined {
  let pr: PrView;
  try {
    pr = view(peer);
  } catch {
    // gh unavailable / network / PR deleted — leave the record alone.
    return undefined;
  }
  const next = applyPrState(peer, pr);
  if (!next) return undefined;
  return updatePeer(peer.id, () => next);
}

/** Refresh every pushed-with-PR peer. Returns the records that changed. */
export function refreshAllMergeStates(view: GhPrViewFn = ghPrView): PeerRecord[] {
  const changed: PeerRecord[] = [];
  for (const peer of listPeers()) {
    if (peer.integrationStatus !== "pushed" || !peer.integrationPrNumber) continue;
    const next = refreshMergeState(peer, view);
    if (next) changed.push(next);
  }
  return changed;
}
```

Note: if `listPeers` is not exported from `peerManager.ts` with that exact name, check the import list at the top of `src/cli.ts` (it imports `listPeers` today) and reuse whatever it uses.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/mergeState.test.ts` → PASS (4 tests)
Run: `npm run check` → clean

- [ ] **Step 6: Wire the CLI**

In `src/cli.ts` add to the imports:

```ts
import { refreshAllMergeStates, refreshMergeState } from "./mergeState.js";
import { getPeer } from "./store.js";
```

Add a case (next to `case "status"`):

```ts
    case "merge-state": {
      const peerId = argv[0];
      if (peerId) {
        const peer = getPeer(peerId);
        if (!peer) throw new Error(`No peer matching ${peerId}`);
        const next = refreshMergeState(peer);
        console.log(JSON.stringify(next ?? { unchanged: true, id: peer.id, integrationStatus: peer.integrationStatus }, null, 2));
        return;
      }
      console.log(JSON.stringify(refreshAllMergeStates(), null, 2));
      return;
    }
```

Add to `printHelp()` (src/cli.ts:241 area): `  delamain merge-state [peer-id]   Refresh merged/closed state of pushed PRs via gh`

- [ ] **Step 7: Verify manually + commit**

Run: `npm run build && node dist/index.js merge-state` (against real state; peers without PRs → `[]`).

```bash
git add src/types.ts src/mergeState.ts src/mergeState.test.ts src/cli.ts
git commit -m "feat(integration): merged as first-class state + merge-state refresh via gh"
```

---

### Task 2: `dependsOn` + merge-order gate on integration

**Files:**
- Modify: `src/types.ts` (PeerRecord + SpawnPeerOptions)
- Create: `src/mergeOrder.ts`
- Create: `src/mergeOrder.test.ts`
- Modify: `src/peerManager.ts` (persist dependsOn at spawn)
- Modify: `src/peerIntegration.ts` (refusal)
- Modify: `src/cli.ts` (`--depends-on` flag)

- [ ] **Step 1: Add the fields**

`src/types.ts` — inside `PeerRecord` (after `integrationPrUrl`):

```ts
  // Citadel-adoption: ids of peers whose work this peer builds on. Integration
  // is refused until every dependency has integrationStatus "merged".
  dependsOn?: string[];
```

Inside `SpawnPeerOptions` (types.ts:126 block):

```ts
  dependsOn?: string[];
```

- [ ] **Step 2: Write the failing unit test**

Create `src/mergeOrder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateMergeOrder } from "./mergeOrder.js";
import type { PeerRecord } from "./types.js";

function peer(id: string, integrationStatus: PeerRecord["integrationStatus"], dependsOn?: string[]): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    logPath: "/tmp/x.log",
    integrationStatus,
    dependsOn,
  } as PeerRecord;
}

describe("validateMergeOrder", () => {
  const merged = peer("aaa", "merged");
  const pushed = peer("bbb", "pushed");

  it("passes when all dependencies are merged", () => {
    const c = peer("ccc", "pushed", ["aaa"]);
    expect(validateMergeOrder(c, [merged, pushed, c])).toEqual({ ok: true, blockers: [] });
  });

  it("blocks when a dependency is only pushed", () => {
    const c = peer("ccc", "pushed", ["bbb"]);
    const result = validateMergeOrder(c, [merged, pushed, c]);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatchObject({ dep: "bbb", status: "pushed" });
  });

  it("blocks on missing dependencies", () => {
    const c = peer("ccc", "pushed", ["zzz"]);
    const result = validateMergeOrder(c, [c]);
    expect(result.ok).toBe(false);
    expect(result.blockers[0]).toMatchObject({ dep: "zzz", status: "missing" });
  });

  it("passes trivially without dependsOn", () => {
    const c = peer("ccc", "pushed");
    expect(validateMergeOrder(c, [c]).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/mergeOrder.test.ts`
Expected: FAIL — `Cannot find module './mergeOrder.js'`

- [ ] **Step 4: Implement `src/mergeOrder.ts`**

```ts
import type { PeerRecord } from "./types.js";

export type MergeOrderBlocker = { dep: string; status: string; reason: string };
export type MergeOrderResult = { ok: boolean; blockers: MergeOrderBlocker[] };

/**
 * Pure. A peer may integrate only when every dependsOn peer has
 * integrationStatus "merged" (Citadel core/fleet/session.js:191-228 pattern).
 */
export function validateMergeOrder(peer: PeerRecord, peers: PeerRecord[]): MergeOrderResult {
  const byId = new Map(peers.map((p) => [p.id, p]));
  const blockers: MergeOrderBlocker[] = [];
  for (const dep of peer.dependsOn ?? []) {
    const target = byId.get(dep);
    if (!target) {
      blockers.push({ dep, status: "missing", reason: "dependency peer is not in the registry" });
      continue;
    }
    const status = target.integrationStatus ?? "pending";
    if (status !== "merged") {
      blockers.push({ dep, status, reason: "dependency has not been merged" });
    }
  }
  return { ok: blockers.length === 0, blockers };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/mergeOrder.test.ts` → PASS (4 tests)

- [ ] **Step 6: Persist at spawn + gate integration**

`src/peerManager.ts` — in `spawnPeer`, validate + persist. After the `sizing` block (near peerManager.ts:52) add:

```ts
  const dependsOn = options.dependsOn?.filter(Boolean);
  if (dependsOn?.length) {
    for (const dep of dependsOn) {
      if (!getPeer(dep)) throw new Error(`--depends-on: no peer matching ${dep}`);
    }
  }
```

(`getPeer` comes from `./store.js`; add to the existing import if absent.) Then add `dependsOn,` to the `const peer: PeerRecord = { ... }` literal (after `codexConfig: options.codexConfig,`).

`src/peerIntegration.ts` — in `integratePeer(peerId)` (line ~100), after the existing `classifyForIntegration` refusal and before pushing, add:

```ts
  const order = validateMergeOrder(peer, readState().peers);
  if (!order.ok) {
    throw new IntegratePeerRefusedError(
      `merge-order: ${order.blockers.map((b) => `${b.dep} is ${b.status}`).join(", ")}. ` +
        `Merge dependencies first (delamain merge-state), or spawn without --depends-on.`,
    );
  }
```

Imports: `import { validateMergeOrder } from "./mergeOrder.js";` and `readState` from `./store.js`. If `IntegratePeerRefusedError`'s constructor differs (check its definition near peerIntegration.ts:59), match its existing signature — tests/peerIntegration.test.mjs imports it, so the class exists.

`src/cli.ts` — in the `spawn` case, add to the `spawnPeer({...})` argument object:

```ts
        dependsOn: flagString(args, "depends-on")?.split(",").map((s) => s.trim()).filter(Boolean),
```

and extend the spawn usage string with ` [--depends-on <peer-id,peer-id>]`.

- [ ] **Step 7: Typecheck, integration smoke, commit**

Run: `npm run check` → clean.
Run: `npm run build && node --test tests/peerIntegration.test.mjs` → existing integrate tests still PASS (no `dependsOn` set ⇒ gate is a no-op).

```bash
git add src/types.ts src/mergeOrder.ts src/mergeOrder.test.ts src/peerManager.ts src/peerIntegration.ts src/cli.ts
git commit -m "feat(integration): dependsOn + merge-order gate refusing integrate before deps merge"
```

---

### Task 3: Stale sweep + archive writer

**Files:**
- Modify: `src/paths.ts` (archivePath)
- Create: `src/sweep.ts`
- Create: `src/sweep.test.ts`
- Modify: `src/cli.ts` (new case + help line)

- [ ] **Step 1: Add the archive path**

`src/paths.ts`, alongside `statePath()`:

```ts
export function archivePath(): string {
  return join(peersHome(), "state.archive.json");
}
```

(`join` is already imported there.)

- [ ] **Step 2: Write the failing test**

Create `src/sweep.test.ts`. `peersHome()` reads `$DELAMAIN_HOME` per call, so pointing the env at a temp dir isolates state:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepPeers } from "./sweep.js";
import { archivePath } from "./paths.js";
import { readState, writeState } from "./store.js";
import type { PeerRecord } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-12T00:00:00.000Z");

function peer(id: string, overrides: Partial<PeerRecord>): PeerRecord {
  return {
    id,
    repo: "/tmp/x",
    task: "t",
    status: "done",
    startedAt: new Date(NOW - 30 * DAY).toISOString(),
    updatedAt: new Date(NOW - 30 * DAY).toISOString(),
    logPath: "/tmp/x.log",
    ...overrides,
  } as PeerRecord;
}

describe("sweepPeers", () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "delamain-sweep-"));
    savedHome = process.env.DELAMAIN_HOME;
    process.env.DELAMAIN_HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.DELAMAIN_HOME;
    else process.env.DELAMAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("archives terminal peers older than the cutoff and keeps the rest", () => {
    const old = peer("old00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    const fresh = peer("fresh000", { status: "done", finishedAt: new Date(NOW - 1 * DAY).toISOString() });
    const running = peer("run00000", { status: "working", updatedAt: new Date(NOW - 10 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [old, fresh, running] });

    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    expect(result.archived.map((p) => p.id)).toEqual(["old00000"]);
    expect(readState().peers.map((p) => p.id).sort()).toEqual(["fresh000", "run00000"]);
    const archive = JSON.parse(readFileSync(archivePath(), "utf8"));
    expect(archive.peers.map((p: PeerRecord) => p.id)).toEqual(["old00000"]);
  });

  it("marks dead-pid stale non-terminal peers failed (does not archive them yet)", () => {
    const zombie = peer("zomb0000", {
      status: "working",
      runnerPid: 999999999,
      lastHeartbeatAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [zombie] });

    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7 });

    expect(result.markedDead.map((p) => p.id)).toEqual(["zomb0000"]);
    const after = readState().peers[0];
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/swept/i);
  });

  it("dry-run changes nothing", () => {
    const old = peer("old00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [old] });
    const result = sweepPeers({ nowMs: NOW, olderThanDays: 7, dryRun: true });
    expect(result.archived.map((p) => p.id)).toEqual(["old00000"]);
    expect(readState().peers).toHaveLength(1);
  });

  it("appends to an existing archive instead of clobbering it", () => {
    const first = peer("one00000", { status: "done", finishedAt: new Date(NOW - 10 * DAY).toISOString() });
    const second = peer("two00000", { status: "killed", finishedAt: new Date(NOW - 9 * DAY).toISOString() });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [first] });
    sweepPeers({ nowMs: NOW, olderThanDays: 7 });
    writeState({ version: 1, updatedAt: new Date(NOW).toISOString(), peers: [second] });
    sweepPeers({ nowMs: NOW, olderThanDays: 7 });
    const archive = JSON.parse(readFileSync(archivePath(), "utf8"));
    expect(archive.peers.map((p: PeerRecord) => p.id)).toEqual(["one00000", "two00000"]);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/sweep.test.ts`
Expected: FAIL — `Cannot find module './sweep.js'`

If instead it fails because `peersHome()` caches the env value at module load, adapt `paths.ts` is NOT the fix — check how `src/stateLock.test.ts` isolates state (it spawns subprocesses with env). If `peersHome()` truly resolves per call (it should — it is a function), the env swap in beforeEach is sufficient.

- [ ] **Step 4: Implement `src/sweep.ts`**

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { archivePath } from "./paths.js";
import { readStateFile, withStateLock, writeState } from "./store.js";
import type { PeerRecord, PeerState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Non-terminal peer with a dead pid and no heartbeat for this long => failed.
const DEAD_AFTER_MS = 6 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(["done", "failed", "killed"]);

export type SweepOptions = {
  nowMs?: number;
  olderThanDays?: number;
  dryRun?: boolean;
};

export type SweepResult = {
  archived: PeerRecord[];
  markedDead: PeerRecord[];
  kept: number;
};

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lastSeenMs(peer: PeerRecord): number {
  const stamp = peer.lastHeartbeatAt ?? peer.finishedAt ?? peer.updatedAt;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : 0;
}

function anyPidAlive(peer: PeerRecord): boolean {
  return pidAlive(peer.runnerPid) || pidAlive(peer.codexPid) || pidAlive(peer.enginePid);
}

function appendToArchive(peers: PeerRecord[]): void {
  const target = archivePath();
  let archive: PeerState = { version: 1, updatedAt: new Date().toISOString(), peers: [] };
  if (existsSync(target)) {
    try {
      const parsed = JSON.parse(readFileSync(target, "utf8")) as PeerState;
      if (Array.isArray(parsed.peers)) archive = parsed;
    } catch {
      // Corrupt archive: keep it aside rather than destroy history.
      renameSync(target, `${target}.corrupt-${Date.now()}`);
    }
  }
  archive.peers.push(...peers);
  archive.updatedAt = new Date().toISOString();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  renameSync(tmp, target);
}

/**
 * Citadel core/coordination/sweep.js pattern, adapted: (1) terminal peers older
 * than the cutoff move to state.archive.json; (2) non-terminal peers whose pids
 * are all dead and whose heartbeat is stale get marked failed (archived on the
 * NEXT sweep once they age past the cutoff).
 */
export function sweepPeers(options: SweepOptions = {}): SweepResult {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - (options.olderThanDays ?? 7) * DAY_MS;

  return withStateLock(() => {
    const state = readStateFile();
    const archived: PeerRecord[] = [];
    const markedDead: PeerRecord[] = [];
    const kept: PeerRecord[] = [];

    for (const peer of state.peers) {
      const terminal = TERMINAL_STATUSES.has(peer.status);
      if (terminal && lastSeenMs(peer) < cutoffMs) {
        archived.push(peer);
        continue;
      }
      if (!terminal && !anyPidAlive(peer) && nowMs - lastSeenMs(peer) > DEAD_AFTER_MS) {
        const dead: PeerRecord = {
          ...peer,
          status: "failed",
          error: `swept: no live pids and no heartbeat since ${peer.lastHeartbeatAt ?? peer.updatedAt}`,
          finishedAt: peer.finishedAt ?? new Date(nowMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        };
        markedDead.push(dead);
        kept.push(dead);
        continue;
      }
      kept.push(peer);
    }

    if (!options.dryRun) {
      if (archived.length) appendToArchive(archived);
      if (archived.length || markedDead.length) {
        writeState({ ...state, peers: kept });
      }
    }
    return { archived, markedDead, kept: kept.length };
  });
}
```

Note: `status: "failed"` must be a valid `PeerStatus` member — check `src/types.ts:3`; if the union spells it differently (e.g. `"error"`), use the existing spelling and adjust the test.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/sweep.test.ts` → PASS (4 tests)
Run: `npm run check` → clean

- [ ] **Step 6: Wire the CLI**

`src/cli.ts`:

```ts
import { sweepPeers } from "./sweep.js";
```

```ts
    case "sweep": {
      const args = parseFlags(argv);
      const olderThan = flagString(args, "older-than");
      const result = sweepPeers({
        olderThanDays: olderThan ? Number(olderThan) : undefined,
        dryRun: Boolean(args["dry-run"]),
      });
      console.log(JSON.stringify({
        archived: result.archived.map((p) => p.id),
        markedDead: result.markedDead.map((p) => p.id),
        kept: result.kept,
        dryRun: Boolean(args["dry-run"]),
      }, null, 2));
      return;
    }
```

(If `parseFlags` represents boolean flags differently, mirror how `--yolo` is read via `bypassEnabled` and follow that mechanism.) Help line: `  delamain sweep [--dry-run] [--older-than <days>]   Archive old terminal peers, fail zombie peers`

- [ ] **Step 7: Manual dry-run + commit**

Run: `npm run build && node dist/index.js sweep --dry-run` against real state — eyeball the ids before ever running it for real.

```bash
git add src/paths.ts src/sweep.ts src/sweep.test.ts src/cli.ts
git commit -m "feat(sweep): stale-peer sweep with state.archive.json writer and dead-pid detection"
```

---

### Task 4: Path-prefix claims + spawn pre-flight

**Files:**
- Modify: `src/types.ts` (PeerRecord + SpawnPeerOptions)
- Create: `src/claims.ts`
- Create: `src/claims.test.ts`
- Modify: `src/peerManager.ts` (pre-flight in spawnPeer)
- Modify: `src/cli.ts` (`--claims`, `--claims-override`)

- [ ] **Step 1: Add the fields**

`src/types.ts` — `PeerRecord` (after `dependsOn`):

```ts
  // Citadel-adoption: repo-relative path prefixes this peer intends to write.
  // Suffix ":ro" marks a read-only claim (never conflicts). Enforced at spawn.
  claims?: string[];
```

`SpawnPeerOptions`: add `claims?: string[];` and `claimsOverride?: boolean;`

- [ ] **Step 2: Write the failing test**

Create `src/claims.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { claimsOverlap, findClaimConflicts, normalizeClaim } from "./claims.js";
import type { PeerRecord } from "./types.js";

function activePeer(id: string, claims: string[], status = "working"): PeerRecord {
  return { id, repo: "/tmp/x", task: "t", status, startedAt: "", updatedAt: "", logPath: "", claims } as PeerRecord;
}

describe("normalizeClaim", () => {
  it("strips leading ./ and trailing slashes, detects :ro", () => {
    expect(normalizeClaim("./src/api/")).toEqual({ path: "src/api", readOnly: false });
    expect(normalizeClaim("docs:ro")).toEqual({ path: "docs", readOnly: true });
  });
});

describe("claimsOverlap", () => {
  it("parent/child overlap, siblings do not", () => {
    expect(claimsOverlap("src/api", "src/api/users")).toBe(true);
    expect(claimsOverlap("src/api/users", "src/api")).toBe(true);
    expect(claimsOverlap("src/api", "src/apiV2")).toBe(false);
    expect(claimsOverlap("src/api", "src/web")).toBe(false);
  });
});

describe("findClaimConflicts", () => {
  const peers = [
    activePeer("aaa", ["src/api"]),
    activePeer("bbb", ["src/web:ro"]),
    activePeer("ccc", ["src/db"], "done"), // terminal: never conflicts
  ];

  it("flags write-claim overlap with an active peer", () => {
    const conflicts = findClaimConflicts(["src/api/users"], peers);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ peerId: "aaa", theirs: "src/api", ours: "src/api/users" });
  });

  it("read-only claims never conflict (either side)", () => {
    expect(findClaimConflicts(["src/web"], peers)).toHaveLength(0);
    expect(findClaimConflicts(["src/api:ro"], peers)).toHaveLength(0);
  });

  it("terminal peers' claims are ignored", () => {
    expect(findClaimConflicts(["src/db"], peers)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/claims.test.ts`
Expected: FAIL — `Cannot find module './claims.js'`

- [ ] **Step 4: Implement `src/claims.ts`**

```ts
import type { PeerRecord } from "./types.js";

export type Claim = { path: string; readOnly: boolean };
export type ClaimConflict = { peerId: string; theirs: string; ours: string };

const TERMINAL = new Set(["done", "failed", "killed"]);

export function normalizeClaim(raw: string): Claim {
  let path = raw.trim();
  const readOnly = path.endsWith(":ro");
  if (readOnly) path = path.slice(0, -3);
  path = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return { path, readOnly };
}

/** Prefix overlap on path-segment boundaries: src/api ~ src/api/users, not src/apiV2. */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(`${shorter}/`);
}

/**
 * Citadel core/coordination/claims.js pattern: write-claims of ACTIVE peers are
 * exclusive by path prefix; read-only claims never conflict.
 */
export function findClaimConflicts(requested: string[], peers: PeerRecord[]): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  const ours = requested.map(normalizeClaim).filter((c) => !c.readOnly);
  for (const peer of peers) {
    if (TERMINAL.has(peer.status)) continue;
    for (const theirRaw of peer.claims ?? []) {
      const theirs = normalizeClaim(theirRaw);
      if (theirs.readOnly) continue;
      for (const our of ours) {
        if (claimsOverlap(our.path, theirs.path)) {
          conflicts.push({ peerId: peer.id, theirs: theirs.path, ours: our.path });
        }
      }
    }
  }
  return conflicts;
}
```

Same `PeerStatus` caveat as Task 3: match the terminal spellings actually in `src/types.ts:3`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/claims.test.ts` → PASS (6 tests)

- [ ] **Step 6: Spawn pre-flight + CLI flag**

`src/peerManager.ts`, in `spawnPeer` next to the sizing pre-flight (this is the shared chokepoint for CLI, MCP `spawn_peer`, and gsd spawns):

```ts
  const claims = options.claims?.filter(Boolean);
  if (claims?.length && !options.claimsOverride) {
    const conflicts = findClaimConflicts(claims, readState().peers);
    if (conflicts.length) {
      const detail = conflicts.map((c) => `${c.ours} overlaps ${c.theirs} (peer ${c.peerId})`).join("; ");
      throw new Error(`Claim conflict: ${detail}. Pass claimsOverride/--claims-override to spawn anyway.`);
    }
  }
```

Imports: `findClaimConflicts` from `./claims.js`, `readState` from `./store.js` (check existing imports first). Add `claims,` to the `const peer: PeerRecord = { ... }` literal.

`src/cli.ts` spawn case:

```ts
        claims: flagString(args, "claims")?.split(",").map((s) => s.trim()).filter(Boolean),
        claimsOverride: Boolean(args["claims-override"]),
```

(again mirroring the repo's boolean-flag mechanism), and extend the usage string with ` [--claims <path,path:ro>] [--claims-override]`.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run check` → clean. `npx vitest run src/claims.test.ts src/mergeOrder.test.ts` → PASS.

```bash
git add src/types.ts src/claims.ts src/claims.test.ts src/peerManager.ts src/cli.ts
git commit -m "feat(claims): path-prefix write claims with spawn pre-flight collision check"
```

---

### Task 5: Wave/readiness views (`delamain waves`)

**Files:**
- Create: `src/waves.ts`
- Create: `src/waves.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing test**

Create `src/waves.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wavesView } from "./waves.js";
import type { PeerRecord } from "./types.js";

function peer(id: string, over: Partial<PeerRecord>): PeerRecord {
  return { id, repo: "/tmp/x", task: `task ${id}`, status: "working", startedAt: "", updatedAt: "", logPath: "", ...over } as PeerRecord;
}

describe("wavesView", () => {
  it("buckets peers into running / awaiting-integration / merge-ready / merge-blocked / merged", () => {
    const a = peer("aaa", { status: "done", integrationStatus: "merged" });
    const b = peer("bbb", { status: "done", integrationStatus: "pushed" }); // no deps: merge-ready
    const c = peer("ccc", { status: "done", integrationStatus: "pushed", dependsOn: ["bbb"] }); // blocked on bbb
    const d = peer("ddd", { status: "working" });
    const e = peer("eee", { status: "done", integrationStatus: "pending" });

    const view = wavesView([a, b, c, d, e]);

    expect(view.running.map((p) => p.id)).toEqual(["ddd"]);
    expect(view.awaitingIntegration.map((p) => p.id)).toEqual(["eee"]);
    expect(view.mergeReady.map((p) => p.id)).toEqual(["bbb"]);
    expect(view.mergeBlocked.map((x) => x.peer.id)).toEqual(["ccc"]);
    expect(view.mergeBlocked[0].blockers[0].dep).toBe("bbb");
    expect(view.merged.map((p) => p.id)).toEqual(["aaa"]);
  });

  it("reports claim conflicts among running peers", () => {
    const p1 = peer("aaa", { claims: ["src/api"] });
    const p2 = peer("bbb", { claims: ["src/api/users"] });
    const view = wavesView([p1, p2]);
    expect(view.claimConflicts).toHaveLength(1);
    expect(view.claimConflicts[0]).toMatchObject({ a: "aaa", b: "bbb" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/waves.test.ts`
Expected: FAIL — `Cannot find module './waves.js'`

- [ ] **Step 3: Implement `src/waves.ts`**

```ts
import { claimsOverlap, normalizeClaim } from "./claims.js";
import { validateMergeOrder, type MergeOrderBlocker } from "./mergeOrder.js";
import type { PeerRecord } from "./types.js";

export type WavesView = {
  running: PeerRecord[];
  awaitingIntegration: PeerRecord[];
  mergeReady: PeerRecord[];
  mergeBlocked: { peer: PeerRecord; blockers: MergeOrderBlocker[] }[];
  merged: PeerRecord[];
  claimConflicts: { a: string; b: string; ours: string; theirs: string }[];
};

const TERMINAL = new Set(["done", "failed", "killed"]);

/** Pure fleet-state view (Citadel core/fleet/session.js readiness pattern). */
export function wavesView(peers: PeerRecord[]): WavesView {
  const view: WavesView = {
    running: [],
    awaitingIntegration: [],
    mergeReady: [],
    mergeBlocked: [],
    merged: [],
    claimConflicts: [],
  };

  for (const peer of peers) {
    if (peer.integrationStatus === "merged") {
      view.merged.push(peer);
    } else if (peer.integrationStatus === "pushed") {
      const order = validateMergeOrder(peer, peers);
      if (order.ok) view.mergeReady.push(peer);
      else view.mergeBlocked.push({ peer, blockers: order.blockers });
    } else if (TERMINAL.has(peer.status)) {
      view.awaitingIntegration.push(peer);
    } else {
      view.running.push(peer);
    }
  }

  const active = peers.filter((p) => !TERMINAL.has(p.status));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      for (const oursRaw of active[i].claims ?? []) {
        const ours = normalizeClaim(oursRaw);
        if (ours.readOnly) continue;
        for (const theirsRaw of active[j].claims ?? []) {
          const theirs = normalizeClaim(theirsRaw);
          if (theirs.readOnly) continue;
          if (claimsOverlap(ours.path, theirs.path)) {
            view.claimConflicts.push({ a: active[i].id, b: active[j].id, ours: ours.path, theirs: theirs.path });
          }
        }
      }
    }
  }
  return view;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/waves.test.ts` → PASS (2 tests)

- [ ] **Step 5: Wire the CLI**

`src/cli.ts`:

```ts
import { wavesView } from "./waves.js";
```

```ts
    case "waves": {
      const view = wavesView(listPeers());
      console.log(JSON.stringify({
        running: view.running.map((p) => ({ id: p.id, task: p.task })),
        awaitingIntegration: view.awaitingIntegration.map((p) => ({ id: p.id, task: p.task })),
        mergeReady: view.mergeReady.map((p) => ({ id: p.id, pr: p.integrationPrUrl })),
        mergeBlocked: view.mergeBlocked.map((x) => ({ id: x.peer.id, blockers: x.blockers })),
        merged: view.merged.map((p) => ({ id: p.id, sha: p.integrationMergeCommitSha })),
        claimConflicts: view.claimConflicts,
      }, null, 2));
      return;
    }
```

Help line: `  delamain waves   Fleet readiness: running / merge-ready / merge-blocked / conflicts`

- [ ] **Step 6: Typecheck + commit**

Run: `npm run check` → clean.

```bash
git add src/waves.ts src/waves.test.ts src/cli.ts
git commit -m "feat(waves): fleet readiness view (merge-ready/blocked, claim conflicts)"
```

---

### Task 6: Cost metering (`delamain cost`)

**Files:**
- Create: `src/pricing.ts`
- Create: `src/peerCost.ts`
- Create: `src/peerCost.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing test**

Create `src/peerCost.test.ts` (pure parsing + pricing; no filesystem):

```ts
import { describe, expect, it } from "vitest";
import { costUsd, parseSessionTotals } from "./peerCost.js";

const LINES = [
  JSON.stringify({ timestamp: "t1", type: "session_meta", payload: { id: "s" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 } } } }),
  JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 33005, cached_input_tokens: 9984, output_tokens: 223 } } } }),
].join("\n");

describe("parseSessionTotals", () => {
  it("returns the LAST cumulative token_count", () => {
    expect(parseSessionTotals(LINES)).toEqual({ input: 33005, cached: 9984, output: 223 });
  });

  it("returns undefined when no token_count events exist", () => {
    expect(parseSessionTotals('{"type":"session_meta","payload":{}}')).toBeUndefined();
  });

  it("skips malformed lines", () => {
    expect(parseSessionTotals(`not-json\n${LINES}`)).toEqual({ input: 33005, cached: 9984, output: 223 });
  });
});

describe("costUsd", () => {
  it("prices uncached input, cached input, and output separately", () => {
    // gpt-5.5 assumed rates: 1.25/M in, 0.125/M cached, 10/M out
    const usd = costUsd({ input: 1_000_000 + 400_000, cached: 400_000, output: 100_000 }, "gpt-5.5");
    // (1.0M uncached * 1.25) + (0.4M * 0.125) + (0.1M * 10) = 1.25 + 0.05 + 1.0
    expect(usd).toBeCloseTo(2.3, 5);
  });

  it("falls back to default pricing for unknown models", () => {
    expect(costUsd({ input: 1_000_000, cached: 0, output: 0 }, "mystery-model")).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/peerCost.test.ts`
Expected: FAIL — `Cannot find module './peerCost.js'`

- [ ] **Step 3: Implement `src/pricing.ts`**

Versioned, dated, source-attributed table (Citadel `pricing.json` pattern; rates are OPERATOR-MAINTAINED assumptions — peers run on ChatGPT-subscription OAuth, so these produce *notional API-equivalent* dollars, not billed dollars):

```ts
export type ModelPricing = {
  inputPerM: number;   // USD per 1M uncached input tokens
  cachedPerM: number;  // USD per 1M cached input tokens
  outputPerM: number;  // USD per 1M output tokens
};

export const PRICING_VERSION = "2026-07-12";
export const PRICING_NOTE =
  "Notional GPT-5-class API-equivalent rates for subscription-billed codex peers. Update deliberately; dollars here are comparative, not invoiced.";

const TABLE: Record<string, ModelPricing> = {
  "gpt-5.5": { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 },
  "gpt-5.4": { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 },
  "gpt-5.4-mini": { inputPerM: 0.25, cachedPerM: 0.025, outputPerM: 2 },
};

const DEFAULT: ModelPricing = { inputPerM: 1.25, cachedPerM: 0.125, outputPerM: 10 };

export function priceFor(model: string | undefined): ModelPricing {
  if (model && TABLE[model]) return TABLE[model];
  // Prefix match: "gpt-5.5-codex" -> "gpt-5.5".
  for (const key of Object.keys(TABLE)) {
    if (model?.startsWith(key)) return TABLE[key];
  }
  return DEFAULT;
}
```

- [ ] **Step 4: Implement `src/peerCost.ts`**

```ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codexContext.js";
import { peersHome } from "./paths.js";
import { priceFor } from "./pricing.js";
import type { PeerRecord } from "./types.js";

export type TokenTotals = { input: number; cached: number; output: number };

/** Last cumulative token_count in a codex rollout JSONL. Pure. */
export function parseSessionTotals(text: string): TokenTotals | undefined {
  let totals: TokenTotals | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(line);
      const usage = entry?.payload?.info?.total_token_usage;
      if (usage && typeof usage.input_tokens === "number") {
        totals = {
          input: usage.input_tokens ?? 0,
          cached: usage.cached_input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
        };
      }
    } catch {
      // skip malformed line
    }
  }
  return totals;
}

export function costUsd(totals: TokenTotals, model: string | undefined): number {
  const p = priceFor(model);
  return (
    ((totals.input - totals.cached) / 1e6) * p.inputPerM +
    (totals.cached / 1e6) * p.cachedPerM +
    (totals.output / 1e6) * p.outputPerM
  );
}

function sessionRoots(): string[] {
  // Peers run with CODEX_HOME=~/.delamain/peer-codex-home (runner.ts); the
  // supervisor process does not, so check the peer home first, then fall back.
  return [join(peersHome(), "peer-codex-home", "sessions"), join(codexHome(), "sessions")];
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkJsonl(full, out);
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Find the rollout file for a peer by threadId filename suffix. */
export function findRolloutFile(threadId: string): string | undefined {
  for (const root of sessionRoots()) {
    const match = walkJsonl(root).find((f) => f.includes(threadId));
    if (match) return match;
  }
  return undefined;
}

export type PeerCost = {
  id: string;
  model?: string;
  totals?: TokenTotals;
  usd?: number;
  rolloutFile?: string;
};

export function readPeerCost(peer: PeerRecord): PeerCost {
  if (!peer.threadId) return { id: peer.id, model: peer.model };
  const rolloutFile = findRolloutFile(peer.threadId);
  if (!rolloutFile) return { id: peer.id, model: peer.model };
  const totals = parseSessionTotals(readFileSync(rolloutFile, "utf8"));
  if (!totals) return { id: peer.id, model: peer.model, rolloutFile };
  return { id: peer.id, model: peer.model, totals, usd: costUsd(totals, peer.model), rolloutFile };
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/peerCost.test.ts` → PASS (5 tests)
Run: `npm run check` → clean
(If `codexHome` is not exported from `codexContext.ts` — it is, line 42 — the fallback root can be `join(homedir(), ".codex", "sessions")` instead.)

- [ ] **Step 6: Wire the CLI**

`src/cli.ts`:

```ts
import { readPeerCost } from "./peerCost.js";
```

```ts
    case "cost": {
      const peerId = argv[0];
      const targets = peerId
        ? [getPeer(peerId) ?? (() => { throw new Error(`No peer matching ${peerId}`); })()]
        : listPeers();
      const rows = targets.map((p) => readPeerCost(p));
      const total = rows.reduce((sum, r) => sum + (r.usd ?? 0), 0);
      console.log(JSON.stringify({ peers: rows, totalUsd: Math.round(total * 100) / 100 }, null, 2));
      return;
    }
```

Help line: `  delamain cost [peer-id]   Notional token cost per peer from codex rollout logs`

- [ ] **Step 7: Manual check against real data + commit**

Run: `npm run build && node dist/index.js cost` — peers with live threadIds should show totals consistent with `~/.delamain/peer-codex-home/sessions` contents.

```bash
git add src/pricing.ts src/peerCost.ts src/peerCost.test.ts src/cli.ts
git commit -m "feat(cost): per-peer notional cost from codex rollout token_count + pricing table"
```

---

### Task 7: Full-suite verification

- [ ] **Step 1: Everything green**

Run: `npm run check` → clean
Run: `npx vitest run src/` → all unit tests PASS (new: mergeState, mergeOrder, sweep, claims, waves, peerCost — plus pre-existing)
Run: `npm test` → build + `node --test tests/*.test.mjs` PASS (integration suites untouched; the merge-order gate is inert without `dependsOn`)

- [ ] **Step 2: Commit any stragglers, push branch, open PR to `main`**

```bash
git push -u origin <feature-branch>
gh pr create --repo Ecko95/delamain --base main --title "feat: Citadel adoptions — merged state, merge-order gate, sweep, claims, waves, cost" --body "Implements .codex/plans/20260712-citadel-adoptions.md"
```

---

## Non-goals (explicit)

- **No MCP tool exposure** for the new commands in this plan — GITS's DelamainCliAdapter shells the `delamain` binary, so CLI cases are sufficient. Add MCP tools in a follow-up if peers themselves need these views.
- **No auto-sweep daemon** — `sweep` stays an explicit command (GITS's scheduler can invoke it nightly later). peerInbox.ts:36's "no sweep daemon" stance is preserved.
- **No enforcement of claims at the filesystem level** — claims are a pre-dispatch collision check (Citadel's is advisory too); bwrap confinement remains the hard boundary.
- **No Citadel code copied** — patterns only; all implementations above are original and delamain-idiomatic.

## GITS tie-in (why these five)

`merged`-state + `waves` gives GITS's automode a truthful merge ledger (fixes the 2/187 merge-sha measurement gap found 2026-07-12); `dependsOn` + merge-order gating is what the overnight brief queue needs for multi-brief nights; `sweep` keeps state.json sane for an unattended system; `claims` prevents two overnight peers colliding in one repo; `cost` is the v1.5 "peer dollar metering" item from the off-hours autonomy design (docs/brainstorms/off-hours-autonomy.md in gitscode).
