# GSD v1 Research

## Project Purpose + History

Get Shit Done v1 started as TÂCHES' prompt-driven system for turning Claude Code into a spec-driven development workflow: question the user, research the domain, write requirements, plan, execute, verify, ship, and preserve the project memory in files instead of in chat history. The public repository was created on `2025-12-14T14:17:12Z`, and the codebase is MIT-licensed JavaScript with a Node `>=22` runtime, small shell glue, generated CommonJS adapters, and the `@anthropic-ai/claude-agent-sdk` plus `ws` as the main runtime dependencies. The repository's visible release line had reached `v1.19.1` by mid-February 2026 and `v1.42.1` / `v1.43.0-rc1` by mid-May 2026, so v1 evolved for months before the v2 split.

- Origin: a lightweight meta-prompting and context-engineering system for Claude Code first, then broadened to OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, and others.
- Start date: GitHub repository created `2025-12-14`.
- Stack: JavaScript-first CLI package, Node 22+, markdown command/workflow/agent definitions, generated CJS modules, shell hooks, and optional binaries such as `fallow`.
- License: MIT.
- Activity peak: the sampled commit window is heavily concentrated on `2026-05-13` through `2026-05-15`, with the densest burst on `2026-05-15` around release prep, state refactors, and hook/installer fixes.

## Architecture

v1 is a layered, file-backed orchestration system.

- Command layer: `commands/gsd/*.md` are the user entry points. They are installed as slash commands, Codex skills, or runtime-specific spellings such as Gemini's `gsd:` namespace.
- Workflow layer: `get-shit-done/workflows/*.md` are the thin orchestrators. They load context, spawn agents, collect results, and advance state, but avoid doing the heavy lifting themselves.
- Agent layer: `agents/gsd-*.md` defines specialized subagents for research, planning, execution, verification, review, debugging, docs, security, UI, and profiling. The orchestrator resolves a model, spawns a fresh context window, and hands the task to the agent.
- State layer: `.planning/` is the project memory. The core files are `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, and `config.json`, with phase, research, milestone, workstream, graph, and todo subtrees hanging off that root.
- CLI layer: `get-shit-done/bin/gsd-tools.cjs` plus the modules in `get-shit-done/bin/lib/` own the actual parsing, projection, and mutation logic for state, roadmap, config, verification, templates, milestone handling, docs, workstreams, and security.
- Hook layer: runtime hooks integrate with the host agent environment for statusline, context warnings, injection scanning, update checks, commit validation, phase boundaries, and other guardrails.

The phase model is the core product model:

- `new-project` gathers vision and produces the initial planning set.
- `discuss-phase` captures ambiguous implementation decisions before planning.
- `plan-phase` turns research and discussion into executable plans and verification criteria.
- `execute-phase` runs plans in parallel waves and commits results atomically.
- `verify-work` performs human acceptance testing and feeds failures back into a fix loop.
- `ship` and `complete-milestone` close the phase and milestone, then `new-milestone` starts the next cycle.

The state model is markdown-first but not markdown-naive:

- `STATE.md` has both frontmatter and body sections.
- The canonical body fields include `Current Phase`, `Current Plan`, `Status`, `Last activity`, `Progress`, `Total Plans in Phase`, `Total Phases`, and the `## Current Position` section.
- `state.cjs` rebuilds frontmatter from disk ground truth, synchronizes body fields, and uses lockfiles for read-modify-write safety.
- `state-document.generated.cjs` is a pure text-transform module that extracts, replaces, normalizes, and computes progress fields without touching the filesystem.
- `complete-phase` has an idempotency guard because re-running it on an already completed phase used to roll STATE.md backward.

The supervisor/agent model is explicit:

- Orchestrators load context, resolve models, spawn agents, gather outputs, and then update state.
- Researchers often run in parallel, planners and checkers run sequentially, executors fan out in waves, and verifiers close the loop.
- The design goal is to keep the main chat context small while moving work into fresh agent contexts.

The hook system is the runtime glue:

- `gsd-statusline.js` renders model/task/directory/context state.
- `gsd-context-monitor.js` warns when remaining context gets low.
- `gsd-check-update.js` and its worker handle background version checks.
- `gsd-prompt-guard.js`, `gsd-read-injection-scanner.js`, and `gsd-read-guard.js` reduce prompt-injection and unsafe-write risk.
- `gsd-session-state.sh`, `gsd-validate-commit.sh`, and `gsd-phase-boundary.sh` record session and workflow state.

## Command Surface

This is the full v1 command roster from the inventory doc, paraphrased from the shipped frontmatter descriptions.

### Namespace Meta-Skills

- `/gsd-workflow` routes phase-pipeline tasks such as discuss, plan, execute, verify, phase, and progress.
- `/gsd-project` routes project-lifecycle tasks such as milestones, audits, and summary generation.
- `/gsd-quality` routes quality-gate tasks such as code review, debug, audit, security, eval, and UI checks.
- `/gsd-context` routes codebase-intelligence tasks such as map, graphify, docs, and learnings.
- `/gsd-manage` routes management tasks such as config, workspace, workstreams, thread, update, ship, and inbox.
- `/gsd-ideate` routes exploration and capture tasks such as explore, sketch, spike, spec, and capture.

### Core Workflow

- `/gsd-new-project` bootstraps a project and writes the core planning artifacts.
- `/gsd-workspace` creates, lists, or removes isolated workspaces with independent planning state.
- `/gsd-discuss-phase` gathers phase context through adaptive questioning before planning.
- `/gsd-mvp-phase` reframes a phase as a vertical MVP slice before planning.
- `/gsd-spec-phase` turns a fuzzy idea into a falsifiable SPEC.md.
- `/gsd-ui-phase` generates a UI design contract for frontend phases.
- `/gsd-ai-integration-phase` generates an AI design contract from framework selection, research, and eval planning.
- `/gsd-plan-phase` creates a detailed phase plan with a verification loop.
- `/gsd-plan-review-convergence` iterates plan/review/replan until high-severity concerns are gone or the cycle cap is hit.
- `/gsd-ultraplan-phase` offloads planning to Claude Code's ultraplan cloud and imports the result back.
- `/gsd-spike` runs throwaway feasibility experiments.
- `/gsd-sketch` runs throwaway UI/design mockups.
- `/gsd-execute-phase` executes all plans in a phase with wave-based parallelization.
- `/gsd-verify-work` performs conversational UAT and auto-diagnosis.
- `/gsd-ship` creates the PR and prepares verified work for merge.
- `/gsd-fast` executes trivial work inline with no subagents or planning overhead.
- `/gsd-quick` keeps GSD guarantees but skips optional agents for short tasks.
- `/gsd-ui-review` performs retroactive visual audit of implemented frontend code.
- `/gsd-code-review` reviews source changes and can auto-fix findings.
- `/gsd-eval-review` audits evaluation coverage for an executed AI phase.

### Phase & Milestone Management

- `/gsd-phase` adds, inserts, removes, or edits phases in ROADMAP.md.
- `/gsd-add-tests` generates tests for a completed phase from UAT criteria and implementation.
- `/gsd-validate-phase` fills Nyquist validation gaps after a phase is done.
- `/gsd-secure-phase` audits a completed phase for threat mitigations.
- `/gsd-audit-milestone` checks milestone completion against the original intent.
- `/gsd-audit-uat` audits outstanding UAT and verification items across phases.
- `/gsd-audit-fix` runs an autonomous audit-to-fix pipeline.
- `/gsd-complete-milestone` archives a shipped milestone and prepares the next version.
- `/gsd-new-milestone` starts a new milestone cycle from project context.
- `/gsd-milestone-summary` synthesizes a milestone-level project summary.
- `/gsd-cleanup` archives accumulated phase directories from completed milestones.
- `/gsd-manager` opens an interactive command center for managing multiple phases.
- `/gsd-workstreams` manages parallel workstreams across list/create/switch/status/progress/complete/resume operations.
- `/gsd-autonomous` runs remaining phases autonomously, discuss through execute.
- `/gsd-undo` performs safe git revert flows using the phase manifest.

### Session & Navigation

- `/gsd-progress` shows project progress and can auto-route to the next action.
- `/gsd-capture` records ideas, tasks, notes, seeds, or pending todos.
- `/gsd-stats` displays project statistics such as phases, plans, requirements, and git metrics.
- `/gsd-pause-work` creates a structured handoff when pausing mid-phase.
- `/gsd-resume-work` restores a prior session from saved context.
- `/gsd-explore` performs Socratic ideation before a decision is locked in.
- `/gsd-review-backlog` reviews backlog items and promotes relevant ones.
- `/gsd-thread` manages persistent cross-session context threads.

### Codebase Intelligence

- `/gsd-map-codebase` runs parallel mapper agents to generate codebase intelligence docs.
- `/gsd-graphify` builds, queries, and inspects the project knowledge graph.
- `/gsd-extract-learnings` pulls decisions, lessons, patterns, and surprises from finished artifacts.

### Review, Debug & Recovery

- `/gsd-review` requests cross-AI plan review from external CLIs.
- `/gsd-debug` performs systematic debugging with persistent state across context resets.
- `/gsd-forensics` investigates failed workflows using git, artifacts, and state.
- `/gsd-health` diagnoses planning-directory health and can repair common issues.
- `/gsd-import` ingests external plans and checks them against existing project decisions.
- `/gsd-inbox` triages open GitHub issues and PRs against project templates.

### Docs, Profile & Utilities

- `/gsd-docs-update` generates or updates verified project documentation.
- `/gsd-ingest-docs` classifies mixed ADR/PRD/SPEC/DOC corpora and bootstraps planning context.
- `/gsd-profile-user` builds a behavioral profile and user-facing preferences artifacts.
- `/gsd-settings` configures workflow toggles and model profile.
- `/gsd-config` configures workflow toggles, advanced knobs, integrations, or the model profile.
- `/gsd-pr-branch` creates a clean PR branch without `.planning/` commits.
- `/gsd-surface` toggles which skills are surfaced at runtime without reinstalling.
- `/gsd-update` updates GSD and can sync skills or reapply local patches.
- `/gsd-help` prints the command reference and usage guide.

## Strengths

- The system solves the real failure mode it names: context rot.
- The work is split into small, fresh agent contexts instead of one long brittle chat.
- The persistent artifacts are human-readable and inspectable, so the workflow survives session resets.
- The phase loop is explicit and disciplined: research, discuss, plan, execute, verify, ship.
- Parallel execution is first-class, but guarded by wave dependencies and post-wave checks.
- Atomic commits per task give clean history and easier rollback.
- The command surface is broad enough to support research, planning, execution, review, recovery, and docs without leaving the GSD model.
- The inventory/parity approach is pragmatic: the docs and tests continuously check that the shipped surface matches the filesystem.

## Limitations / Pain Points

- The markdown/state model is powerful but brittle. Bugs around `STATE.md` formatting, phase-ID padding, and body/frontmatter synchronization repeatedly needed fixes.
- `complete-phase` was not originally idempotent; reruns could roll state backward and clobber the current position.
- The agent and workflow files grew large enough to hit runtime size limits, which forced modular decomposition of the planner and related docs.
- Command, hook, and docs drift became a maintenance burden, which is why the inventory file and parity tests exist.
- Cross-runtime support introduced a long tail of platform issues: Windows hook syntax, Codex/Gemini differences, and runtime-specific command spelling.
- Worktree isolation was imperfect in practice; shared stash storage and other git-state interactions leaked between agent worktrees.
- The prompt/markdown interface is vulnerable to accidental parsing mistakes, such as quoting or frontmatter edge cases.
- The README itself acknowledges that returning to GSD often requires re-indexing the codebase and rebuilding planning context, which is a polite way of saying the system still needs rehydration after context loss.
- Recent commits and issue titles show a lot of effort spent on state drift, hook safety, parsing robustness, and token-budget control rather than pure product features.

## What Was Carried Into v2 vs Replaced

This is a best-effort inference from v1 plus a skim of the v2 README, not a deep v2 audit.

- Likely carried into v2: the GSD workflow vocabulary, the phase/slice lifecycle, research → plan → execute → verify discipline, and the idea that agents should run with task-specific context instead of one giant session.
- Likely carried into v2: command parity for many v1 surfaces, at least as a migration target.
- Likely carried into v2: the emphasis on automation, recovery, and clean handoff artifacts.
- Likely replaced in v2: the slash-command-only prompt framework and the largely file-projection-driven control plane.
- Likely replaced in v2: `.planning` as the primary state substrate, because v2's README points to `.gsd`, DB-backed memory, and a standalone CLI built on the Pi SDK.
- Likely replaced in v2: the old "ask the LLM to do it" posture, because v2 claims direct harness access, task-ready context injection, git branch management, token/cost tracking, crash recovery, and auto-advance as first-class engine behavior.
- Likely replaced in v2: some of the v1 file-parsing fragility, because v2's README frames the project as a real coding agent with stronger control-plane primitives.

## Lessons Applicable to a Peer-Driven GSD Flow

- Keep the orchestration thin and push real work into short-lived, specialized workers.
- Make state explicit and durable, but keep the state format simple enough that humans can inspect and repair it.
- Treat state synchronization as a first-class subsystem, not a side effect.
- Build parity checks and inventories early, because a large command surface will drift without them.
- Plan for idempotence on every boundary command; reruns are normal in agent systems.
- Budget for runtime limits on prompt and agent file size; decomposition is not optional once the surface grows.
- Keep execution parallel where safe, but enforce dependency waves and post-wave verification.
- Make cross-runtime differences explicit in the architecture instead of relying on one runtime's behavior to generalize.
- Assume the file system is both your transport and your failure surface.
- Preserve clean git history, but do not let git state primitives such as stash or branch switching leak across isolated worker contexts.
- Favor generated, shared logic for canonical transforms, and keep thin adapters per runtime or per side where necessary.

## Sources

- Repository metadata and commit history: `https://github.com/gsd-build/get-shit-done`
- README: `https://github.com/gsd-build/get-shit-done/blob/main/README.md`
- Architecture: `https://github.com/gsd-build/get-shit-done/blob/main/docs/ARCHITECTURE.md`
- Command inventory: `https://github.com/gsd-build/get-shit-done/blob/main/docs/INVENTORY.md`
- Command reference: `https://github.com/gsd-build/get-shit-done/blob/main/docs/COMMANDS.md`
- Configuration reference: `https://github.com/gsd-build/get-shit-done/blob/main/docs/CONFIGURATION.md`
- State engine: `https://github.com/gsd-build/get-shit-done/blob/main/get-shit-done/bin/lib/state.cjs`
- State document module: `https://github.com/gsd-build/get-shit-done/blob/main/get-shit-done/bin/lib/state-document.generated.cjs`
- Package metadata: `https://github.com/gsd-build/get-shit-done/blob/main/package.json`
- Recent commits sample: `https://api.github.com/repos/gsd-build/get-shit-done/commits?per_page=30`
- v2 skim: `https://github.com/gsd-build/gsd-2/blob/main/README.md`
