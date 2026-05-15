# ComposioHQ/agent-orchestrator Deep Dive

## 1. Overview

ComposioHQ's `agent-orchestrator` is a TypeScript monorepo for coordinating parallel coding agents in isolated git worktrees. The public repo is MIT licensed, owned by ComposioHQ, and the snapshot I inspected was last pushed on 2026-05-15.

What it does:

- Spawns one session per task, usually in its own worktree and branch
- Routes agent feedback loops for CI failures, review comments, and merge conflicts
- Keeps a dashboard and CLI in sync with session state, PR state, and workspace state

Stack:

- TypeScript, pnpm workspace monorepo
- Node 20+
- Next.js dashboard/web API
- Core library plus plugin packages for runtime, agent, workspace, tracker, SCM, notifier, and terminal slots

Supported agents in the inspected snapshot:

- Claude Code
- Codex
- Cursor
- Aider
- OpenCode

I did not find a Gemini adapter or any `gemini`-named plugin/path in the inspected tree, so Gemini support is not present in this snapshot.

## 2. Architecture

The system is split into a small number of core services plus plugin implementations.

Key files:

- `packages/core/src/types.ts` defines the plugin slot model, `Session`, `SessionManager`, `LifecycleManager`, and `PluginRegistry`
- `packages/core/src/session-manager.ts` owns spawn/list/get/kill/restore/send/cleanup, including orchestrator spawning
- `packages/core/src/lifecycle-manager.ts` polls sessions, detects state transitions, and triggers reactions
- `packages/core/src/plugin-registry.ts` loads built-in plugins and external plugins from config
- `packages/core/src/agent-selection.ts` resolves which agent to use for a given session role
- `packages/cli/src/lib/create-session-manager.ts` wires config + registry into the core session manager and lifecycle manager
- `packages/cli/src/lib/project-supervisor.ts` keeps lifecycle workers attached only for projects that actually have non-terminal sessions
- `packages/web/src/app/api/orchestrators/route.ts` is the dashboard/API entrypoint for listing and spawning orchestrators
- `packages/plugins/workspace-worktree/src/index.ts` is the worktree manager

The main flow is:

1. Config is loaded and validated.
2. The plugin registry loads built-ins and any configured external plugins.
3. The session manager creates either worker sessions or a deterministic orchestrator session.
4. The lifecycle manager polls sessions, updates status, and dispatches reactions.
5. The project supervisor starts or stops lifecycle workers as projects appear and disappear.

Small code anchors:

```ts
return createSessionManager({ config, registry });
```

```ts
await ensureLifecycleWorker(config, projectId, options.intervalMs);
```

```ts
const branch = `orchestrator/${sessionId}`;
```

Orchestrator sessions get a fixed ID of the form `projectPrefix-orchestrator`, a dedicated worktree branch, and a file-backed system prompt. Worker sessions are numbered and use the configured agent/plugin for the project or spawn override.

Worktree management is centralized in `packages/plugins/workspace-worktree/src/index.ts`. That plugin can create, destroy, restore, and adopt existing worktrees instead of blindly recreating them.

```ts
await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
```

## 3. Multi-engine abstraction

This repo does not use a fixed `engine` enum. It uses a plugin registry plus per-role agent selection.

Observed dispatch model:

- `resolveAgentSelection(...)` picks an agent name from persisted session data, spawn overrides, project config, role defaults, and global defaults
- `registry.get("agent", name)` resolves that name to an `Agent` plugin instance
- Each agent plugin owns its own launch command, environment, activity detection, and resume behavior

The built-in registry includes at least these agent names:

```ts
{ slot: "agent", name: "codex", pkg: "@aoagents/ao-plugin-agent-codex" },
```

The inspected docs and tree show explicit support for Claude Code, Codex, Cursor, Aider, and OpenCode. I found no Gemini adapter in the current branch, so any Gemini support would need to be added as a new agent plugin and then registered through the same mechanism.

Comparison to our local `src/types.ts`:

```ts
export type PeerEngine = "codex" | "cursor";
if (next.engine === undefined) next = { ...next, engine: "codex" };
```

Our current design is much narrower: the engine choice is just a typed flag on peer records, with codex as the default. Composio's model is more extensible because the agent choice is a plugin identity, not a closed enum. The practical difference is that their launch path can vary by plugin behavior, not just by a launch string switch.

## 4. CI-failure remediation loop

CI recovery is handled as a reaction on top of the lifecycle manager's polling loop.

Relevant files:

- `packages/core/src/config.ts`
- `packages/core/src/lifecycle-manager.ts`
- `website/content/docs/guides/ci-recovery.mdx`
- `packages/plugins/scm-github/src/index.ts` and `packages/plugins/scm-gitlab/src/index.ts` for the PR/check data source

The default reaction config is:

```ts
"ci-failed": { auto: true, action: "send-to-agent", retries: 2, escalateAfter: 2 },
```

Mechanism:

1. The SCM plugin reports failing checks for the PR.
2. The lifecycle manager transitions the session to `ci_failed`.
3. `executeReaction()` sends the initial nudge to the agent.
4. `maybeDispatchCIFailureDetails()` fetches the failing checks, fingerprints them, dedupes repeated failures, and sends a detailed follow-up.
5. If the reaction keeps failing until the retry budget is exhausted, the reaction escalates to a human notifier.

The key implementation detail is that the detailed follow-up does not consume the retry budget:

```ts
if (ciFingerprint === lastCIDispatchHash) return;
await sessionManager.send(session.id, detailedMessage);
```

The lifecycle manager intentionally bypasses `executeReaction()` for the detailed CI payload. That keeps the reaction's retry/escalation budget reserved for the actual remediation attempts, not for the informational follow-up.

The doc page `website/content/docs/guides/ci-recovery.mdx` describes the same two-step flow: a first agent nudge on transition, then a richer follow-up on the next poll cycle.

## 5. Conflict-resolution agent

There is no separate conflict-resolution binary. Conflict resolution is a reaction that reuses the same agent session.

Relevant files:

- `packages/core/src/config.ts`
- `packages/core/src/lifecycle-manager.ts`
- `website/content/docs/guides/review-loop.mdx`

Default reaction config:

```ts
"merge-conflicts": { auto: true, action: "send-to-agent" },
```

Behavior:

1. Merge conflicts are detected from PR mergeability data.
2. `maybeDispatchMergeConflicts()` only runs for open PRs.
3. It consults the batch PR enrichment cache first, so it can avoid redundant API calls.
4. If conflicts exist, it calls `executeReaction(session, "merge-conflicts", enrichedConfig)`.
5. The session metadata records that the conflict incident was already dispatched.
6. When conflicts clear, the dedupe flag and reaction tracker are reset so a future conflict starts fresh.

The helper is explicitly independent of the session status, which matters because conflicts can coexist with CI failures and review comments.

```ts
const conflictReactionKey = "merge-conflicts";
```

The user-facing prompt is generated dynamically from the base branch and mergeability state, so the agent gets a concrete rebase/resolve instruction instead of a generic warning.

## 6. Features worth porting to codex-mcp-peers-server

| feature | LOC estimate to port | dependencies needed | risk |
|---|---:|---|---|
| Fingerprinted CI-failure follow-up loop with retry budget separation | 150-250 | PR/check polling, per-peer metadata, `send` path, notifier integration | High |
| Merge-conflict reaction with dedupe and reset-on-resolution | 80-130 | PR mergeability checks, per-peer incident state, status polling | Medium-high |
| Worktree adoption and stale-path recovery | 90-140 | `git worktree`, branch naming, safe cleanup, path checks | Medium |
| Role-aware adapter registry instead of a closed engine enum | 60-110 | adapter interface, launch/resume hooks, activity detection hooks | Medium |
| Project supervisor that reconciles workers against configured projects | 60-100 | session listing, lifecycle worker process management | Medium |
| Automatic metadata capture via hooks/wrappers | 100-180 | `gh`/`git` wrappers, agent-specific launch hooks, PATH injection | Medium |

Notes:

- LOC estimates are incremental port size, not rewrite size.
- The CI and merge-conflict loops are the highest leverage items for this repo because they directly replace manual babysitting.
- The adapter registry is only worth porting if we expect more engines than the current `codex`/`cursor` pair.

## 7. Anti-patterns / things to avoid

- Do not port the whole monorepo architecture just to get the reaction loop; the plugin system is broader than this repo needs today.
- Do not collapse CI follow-up messages into the same retry budget as the initial reaction. Composio splits them on purpose.
- Do not treat merge conflicts as a status-only event. They need their own incident state and dedupe key.
- Do not blindly delete worktrees that are still registered with git. The upstream worktree plugin explicitly guards against that.
- Do not assume Gemini support exists in the inspected snapshot.
- Do not rely on absolute `gh` or `git` paths if you want wrapper-based metadata capture; that bypasses the interception layer.

## 8. Recommendation

**Inspire, do not port wholesale.**

The most valuable ideas here for `codex-mcp-peers-server` are the remediation loops and the worktree recovery logic. Those map cleanly onto our current peer model and would improve reliability without forcing us to absorb Composio's entire plugin ecosystem. The broader agent-registry design is useful if we expect more engines later, but with only `codex` and `cursor` today, a full plugin abstraction would be extra surface area. The right cut is to borrow the incident handling, dedupe/fingerprint strategy, and safe worktree lifecycle, then keep our engine model simple until we actually need more adapters.

## Sources

- https://github.com/ComposioHQ/agent-orchestrator
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/README.md
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/package.json
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/README.md
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/types.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/plugin-registry.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/agent-selection.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/session-manager.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/lifecycle-manager.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/core/src/config.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/plugins/workspace-worktree/src/index.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/plugins/agent-claude-code/src/index.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/plugins/agent-codex/src/index.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/plugins/agent-cursor/src/index.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/cli/src/lib/create-session-manager.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/cli/src/lib/project-supervisor.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/packages/web/src/app/api/orchestrators/route.ts
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/website/content/docs/guides/ci-recovery.mdx
- https://github.com/ComposioHQ/agent-orchestrator/blob/main/website/content/docs/guides/review-loop.mdx
