# Overstory Research

Target: [jayminwest/overstory](https://github.com/jayminwest/overstory)

## Overview

Overstory is a TypeScript/Bun CLI for multi-agent coding orchestration. It runs workers in isolated git worktrees, coordinates them through a SQLite-backed mail system, and merges branches with a FIFO queue plus tiered conflict resolution. The package is [`@os-eco/overstory-cli`](https://www.npmjs.com/package/@os-eco/overstory-cli), ships as an MIT-licensed Bun CLI, and also includes a web UI under `ui/`.

Stack notes:
- Language/runtime: TypeScript on Bun.
- Database layer: `bun:sqlite` for synchronous local state.
- Process model: git worktrees plus `Bun.spawn`-driven runtime adapters.
- License: MIT.

## SQLite mail bus

### Schema

The mail bus lives in `.overstory/mail.db` and is defined in [`src/mail/store.ts`](https://github.com/jayminwest/overstory/blob/main/src/mail/store.ts). The `messages` table stores:

- `id`
- `from_agent`
- `to_agent`
- `subject`
- `body`
- `type`
- `priority`
- `thread_id`
- `payload`
- `read`
- `created_at`

Two indexes support the common queries:

- inbox lookup: `to_agent, read`
- thread lookup: `thread_id`

Schema management is explicit. `createMailStore()` enables WAL mode, sets `synchronous = NORMAL`, and applies a 5s busy timeout. `migrateSchema()` handles table rebuilds when message types change and a narrow `ALTER TABLE ... ADD COLUMN payload` path when only payload is missing.

Short code pointer:

```ts
db.exec("PRAGMA journal_mode = WAL");
```

### Message flow

The bus has a low-level store and a higher-level client:

- [`src/mail/store.ts`](https://github.com/jayminwest/overstory/blob/main/src/mail/store.ts): inserts, unread queries, read markers, thread lookup, purge, close.
- [`src/mail/client.ts`](https://github.com/jayminwest/overstory/blob/main/src/mail/client.ts): send, typed protocol send, reply, list, check, and hook-format injection.
- [`src/commands/mail.ts`](https://github.com/jayminwest/overstory/blob/main/src/commands/mail.ts): CLI entry point for send/check/list/read/reply, plus broadcast recipient resolution.
- [`src/commands/serve/mail-actions.ts`](https://github.com/jayminwest/overstory/blob/main/src/commands/serve/mail-actions.ts): REST-side helpers that reuse the same mail client.
- [`src/agents/headless-mail-injector.ts`](https://github.com/jayminwest/overstory/blob/main/src/agents/headless-mail-injector.ts): polls unread mail and injects it into a new turn or a persistent headless process.

The flow is simple:

1. A sender calls `send()` or `sendProtocol()`, which inserts one row.
2. `check()` or `checkInject()` reads unread rows for the recipient and marks them read.
3. Headless agents batch unread rows into a synthetic user turn and feed it to the runtime.
4. Broadcast addresses such as `@all` and `@builders` fan out to multiple rows in `sendMail()`.

Short code pointer:

```ts
const messages = store.getUnread(agentName);
```

### Pros vs file-based logs

Pros:

- Concurrent readers with a single writer via WAL.
- Indexed queries for inbox, threads, and filters.
- Durable unread/read semantics without parsing log files.
- Native support for structured protocol payloads and reply threading.
- Cleaner UI and API reads than grepping append-only logs.

Tradeoffs versus file-based logs:

- More schema and migration code.
- Less human-readable than append-only text.
- Requires SQLite lifecycle management and lock handling.
- Adds a dependency boundary around one local database file.

## FIFO merge queue

The merge queue is in [`src/merge/queue.ts`](https://github.com/jayminwest/overstory/blob/main/src/merge/queue.ts) and persists to `.overstory/merge-queue.db`. The table holds:

- `id` as `INTEGER PRIMARY KEY AUTOINCREMENT`
- `branch_name`
- `task_id`
- `agent_name`
- `files_modified` as JSON text
- `enqueued_at`
- `status`
- `resolved_tier`

The queue enforces FIFO ordering by `id ASC`. `dequeue()` returns the first pending row and deletes it. `peek()` reads the same row without removing it. `list("pending")` is what `ov merge --all` consumes.

Serialization is not only the queue itself. [`src/commands/merge.ts`](https://github.com/jayminwest/overstory/blob/main/src/commands/merge.ts) acquires a branch-specific file lock via [`src/merge/lock.ts`](https://github.com/jayminwest/overstory/blob/main/src/merge/lock.ts), then iterates pending entries sequentially:

```ts
for (const entry of pendingEntries) {
```

That gives Overstory two layers of ordering:

- queue order across N concurrent peers
- exclusive merge execution per canonical target branch

In practice, peers can enqueue independently, but only one merge loop drains the queue at a time, and the drain is strict FIFO.

## 4-tier conflict resolver

The resolver is in [`src/merge/resolver.ts`](https://github.com/jayminwest/overstory/blob/main/src/merge/resolver.ts). It escalates from cheapest to most expensive:

### Tier 1: clean merge

Attempts `git merge --no-edit <branch>`. If this succeeds, the branch is merged and committed without any file-level intervention.

Cost/latency: lowest. Usually just local git work, so sub-second to a couple seconds.

### Tier 2: auto-resolve

If the merge conflicts, Overstory parses conflict markers and keeps the incoming agent side. Before doing that, it checks whether the canonical side has content; if so, it skips auto-resolve to avoid silently discarding canonical data. It also honors `merge=union` gitattributes by concatenating both sides instead of dropping one.

Cost/latency: low. Mostly local file reads/writes plus `git add`/`git commit`.

### Tier 3: AI-resolve

If tier 2 fails, Overstory asks a runtime adapter to print a resolved file. The prompt includes historical conflict context from Mulch when available. Output is validated so the model must return code-like content, not prose.

Cost/latency: medium to high. Dominated by model runtime latency and token spend.

### Tier 4: re-imagine

If AI resolution still fails and the tier is enabled, Overstory aborts the merge and reimplements the branch changes from scratch on top of the canonical branch. It reads both canonical and branch versions per modified file, then asks the model to produce a final file body.

Cost/latency: highest. This is the most expensive path because it is effectively a second synthesis pass, not just conflict repair.

Short code pointer:

```ts
const cleanResult = await tryCleanMerge(entry, repoRoot);
```

### History feedback

The resolver records successful or failed conflict patterns into Mulch, then uses those historical patterns to:

- skip tiers that repeatedly fail on the same files
- enrich the AI prompt with past successful resolutions
- predict which files are likely to conflict in dry runs

That makes the resolver adaptive rather than fixed.

## Comparison to `codex-peers` `integratePeerWorktree`

The local implementation in [`src/git.ts`](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/199c63c4/src/git.ts#L86-L106) is much simpler. The main path is:

1. commit the peer worktree if it has changes
2. fetch the base branch from origin
3. merge `origin/<baseBranch>` into the peer worktree
4. push `HEAD` back to `origin/<baseBranch>`

Short code pointer:

```ts
mergeOriginBranch(worktreePath, baseBranch);
pushHeadToOriginBranch(worktreePath, baseBranch);
```

Gap analysis:

- Tier 1 would slot directly into the existing `mergeOriginBranch()` step.
- Tier 2 would sit immediately after a failed merge and before the final push.
- Tier 3 would replace the current hard failure path with a model-assisted repair pass.
- Tier 4 does not have a clean slot in the current code; it would require a broader re-synthesis workflow, not just a merge helper.

What Overstory has that `integratePeerWorktree()` does not:

- persisted merge job state
- ordering across multiple peers
- conflict history and prediction
- tier-aware resolution telemetry
- branch-specific merge locking

## Cost-of-implementation

| Feature | LOC | deps (sqlite needed?) | risk |
|---|---:|---|---|
| SQLite mail bus | ~650-850 | Yes | Medium |
| FIFO merge queue | ~250-400 | Yes | Low-medium |
| 4-tier conflict resolver | ~700-1,000 | No for core logic; yes if you want persistent history/telemetry | High |
| Compare/port to `integratePeerWorktree()` only | ~40-120 | No | Low |

Estimates are based on the size of the main implementation files and their surrounding command wiring, not a literal clone of Overstory's exact dependency graph.

## Recommendation

Port the ideas, not the whole stack.

My recommendation for `codex-peers` is:

- Keep the current git-first merge flow as the default.
- Borrow the tiered conflict strategy if you expect frequent merge conflicts from generated code.
- Add a queue only if you need durable cross-process ordering and replayable merge state.
- Do not add SQLite just to support `integratePeerWorktree()` itself.

Why not add SQLite here:

- `integratePeerWorktree()` is a short, synchronous, repo-local operation.
- SQLite adds schema, migration, lock, and maintenance overhead.
- The current need is branch integration, not inbox search, threading, or UI state.
- A file lock plus a small JSON queue is usually enough unless you need Overstory-style observability.

If the goal is to make `codex-peers` behave more like Overstory, the right adoption sequence is:

1. add a minimal merge queue
2. add tier 1 and tier 2 conflict handling
3. only then consider AI-assisted repair and persistence

## Sources

- Overstory repo root: <https://github.com/jayminwest/overstory>
- README and package metadata: <https://github.com/jayminwest/overstory/blob/main/README.md>, <https://github.com/jayminwest/overstory/blob/main/package.json>
- Mail store: <https://github.com/jayminwest/overstory/blob/main/src/mail/store.ts>
- Mail client: <https://github.com/jayminwest/overstory/blob/main/src/mail/client.ts>
- Broadcast resolution: <https://github.com/jayminwest/overstory/blob/main/src/mail/broadcast.ts>
- CLI mail commands: <https://github.com/jayminwest/overstory/blob/main/src/commands/mail.ts>
- REST mail actions: <https://github.com/jayminwest/overstory/blob/main/src/commands/serve/mail-actions.ts>
- Headless mail injector: <https://github.com/jayminwest/overstory/blob/main/src/agents/headless-mail-injector.ts>
- Merge queue: <https://github.com/jayminwest/overstory/blob/main/src/merge/queue.ts>
- Merge command: <https://github.com/jayminwest/overstory/blob/main/src/commands/merge.ts>
- Merge lock: <https://github.com/jayminwest/overstory/blob/main/src/merge/lock.ts>
- Merge resolver: <https://github.com/jayminwest/overstory/blob/main/src/merge/resolver.ts>
- Local comparison file: [/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/199c63c4/src/git.ts](/home/user/.codex-peers/worktrees/codex-mcp-peers-server-cursor-engine-0b05b10a3e0b/199c63c4/src/git.ts)
