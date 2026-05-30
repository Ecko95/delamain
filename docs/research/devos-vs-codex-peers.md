# devOS vs codex-peers

This comparison is about product direction, not just code shape. devOS is a phase-driven Tauri desktop app with a Rust daemon and a broad operator UI. codex-peers is a Node/TypeScript MCP server and peer supervisor that spawns headless Codex/Cursor workers in isolated worktrees.

## 1. devOS overview

devOS is a Rust + Tauri v2 + React application that acts as a cockpit on top of GSD. The repo README describes it as a "developer-focused agent orchestration cockpit" that supervises GSD sessions, opens tmux sessions, and exposes verification gates as UI cards (README.md:1-12). The workspace is Rust-first on the backend with a React/Vite frontend, Zustand state, and Tauri command plumbing (README.md:14-69, Cargo.toml:1-35, package.json:1-31, src-tauri/Cargo.toml:1-43).

Current versioning is phase-based rather than semver-based. The roadmap says v7.0 "Autonomous UAT" is the current milestone, with Phase 26 complete and Phases 27-28 still ahead (ROADMAP.md:50-63). The latest five phase docs show the current arc clearly: Phase 22 added worktree isolation, Phase 23 added the gsd-browser daemon adapter, Phase 24 defined UAT recipes, Phase 25 wired auto-UAT into verification gates, and Phase 26 added visual-diff baseline management (ROADMAP.md:54-63, 22-RESEARCH.md:7-16, 23-CONTEXT.md:8-13, 24-CONTEXT.md:8-13, 25-CONTEXT.md:8-13, 26-CONTEXT.md:7-13).

License: no LICENSE file is present in the devOS repo root, and package.json does not declare one. Treat it as effectively unlicensed until the owner says otherwise.

Last-30-day activity is very high. `git log --since='30 days ago'` shows 366 commits, concentrated on 2026-05-02 through 2026-05-10, with the biggest bursts on 2026-05-02, 2026-05-03, and 2026-05-04. The recent commits are mostly phase execution, UAT, browser integration, and baseline-management work, not exploratory churn.

What problem it is solving: a local operator cockpit for dispatching and observing GSD sessions, including remote machine control, browser-based verification, UAT evidence, and baseline review. The roadmap explicitly frames v7.0 as closing the "manual eyeballing of localhost" gap with gsd-browser, recipes, screenshots, and visual diffs (ROADMAP.md:50-63, REQUIREMENTS.md:35-71).

Small code anchor:

```tsx
case "baselines":
  return <BaselineManagement />;
```

That one line captures the current center of gravity: devOS is already a UI-heavy verification console, not just a backend.

## 2. codex-peers overview

codex-peers is a TypeScript MCP server plus peer supervisor. The README says it spawns and supervises headless Codex peers across repositories, with MCP tools, detached peer runners, linked worktree isolation, automatic integration, a dashboard, and a tmux status line (README.md:1-13, 49-103, 124-201). The package is MIT licensed and shipped as `codex-peers` with Node 20+ support (LICENSE:1-21, package.json:1-43).

The current implementation is centered on peer lifecycle and orchestration. `PeerEngine` is already a closed enum with `codex` and `cursor` values, and `normalizePeerRecord()` defaults older records to `codex` (src/types.ts:22-98). `peerManager.ts` spawns peers in isolated linked worktrees, records logs, and supports `spawnGsdPhaseBatch()` for phase-oriented runs (src/peerManager.ts:28-142). `runner.ts` dispatches either Codex or Cursor, and `peerIntegration.ts` explicitly commits, merges, and pushes completed peer worktrees (src/runner.ts:27-265, src/cursorRunner.ts:80-307, src/peerIntegration.ts:1-260).

The roadmap doc is unusually direct about the target shape: codex-peers wants to become "a self-hosted, multi-engine, GSD-aware peer spawner", with a solid execution substrate already in place but missing coordination, workflow shape, daemonization, and operational hardening (docs/IMPLEMENTATION-PLAN.md:10-25). It also explicitly recommends a thin adapter for GSD wire compatibility and a daemon boundary for remote hosting (docs/IMPLEMENTATION-PLAN.md:29-49).

Current version/phase: semver is still `0.1.0`, and the repo has no formal phase system like devOS. The nearest active work tracks are the phase-33 GSD batch runner and phase-37 frozen-eligibility gate, both visible in the source comments and recent commits (`e8ab0ed`, `343293a`, `247956b`, `3bd5cd1`, `057493d`).

Last-30-day activity: 69 commits, concentrated on 2026-05-06 through 2026-05-15. The recent burst includes cursor-engine support, GSD phase batching, frozen-mode gating, milestone inspection, peer integration, and the frozen-batch eligibility checker.

What problem it is solving: a control plane for spawning, supervising, resuming, killing, and integrating autonomous coding peers, including multi-engine execution and GSD-style phase batches. This is the closest match to "autonomous peer-spawning supervisor with multi-engine + GSD-like flow + self-hosted on i5/8GB Ubuntu" in the implementation plan.

Small code anchor:

```ts
export type PeerEngine = "codex" | "cursor";
```

That line is the core product boundary. codex-peers is a supervisor with a small, explicit engine surface, not a full UI system.

## 3. Feature matrix

| Feature | devOS | codex-peers | overlap? |
|---|---|---|---|
| Primary product shape | Tauri desktop cockpit + Rust daemon | MCP server + headless peer supervisor | Partial |
| UI surface | Broad React UI, companion SPA, phase screens | Lightweight dashboard/OpenTUI, CLI, MCP | Partial |
| Workflow model | Phase system, UAT recipes, baseline review, browser verification | Peer spawn/resume/kill, GSD phase batches, frozen eligibility | Partial |
| Engine support | GSD session/dispatch focused; no peer engine enum | `codex` + `cursor` engine enum | Low |
| Worktree isolation | Yes, but as part of a larger dispatch/browser system | Yes, central primitive | Yes |
| Remote/daemon boundary | Yes, Rust daemon, REST, auth, SSE, companion | Not yet a daemon boundary; MCP in-process + CLI | Low |
| Browser/UAT | Strong: gsd-browser adapter, UAT runner, baselines, smoke plan | None yet, outside frozen gate checks | No |
| Baseline management | Yes, Phase 26 complete | No | No |
| Multi-engine orchestration | Limited to GSD dispatch and browser-adjacent flows | Yes, current `codex`/`cursor` support | Low |
| GSD-like flow | Deep, phase-driven, milestone/slice/task oriented | Emerging, batch/frozen phases and protocol alignment | Partial |
| Integration flow | Human verification and UAT evidence, not peer merge | Automatic commit/merge/push for completed peers | No |
| Self-hosted i5/8GB path | Not the primary design center | Explicitly planned in implementation roadmap | Low |
| Test surface | Rust unit/integration plus frontend build checks | Node test suite + frozen-gate tests + integration tests | Partial |

## 4. Architectural philosophy

devOS is a local OS-style operator console. It assumes a user sitting at a machine, looking at a UI, watching phases, browser evidence, resource metrics, and baseline diffs. Even though it has a daemon, the product value is the cockpit: the frontend, the gated workflows, the verification artifacts, and the human decision surfaces.

codex-peers is the opposite end of the stack. It is a control plane for running other agents headlessly, with the MCP interface as the primary API and the dashboard as a secondary observer. Its core design question is not "how do I present this to a human?" but "how do I spawn, supervise, recover, and integrate autonomous peers safely?"

That divergence matters. devOS is UI-first with an embedded agent host. codex-peers is orchestration-first with a minimal operator surface. One is the cockpit, the other is the supervisor.

## 5. Strengths of devOS

- It already has the browser verification stack that codex-peers lacks: gsd-browser integration, UAT recipes, UAT result rendering, and screenshot/baseline workflows.
- It has a much richer operator UI. The current app includes Feed, Terminal, Checkpoints, Templates, Scheduler, Settings, Analytics, and now Baseline Management.
- Its phase system is disciplined and explicit. Phases 22-26 show a coherent vertical slice from worktree isolation through browser verification to baseline review.
- It has a daemon and security story already worked through: REST routes, auth, SSE, worktree registries, port registries, and startup reconciliation.
- It is more complete as a product experience. The app is not just an orchestrator, it is an opinionated operations console.

## 6. Strengths of codex-peers

- It directly matches the user's stated goal. The product is literally a peer-spawning supervisor with MCP tools, headless runners, worktree isolation, integration, and logs.
- Multi-engine support is already real, not aspirational. `codex` and `cursor` are both first-class in the type system and runner path.
- The GSD batch and frozen flows are already being wired in. `spawn_gsd_phase_batch`, `inspect_gsd_milestone`, `integrate_peer`, and `classify_frozen_batch` are concrete, goal-aligned building blocks.
- The operational surface is simpler. Node + MCP + CLI is a smaller maintenance envelope than a full Tauri desktop app with Rust daemon, companion SPA, and multiple verification screens.
- The worktree integration logic is explicit and review-safe. Completed peers are committed, merged, and pushed through one intentional path, which is a strong control point for an autonomous system.

## 7. Overlap & wasted effort

- Both projects manage GSD-shaped work, but at different layers. devOS manages phases, recipes, UAT, and visual verification. codex-peers manages peer lifecycles and phase batches.
- Both use git worktrees as a concurrency boundary. That part is converging, which means the two repos are not just adjacent, they are solving the same infrastructure problem from different directions.
- Both have dashboards and status surfaces. devOS is richer; codex-peers is lighter. If both stay alive, you end up maintaining two operator UIs.
- Both have daemon/control-plane instincts. devOS already has a Rust daemon and REST/SSE. codex-peers is heading toward a daemon boundary in the implementation plan. That is duplicated architecture work if both continue as primary products.
- The most expensive duplication is not code volume, it is product direction. You would be deciding twice how phases, tasks, verification, and agent supervision should be modeled.

## 8. Three options analysis

### Option A: Continue codex-peers, stop or park devOS

Gain:

- Keeps the project aligned with the stated goal: autonomous peer-spawning supervisor, multi-engine support, GSD-like flow, and self-hosted deployment.
- Avoids dragging a desktop cockpit and visual-diff stack into a supervisor product that does not need them.
- Lets the current codex-peers work continue to consolidate around one control plane instead of two.

Loss:

- You give up the most polished human-facing UI and the browser/UAT/baseline workflow from devOS.
- You lose a ready-made verification console if you want humans to review rich evidence directly in the same app.

What to migrate:

- Only borrow devOS's verification ideas if the supervisor eventually needs them: browser evidence, screenshot review, and baseline approval. Do not migrate the full Tauri product.
- If you do migrate anything, migrate the smallest useful verification slice, not the entire cockpit.

### Option B: Continue devOS, stop or park codex-peers

Gain:

- You keep the more mature and more visually complete product.
- You preserve the browser/UAT/baseline pipeline and the operator workflows that are already built out.

Loss:

- You lose the project that is actually centered on peer spawning, multi-engine selection, and headless supervision.
- You would have to graft codex-peers' MCP/server/orchestration ideas into a much larger Tauri codebase, which is the wrong direction if the goal is a supervisor first.
- You keep a system that is excellent at supervising GSD sessions, but not a system designed around spawning and integrating autonomous peers.

What to migrate:

- Migrate codex-peers' supervisor primitives if you go this route: spawn, wait, resume, kill, worktree integration, engine selection, GSD batch/frozen gating.
- That is effectively a backend rewrite inside devOS, not a light feature transfer.

### Option C: Continue both, merge specific features one way

If you insist on both, keep the boundary explicit:

- devOS donates browser/UAT/baseline verification ideas.
- codex-peers stays the orchestration backend.

Why this split:

- The supervisor problem belongs in codex-peers.
- The human review and visual evidence problem belongs in devOS.
- The two systems fit like backend and console, not like two competing cores.

LOC estimates:

- devOS -> codex-peers verification slice: about 2,000-3,500 LOC for backend browser/UAT/baseline plumbing, plus another 1,500-3,000 LOC if you want a dedicated UI instead of keeping it in devOS.
- codex-peers -> devOS supervisor slice: about 2,500-4,000 LOC for spawn/wait/resume/kill/integration, multi-engine dispatch, GSD batch, and frozen eligibility, before you even reconcile UI assumptions.
- Net: the cheaper and cleaner merge is to keep codex-peers as the backend supervisor and only borrow the narrow devOS verification pieces that add operator value.

## 9. Recommendation

**Pick A: continue codex-peers and park devOS.**

devOS has the stronger raw momentum if you measure by commit volume and phase completeness. It has 366 commits in the last 30 days, complete work through Phase 26, and a well-fleshed-out UI and browser verification stack. But that momentum is aimed at a different product: a Tauri cockpit for GSD sessions, not a peer-spawning supervisor. Its current work is correct for devOS, but it is not the shortest path to the operator's stated goal.

codex-peers is the better fit for the goal even though it is less mature as a product. The implementation plan already says the execution substrate is solid and the missing pieces are coordination, workflow shape, daemonization, and hardening. The recent work is directly on target: cursor engine support, GSD batch spawning, frozen-mode gating, milestone inspection, and explicit integration. That is the right foundation for an autonomous peer supervisor on a small self-hosted box.

The opportunity cost is the deciding factor. If you keep both as primary efforts, you pay twice for orchestration ideas, twice for worktree lifecycle thinking, and twice for control-plane design. If you make codex-peers the canonical supervisor and park devOS, you get one place where peer lifecycle, multi-engine dispatch, and GSD flow converge. devOS can remain a source of verification and UI patterns later, but it should not remain a second head on the same control plane.

## 10. Decision matrix

| Project | Maturity (1-10) | Fit-to-stated-goal (1-10) | Maintenance cost | Unique value | Recommended next step |
|---|---:|---:|---|---|---|
| devOS | 8 | 5 | High | Full Tauri cockpit, browser UAT, baseline review, remote machine control | Park it as the UI/verification reference, not the core supervisor |
| codex-peers | 6 | 9 | Medium | MCP peer supervisor, multi-engine headless runners, worktree integration, GSD batch/frozen flows | Make it the primary line and harden the supervisor boundary |

## 11. Sources

### devOS files read

- `README.md`
- `Cargo.toml`
- `package.json`
- `src-tauri/Cargo.toml`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/config.json`
- `.planning/phases/22-worktree-devcontainer-session-isolation/22-CONTEXT.md`
- `.planning/phases/22-worktree-devcontainer-session-isolation/22-RESEARCH.md`
- `.planning/phases/22-worktree-devcontainer-session-isolation/22-04-PLAN.md`
- `.planning/phases/22-worktree-devcontainer-session-isolation/22-05-PLAN.md`
- `.planning/phases/23-gsd-browser-daemon-integration/23-CONTEXT.md`
- `.planning/phases/23-gsd-browser-daemon-integration/23-VERIFICATION.md`
- `.planning/phases/24-uat-recipe-format-per-repo-config/24-CONTEXT.md`
- `.planning/phases/24-uat-recipe-format-per-repo-config/24-RESEARCH.md`
- `.planning/phases/25-auto-uat-runner-in-verification-gates/25-CONTEXT.md`
- `.planning/phases/25-auto-uat-runner-in-verification-gates/25-RESEARCH.md`
- `.planning/phases/26-visual-diff-baseline-management-ui/26-CONTEXT.md`
- `.planning/phases/26-visual-diff-baseline-management-ui/26-RESEARCH.md`
- `.planning/phases/26-visual-diff-baseline-management-ui/26-02-PLAN.md`
- `.planning/phases/26-visual-diff-baseline-management-ui/26-02-SUMMARY.md`

### codex-peers files read

- `README.md`
- `LICENSE`
- `package.json`
- `docs/IMPLEMENTATION-PLAN.md`
- `docs/research/gsd-2.md`
- `docs/research/gsd-daemon.md`
- `docs/research/composio-agent-orchestrator.md`
- `src/types.ts`
- `src/peerManager.ts`
- `src/runner.ts`
- `src/cursorRunner.ts`
- `src/mcpServer.ts`
- `src/peerIntegration.ts`
- `src/gsdRunner.ts`
- `src/gsdPhaseList.ts`
- `src/gsdMilestone.ts`
- `src/frozen-eligibility/index.ts`
- `src/frozen-eligibility/eligibility.ts`

### git log and branch evidence

- devOS: `git log --since='30 days ago' --date=short --pretty=format:'%ad %h %s'` returned 366 commits, with activity concentrated between 2026-05-02 and 2026-05-10.
- devOS: recent commits include `dc86655 docs(phase-26): complete phase execution`, `592f1c9 feat(26-02): add BaselineManagement screen with phase groups, diff panels, UAT badge`, and `83116a6 feat(26-01): daemon config extension and REST routes for baseline list/approve/reject`.
- codex-peers: `git log --since='30 days ago' --date=short --pretty=format:'%ad %h %s'` returned 69 commits, with activity concentrated between 2026-05-06 and 2026-05-15.
- codex-peers: recent commits include `3613054 feat(cursor): add cursor-agent peer engine alongside codex`, `e8ab0ed feat(peers): PeerKind discriminator + spawn_gsd_phase_batch MCP tool`, `343293a feat(peers): GSD dynamic-mode runner + STATE.md parser cherry-pick`, `247956b feat(peers): frozen-mode runner - gateFrozenPhase pre-check + halt-on-mismatch`, `3bd5cd1 feat(peers): inspect_gsd_milestone + integrate_peer MCP tools`, and `057493d feat(37-01): classifyFrozenBatch TS module + MCP tool`.
- Branch evidence: devOS has `main` plus feature branches including `feat/cursor-engine`; codex-peers is currently on `codex-peer/0cfed804` with feature work in `feat/cursor-engine`.
