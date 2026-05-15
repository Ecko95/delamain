# GSD-2 Research Deep Dive

This document is a source-backed map of `gsd-build/gsd-2`, focused on the parts that matter for building a peer-spawning supervisor that can follow the same workflow discipline.

## 1. What GSD-2 Is

GSD-2 is a TypeScript agent runtime and workflow system built on the Pi SDK. It is not just a prompt pack. It is a CLI, TUI, web host, MCP server, extension host, and workflow engine that coordinates milestone, slice, and task work with durable state.

Key facts:

- Language and stack: TypeScript on Node 22+, with a Next.js web UI, Pi SDK packages, and optional Rust N-API native engine support.
- License: MIT.
- Maintainers: the `@gsd-build/maintainers` team in `CODEOWNERS`.
- Current version: `3.0.0` in `package.json`, with the latest GitHub release tagged `v3.0.0`.
- Repo purpose: the README describes GSD-2 as the evolution of original Get Shit Done, now a standalone coding agent that can manage context, execution, git branches, cost tracking, stuck-loop detection, and full milestone automation.

Relevant files:

- `README.md`
- `package.json`
- `.github/CODEOWNERS`
- `docs/README.md`
- `docs/dev/architecture.md`

## 2. Workflow / Phase Model

GSD-2 uses a milestone -> slice -> task hierarchy. The human-readable manual bootstrap protocol is in `src/resources/GSD-WORKFLOW.md`, while the runtime loop is documented in `docs/user-docs/auto-mode.md` and implemented in `src/resources/extensions/gsd/auto-dispatch.ts`, `src/resources/extensions/gsd/auto.ts`, and `src/resources/extensions/gsd/auto-prompts.ts`.

The workflow shape is:

1. Discover or bootstrap project state.
2. If planning depth is `deep`, run the staged project interview first: workflow preferences, project discussion, requirements discussion, research decision, and optional project research.
3. For the active milestone, enter `pre-planning` and decide whether to discuss, research, or plan.
4. Move through slice-level research, planning, execution, completion, UAT, and reassessment.
5. Validate the milestone, then complete it and extract learnings.

The core loop in `docs/user-docs/auto-mode.md` is:

- Plan
- Execute
- Complete
- Reassess roadmap
- Next slice
- Validate milestone
- Complete milestone

The dispatch table in `src/resources/extensions/gsd/auto-dispatch.ts` shows the actual state-driven transitions. The important unit types are:

- `workflow-preferences`
- `discuss-project`
- `discuss-requirements`
- `research-decision`
- `research-project`
- `discuss-milestone`
- `research-milestone`
- `plan-milestone`
- `parallel-research-slices`
- `research-slice`
- `plan-slice`
- `refine-slice`
- `execute-task`
- `reactive-execute`
- `complete-slice`
- `run-uat`
- `reassess-roadmap`
- `replan-slice`
- `validate-milestone`
- `complete-milestone`
- `rewrite-docs`

The state machine is not just a sequence of phases. It is rule-driven. Examples from the dispatch table:

- `pre-planning` with no `CONTEXT.md` routes to `discuss-milestone` unless deep mode inserts project-level gates first.
- `pre-planning` with no `RESEARCH.md` routes to `research-milestone` unless research is skipped.
- `planning` can fan out to `parallel-research-slices` when 2 or more slices are ready.
- `planning` falls back to `research-slice` or `plan-slice` depending on whether slice research already exists.
- `refining` becomes `refine-slice` when progressive planning is on, otherwise it degrades to `plan-slice`.
- `executing` dispatches task execution, including the reactive parallel task path when the execution graph allows it.
- `summarizing` dispatches `complete-slice`.
- Post-completion rules can trigger `run-uat` and optionally `reassess-roadmap`.
- `validate-milestone` is the terminal gate before milestone closeout.

The manual file layout that supports the workflow is in `src/resources/GSD-WORKFLOW.md` and `src/resources/extensions/gsd/paths.ts`:

- `PROJECT.md` and `REQUIREMENTS.md` capture deep planning inputs.
- `milestones/M001/M001-ROADMAP.md` is the milestone plan.
- `milestones/M001/M001-CONTEXT.md` is milestone context.
- `milestones/M001/M001-RESEARCH.md` is milestone research.
- `milestones/M001/slices/S01/S01-PLAN.md` is the slice plan.
- `milestones/M001/slices/S01/S01-CONTEXT.md` is slice discussion context.
- `milestones/M001/slices/S01/S01-RESEARCH.md` is slice research.
- `milestones/M001/slices/S01/tasks/T01-PLAN.md` and `T01-SUMMARY.md` hold task-level detail.

Relevant files:

- `src/resources/GSD-WORKFLOW.md`
- `docs/user-docs/auto-mode.md`
- `src/resources/extensions/gsd/auto-dispatch.ts`
- `src/resources/extensions/gsd/auto-prompts.ts`
- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/paths.ts`
- `src/resources/extensions/gsd/state.ts`

## 3. Command Surface

The exhaustive command surface is defined in `docs/user-docs/commands.md`, `src/resources/extensions/gsd/commands/catalog.ts`, and the registered handler tree under `src/resources/extensions/gsd/commands/`.

The table below compresses aliases and related subcommands, but it covers the full surface.

### Session and Dispatch

| Commands | What it does | Inputs | Outputs |
|---|---|---|---|
| `/gsd`, `/gsd next`, `/gsd auto`, `/gsd stop`, `/gsd pause` | Core workflow control. Step mode, autonomous mode, graceful stop, and pause/resume. | Optional `--verbose`, `--debug`, `--dry-run`, `--yolo`, and milestone selectors. | Starts or stops the auto loop, or advances one unit and pauses. |
| `/gsd dispatch research\|plan\|execute\|complete\|reassess\|uat\|replan` | Manually dispatch a specific phase. | Current active milestone and, when needed, active slice or task. | Spawns the matching unit prompt and session. |
| `/gsd quick` | Runs a quick task with GSD guarantees without the full planning ceremony. | Freeform task description. | A short-lived GSD session. |
| `/gsd do <text>` | Natural-language router that forwards to the best matching GSD command. | Freeform text. | A routed command or help message. |
| `/gsd steer <instruction>` | Changes the active work direction while a session is running. | Steering instruction. | Updates the current session guidance. |
| `/gsd capture <text>` | Fire-and-forget thought capture. | Capture text. | Appends capture state for later triage. |
| `/gsd triage` | Classifies pending captures. | No required args. | Routes or resolves pending capture items. |
| `/gsd queue` | Shows and reorders queued milestones. | Optional queue manipulation args. | Queue view or queue mutation. |
| `/gsd skip <unit>` | Prevents a unit from auto-dispatch. | Unit ID such as `M001/S01/T03`. | Marks the unit skipped. |

### Milestone and Slice Lifecycle

| Commands | What it does | Inputs | Outputs |
|---|---|---|---|
| `/gsd discuss` | Starts milestone discussion and context capture. | Active milestone, optional slice context. | Writes `CONTEXT.md` and transitions into planning. |
| `/gsd start <template>` | Starts a bundled workflow template. | Template name, optional description. | Creates a workflow run from `workflow-templates`. |
| `/gsd templates` | Lists available templates. | Optional `info <name>`. | Human-readable template registry. |
| `/gsd new-project [--deep]` | Bootstraps a new project. | Optional `--deep` for staged discovery. | Creates project-level planning artifacts. |
| `/gsd new-milestone [--deep]` | Creates a milestone from a spec. | Optional `--deep`. | Starts milestone planning artifacts. |
| `/gsd park`, `/gsd unpark` | Marks a milestone inactive or reactivates it. | Milestone ID. | DB and markdown status change. |
| `/gsd undo`, `/gsd undo-task`, `/gsd reset-slice` | Reverts milestone or task progress. | Milestone, slice, or task ID. | State rollback in DB and markdown projections. |
| `/gsd verdict <pass\|needs-attention\|needs-remediation>` | Overrides milestone validation verdict. | Milestone selector and rationale for non-pass outcomes. | Updates the validation artifact and DB state. |
| `/gsd eval-review <sliceId>` | Audits a slice evaluation strategy. | Slice ID. | Writes `<sliceId>-EVAL-REVIEW.md`. |
| `/gsd add-tests` | Generates tests for completed slices. | Milestone or slice context. | Test artifacts. |

### Visibility and Diagnostics

| Commands | What it does | Inputs | Outputs |
|---|---|---|---|
| `/gsd status` | Progress dashboard. | No args. | TUI or text summary of current milestone state. |
| `/gsd widget` | Cycles dashboard widget mode. | `full`, `small`, `min`, `off`. | UI mode change. |
| `/gsd visualize` | Opens the workflow visualizer. | Interactive terminal required. | 10-tab overlay. |
| `/gsd brief <mode>` | Generates a self-contained HTML brief. | `diagram`, `plan`, `diff`, `recap`, `table`, `slides`. | HTML artifact under the diagrams output dir. |
| `/gsd export --html` | Exports milestone results. | `--json`, `--markdown`, `--html`, `--all`. | Report artifact. |
| `/gsd history` | Shows execution history. | Filters like `--cost`, `--phase`, `--model`. | History list. |
| `/gsd logs` | Browses logs. | `debug`, `tail`, `clear`. | Log views or cleanup. |
| `/gsd debug` | Persistent debug sessions. | `list`, `status`, `continue`, `--diagnose`. | Debug-session artifacts. |
| `/gsd forensics` | Post-mortem analysis. | Optional description. | Structured failure report. |
| `/gsd doctor` | Health checks with auto-fix. | `fix`, `heal`, `audit`, `--json`, `--build`, `--test`. | Diagnostics and repair actions. |
| `/gsd inspect` | SQLite diagnostics. | No args. | DB state inspection. |
| `/gsd scan` | Fast codebase assessment. | Focus such as `tech` or `arch`. | Shorter assessment than full codebase map. |
| `/gsd codebase` | Generates or refreshes `CODEBASE.md`. | `generate`, `update`, `stats`. | Codebase map cache. |
| `/gsd changelog` | Shows release notes. | Optional version selector. | Changelog view. |
| `/gsd session-report` | Session cost and work summary. | Optional `--json` or `--save`. | Session summary artifact. |

### Configuration and Setup

| Commands | What it does | Inputs | Outputs |
|---|---|---|---|
| `/gsd setup` | Configuration hub. | `llm`, `model`, `search`, `remote`, `keys`, `prefs`, `onboarding`. | Status and setup subroutes. |
| `/gsd onboarding` | Setup wizard. | `--resume`, `--reset`, `--step <name>`. | Auth, provider, and tooling setup. |
| `/gsd init` | Project init wizard. | Existing or new project root. | Boots `.gsd/`. |
| `/gsd prefs` | Preference editor. | `global`, `project`, `status`, `wizard`, `setup`, `import-claude`. | Writes `PREFERENCES.md`. |
| `/gsd mode` | Sets global or project workflow mode. | `global` or `project`. | Updates preferences defaults. |
| `/gsd model` | Switches the active session model. | Provider/model or model ID. | Pins the model for the session. |
| `/gsd keys` | API key manager. | `list`, `add`, `remove`, `test`, `rotate`, `doctor`. | Key store changes. |
| `/gsd config` | Deprecated key-management alias. | Legacy args. | Redirects to `/gsd keys`. |
| `/gsd hooks` | Shows configured hooks. | No args. | Hook status summary. |
| `/gsd run-hook` | Manually triggers a hook. | Hook name, unit type, unit ID. | Hook execution result. |
| `/gsd skill-health` | Skill lifecycle dashboard. | Optional skill name or filter. | Skill health view. |
| `/gsd knowledge` | Adds persistent project knowledge. | `rule`, `pattern`, or `lesson`. | Writes to knowledge and memory stores. |
| `/gsd language` | Sets global response language. | Language name or code, or `off`. | Prompt language preference. |
| `/gsd fast` | Toggles OpenAI service tier. | `on`, `off`, `flex`, `status`. | Provider routing preference. |
| `/gsd mcp` | MCP server status and bootstrap. | `status`, `check`, `init`. | MCP setup/status. |
| `/gsd remote` | Remote auto-mode control. | Slack, Discord, Telegram integration args. | Remote question routing config. |
| `/gsd cmux` | Terminal multiplexer integration. | `status`, `on`, `off`, `notifications`, `sidebar`, `splits`, `browser`. | cmux preferences and visibility. |
| `/gsd extensions` | Extension registry management. | `list`, `enable`, `disable`, `info`, `install`, `uninstall`, `update`, `validate`. | Extension lifecycle changes. |

### Workflow Templates, Custom Workflows, and Shipping

| Commands | What it does | Inputs | Outputs |
|---|---|---|---|
| `/gsd workflow` | Lists or runs custom workflows. | `new`, `run`, `list`, `info`, `install`, `uninstall`, `validate`, `pause`, `resume`, or a workflow name. | Workflow registry operations or a workflow session. |
| `/gsd ship` | Creates a PR from milestone evidence. | `--dry-run`, `--draft`, `--base`, `--force`. | `gh pr create` flow and PR body. |
| `/gsd pr-branch` | Creates a PR branch that filters `.gsd/` commits. | Optional branch name. | Clean review branch. |
| `/gsd backlog` | Manages backlog items. | `add`, `promote`, `remove`, `list`. | Backlog mutation. |
| `/gsd worktree` / `/gsd wt` | Manages worktrees inside the TUI. | `list`, `merge`, `clean`, `remove`. | Worktree cleanup or merge. |
| `/gsd parallel` | Parallel milestone orchestration. | `start`, `status`, `stop`, `pause`, `resume`, `merge`, `watch`. | Worker coordination and merge. |
| `/gsd migrate` | Migrates v1 `.planning` to `.gsd`. | Optional source path. | Imported `.gsd` hierarchy. |
| `/gsd recover` | Rebuilds runtime state from rendered markdown. | No args. | Destructive recovery/import operation. |
| `/gsd rethink` | Conversational project reorganization. | Natural-language reorganization request. | Milestone reorder / park / discard / add actions. |
| `/gsd update` | Self-update. | No args. | `npm install` driven update. |

### CLI Entry Points

| Command | What it does | Inputs / outputs |
|---|---|---|
| `gsd` / `gsd-cli` | Main CLI entrypoint. | Routes to the same command surface as `/gsd`. |
| `gsd-pi` | Installer shim used by the package. | Internal install/bootstrap helper. |
| `gsd web` / `gsd --web` | Starts the web host. | Launches the Next.js app and session bridge. |
| `gsd headless auto` | Non-interactive orchestration. | Used for cron, CI, or remote control. |
| `worktree` / `wt` | Git worktree lifecycle helper. | Underlies `/gsd worktree`. |

Relevant files:

- `docs/user-docs/commands.md`
- `src/resources/extensions/gsd/commands/catalog.ts`
- `src/resources/extensions/gsd/commands/dispatcher.ts`
- `src/resources/extensions/gsd/commands/handlers/core.ts`
- `src/resources/extensions/gsd/commands/handlers/auto.ts`
- `src/resources/extensions/gsd/commands/handlers/workflow.ts`
- `src/resources/extensions/gsd/commands/handlers/parallel.ts`
- `src/resources/extensions/gsd/commands/handlers/ops.ts`
- `src/resources/extensions/gsd/extension-manifest.json`

## 4. State Model

GSD-2 is DB-authoritative. The runtime source of truth lives in the project-root SQLite database, and markdown under `.gsd/` is rendered from that database for review, prompt context, and git-friendly history.

### On-Disk Layout

| Layer | Location | Role |
|---|---|---|
| Project root state DB | `.gsd/gsd.db` | Authoritative state for milestones, slices, tasks, decisions, requirements, artifacts, memories, workers, leases, and dispatches. |
| Root projections | `.gsd/PROJECT.md`, `DECISIONS.md`, `QUEUE.md`, `STATE.md`, `REQUIREMENTS.md`, `OVERRIDES.md`, `KNOWLEDGE.md`, `CODEBASE.md` | Human-readable projections and review surfaces. |
| Milestone artifacts | `.gsd/milestones/M001/...` | Roadmap, context, research, validation, summary, and learnings at milestone scope. |
| Slice artifacts | `.gsd/milestones/M001/slices/S01/...` | Plan, context, research, summary, UAT, assessment, and replan artifacts at slice scope. |
| Task artifacts | `.gsd/milestones/M001/slices/S01/tasks/T01/...` | Task plan and summary artifacts. |
| Runtime markers | `.gsd/runtime/...` | Ephemeral counters and gates such as rewrite counters, UAT counters, research decision markers, and inflight markers. |
| Parallel worker coordination | `.gsd/parallel/...` and DB coordination tables | Worker leases, dispatch claims, and coordinator state. |
| Worktree projections | Worktree-local `.gsd/` when running in auto-worktree mode | Projection layer for the active worktree, while the project-root DB remains authoritative. |

The path contract is implemented in `src/resources/extensions/gsd/paths.ts`. Important rules:

- `gsdRoot(basePath)` resolves the canonical `.gsd` directory, with worktree-aware handling.
- `resolveGsdPathContract()` distinguishes `projectRoot`, `workRoot`, `projectGsd`, and `worktreeGsd`.
- Root-level files are canonicalized by name, but legacy lower-case variants are still accepted for compatibility.
- Auto-worktrees live under `.gsd/worktrees/<milestoneId>/`.
- The project root `.gsd` is the canonical state source. Worktree-local `.gsd` is a projection, not the truth source.

### Database Schema

The schema is created in `src/resources/extensions/gsd/db-base-schema.ts`, `db-coordination-schema.ts`, and `db-runtime-kv-schema.ts`.

| Table | Purpose | Notes |
|---|---|---|
| `schema_version` | Schema tracking | Records applied migrations. |
| `decisions` | Durable architecture decisions | Source for `DECISIONS.md`. |
| `requirements` | Durable requirement rows | Source for `REQUIREMENTS.md`. |
| `artifacts` | Imported file payloads | Tracks milestone, slice, and task artifacts. |
| `memories` | Durable knowledge store | Stores decisions, patterns, lessons, relations, embeddings, and provenance. |
| `milestones` | Milestone rows | Status, vision, success criteria, verification contract, DoD, and boundary map. |
| `slices` | Slice rows | Status, risk, dependencies, demo, summary, UAT, sketch data, and replan history. |
| `tasks` | Task rows | Title, narrative, verification result, blockers, files, plan summary, and escalation state. |
| `verification_evidence` | Task verification evidence | Records command, exit code, verdict, and timing. |
| `assessments` | UAT / assessment rows | Holds validation and assessment outputs. |
| `replan_history` | Replan audit trail | Tracks summary and artifact replacement history. |
| `workers` | Parallel worker records | One row per worker process on the local host. |
| `milestone_leases` | Parallel milestone ownership | Fencing token based lease table. |
| `unit_dispatches` | Dispatch ledger | Claims, retries, exit reasons, and verification evidence references. |
| `cancellation_requests` | Cancellation queue | Used to stop in-flight dispatches. |
| `command_queue` | Control-plane queue | Background commands for workers. |
| `runtime_kv` | Soft runtime state | Non-correctness-critical state only. |

Lifecycle notes:

- `runtime_kv` is intentionally not the correctness source for control-flow decisions.
- `milestone_leases` and `unit_dispatches` are the hard coordination primitives.
- `deriveState()` in `src/resources/extensions/gsd/state.ts` is DB-first, with explicit fallback to legacy markdown only for migration or recovery scenarios.
- `openDatabaseByWorkspace()` and the workspace-aware DB helpers let multiple views of the same project share the same authoritative state.
- The auto-mode docs explicitly say markdown projections are for review and prompt context, not the source of truth.

Relevant files:

- `src/resources/extensions/gsd/paths.ts`
- `src/resources/extensions/gsd/state.ts`
- `src/resources/extensions/gsd/db-base-schema.ts`
- `src/resources/extensions/gsd/db-coordination-schema.ts`
- `src/resources/extensions/gsd/db-runtime-kv-schema.ts`
- `src/resources/extensions/gsd/db-task-slice-rows.ts`
- `src/resources/extensions/gsd/db-milestone-artifact-rows.ts`
- `src/resources/extensions/gsd/db-open-state.ts`
- `docs/user-docs/auto-mode.md`
- `docs/dev/architecture.md`
- `docs/dev/FILE-SYSTEM-MAP.md`

## 5. Agent / Supervisor Model

GSD-2 uses a fresh-session-per-unit model. Each unit gets a clean context window, a unit-specific prompt, a scoped tool surface, and a post-unit closeout path.

The main pieces are:

- `src/resources/extensions/gsd/auto.ts`, which owns auto-mode orchestration, session lifecycle, stop handling, crash recovery, and state transitions.
- `src/resources/extensions/gsd/auto-start.ts`, which bootstraps a fresh run.
- `src/resources/extensions/gsd/auto-supervisor.ts`, which installs termination handlers and monitors working-tree activity.
- `src/resources/extensions/gsd/auto-timers.ts`, `auto-timeout-recovery.ts`, and `auto-recovery.ts`, which enforce soft, idle, and hard timeout handling and recovery.
- `src/resources/extensions/gsd/auto-model-selection.ts`, which resolves the effective model and tool policy per unit.
- `src/resources/extensions/gsd/bootstrap/register-hooks.ts`, which narrows tools and enforces write gates.
- `src/resources/extensions/gsd/bootstrap/system-context.ts`, which assembles the system prompt, knowledge, codebase map, and skill discovery blocks.

Important behavior:

- Fresh session per unit: the dispatch loop creates a new session for every unit instead of reusing a long-lived conversation.
- Tool scoping: unit types get narrowed tool surfaces. For example, execution units, planning units, and deep research units do not see the same tool set.
- Model routing: per-unit model selection can use explicit preferences, fallbacks, complexity routing, and budget pressure.
- Crash recovery: the runtime persists enough context to resume or reconstruct a paused or crashed run.
- Stuck detection: the docs and code both describe sliding-window stuck-loop detection and recovery retries.
- Verification gating: task, slice, and milestone closeout all have explicit validation points.

Parallelism is not ad hoc. GSD-2 has several layers:

- Milestone parallelism through `src/resources/extensions/gsd/parallel-orchestrator.ts`, `parallel-eligibility.ts`, `parallel-merge.ts`, and the `workers`/`milestone_leases`/`unit_dispatches` tables.
- Slice-level parallel research through `parallel-research-slices`.
- Reactive execution within a slice through `reactive-execute` and the execution graph in `src/resources/extensions/gsd/uok/execution-graph.ts`.
- Subagent fan-out in selected units, including project research and reactive execution.

Isolation primitive:

- Auto work is isolated in git worktrees and milestone branches. `src/resources/extensions/gsd/auto-worktree.ts` and `worktree-manager.ts` own the lifecycle.
- The dispatcher resolves a canonical milestone worktree root before building prompts, so the prompt context matches the actual code location.
- The path layer understands both project-root and worktree-local `.gsd` projection roots.

Relevant files:

- `src/resources/extensions/gsd/auto.ts`
- `src/resources/extensions/gsd/auto-start.ts`
- `src/resources/extensions/gsd/auto-supervisor.ts`
- `src/resources/extensions/gsd/auto-timers.ts`
- `src/resources/extensions/gsd/auto-timeout-recovery.ts`
- `src/resources/extensions/gsd/auto-recovery.ts`
- `src/resources/extensions/gsd/auto-model-selection.ts`
- `src/resources/extensions/gsd/auto-worktree.ts`
- `src/resources/extensions/gsd/parallel-orchestrator.ts`
- `src/resources/extensions/gsd/parallel-eligibility.ts`
- `src/resources/extensions/gsd/parallel-merge.ts`
- `src/resources/extensions/gsd/uok/execution-graph.ts`
- `src/resources/extensions/gsd/bootstrap/register-hooks.ts`
- `src/resources/extensions/gsd/bootstrap/system-context.ts`

## 6. Hooks + Extension Points

GSD-2 exposes several extension surfaces, and they are not all the same thing.

| Extension point | Mechanism | What it changes |
|---|---|---|
| Runtime hooks | `extension-manifest.json` and `bootstrap/register-hooks.ts` | Session start, session switch, tool calls, provider requests, agent end, and other lifecycle events. |
| Post-unit hooks | `post-unit-hooks.ts` and `/gsd hooks` / `/gsd run-hook` | Deterministic post-unit follow-up actions, retries, and artifact-driven checks. |
| Keyboard shortcuts | `bootstrap/register-shortcuts.ts` | Dashboard, notifications, and parallel overlays. |
| Tool scoping | `bootstrap/register-hooks.ts` and `bootstrap/system-context.ts` | Which tools are visible to the agent for a unit type. |
| Skill discovery | `bootstrap/system-context.ts`, `skill-discovery.ts`, `skill-manifest.ts` | Which skills are recommended or loaded into the prompt. |
| Workflow templates | `workflow-templates.ts`, `workflow-templates/registry.json`, `/gsd start`, `/gsd workflow` | Bundled, project, and global workflows. |
| Custom workflows | `/gsd workflow`, `commands-workflow-templates.ts`, `workflow-install.ts` | Oneshot, yaml-step, markdown-phase, and auto-milestone workflows. |
| Extensions registry | `/gsd extensions ...` and `extension-registry.ts` | Install, enable, disable, validate, and update extensions. |
| cmux and remote integration | `/gsd cmux`, `/gsd remote` | UI and question routing integrations. |
| MCP / tool bootstrap | `/gsd mcp`, `bootstrap/dynamic-tools.ts`, `bootstrap/exec-tools.ts`, `bootstrap/query-tools.ts` | External integration and tool access. |

The extension manifest advertises the core GSD surface:

- tools: `bash`, `write`, `read`, `edit`, plus GSD-specific mutation tools.
- commands: `gsd`, `kill`, `worktree`, `exit`.
- hooks: `session_start`, `session_switch`, `bash_transform`, `session_fork`, `before_agent_start`, `agent_end`, `session_before_compact`, `session_shutdown`, `tool_call`, `tool_result`, `tool_execution_start`, `tool_execution_end`, `model_select`, `before_provider_request`.
- shortcut: `Ctrl+Alt+G`.

The system prompt bootstrap in `bootstrap/system-context.ts` adds more extension behavior:

- Bundled skills are discovered dynamically and injected only when installed.
- `KNOWLEDGE.md` is backfilled from the memory store and re-rendered.
- `CODEBASE.md` is refreshed automatically and injected in truncated form when available.
- Skill discovery and tool surface narrowing are driven by the current unit type.

Relevant files:

- `src/resources/extensions/gsd/extension-manifest.json`
- `src/resources/extensions/gsd/bootstrap/register-hooks.ts`
- `src/resources/extensions/gsd/bootstrap/register-shortcuts.ts`
- `src/resources/extensions/gsd/post-unit-hooks.ts`
- `src/resources/extensions/gsd/hook-emitter.ts`
- `src/resources/extensions/gsd/bootstrap/system-context.ts`
- `src/resources/extensions/gsd/workflow-templates.ts`
- `src/resources/extensions/gsd/workflow-install.ts`
- `src/resources/extensions/gsd/commands-workflow-templates.ts`
- `src/resources/extensions/gsd/extension-registry.ts`
- `src/resources/extensions/gsd/commands-extensions.ts`

## 7. What Changed vs v1 (`get-shit-done`)

The headline difference is architectural, not cosmetic.

GSD v1 was a prompt framework that leaned on slash commands in Claude Code. The README explicitly says it worked, but it was fighting the tool. The new GSD-2 is a standalone TypeScript CLI built on the Pi SDK, which means it controls sessions, context windows, execution, git state, and tool availability directly.

What changed:

- From prompt framework to runtime: v1 asked the LLM to behave. v2 can enforce workflow rules in code.
- From `.planning/` to `.gsd/`: migration support exists for old projects, but v2 state lives in `.gsd/`.
- From implicit state to DB-authoritative state: v2 stores milestones, slices, tasks, memories, and coordination state in SQLite.
- From monolithic prompt runs to fresh sessions per unit: each dispatch starts with a clean context window.
- From one-size-fits-all prompts to unit-scoped prompts and tool sets: planning, execution, validation, and research are separate surfaces.
- From no parallel coordinator to explicit worker orchestration: milestone workers, leases, dispatch claims, and merge pipelines are first-class.
- From manual review to generated projections: markdown files are outputs from the DB, not the runtime truth.
- From basic command aliases to a real command surface: workflows, templates, extensions, hooks, reports, recovery, and diagnostics are all explicit commands.

The migration doc says the importer maps:

- phases -> slices
- plans -> tasks
- milestones -> milestones

and then writes the imported hierarchy into the GSD database before rendering markdown projections.

Relevant files:

- `README.md`
- `docs/user-docs/migration.md`
- `docs/dev/architecture.md`
- `src/resources/extensions/gsd/paths.ts`

## 8. Comparison to My Codex-Peers Methodology

| Dimension | GSD-2 | codex-peers | Gap |
|---|---|---|---|
| Phase model | Hierarchical milestone -> slice -> task state machine with deep planning, reassessment, UAT, validation, and closeout. | Peer record lifecycle with statuses like `starting`, `working`, `waiting`, `done`, `failed`, plus a special `gsd_phase_batch` path. | codex-peers has peer lifecycle states, but not a first-class milestone/slice/task graph. |
| State authority | Project-root SQLite DB plus rendered `.gsd/` projections. | JSON `state.json` under `~/.codex-peers/` plus per-peer logs. | codex-peers is lighter, but it does not have DB-authoritative planning state. |
| Dispatch | Declarative state-based dispatch table chooses the next unit and prompt. | Spawn a peer with a task prompt, then wait, log, kill, or resume it. | codex-peers has peer dispatch, but not a rule engine that derives next work from project state. |
| Isolation | Milestone worktrees and branch modes, with worktree-local projection support. | One isolated linked worktree per peer. | This is the closest match. codex-peers already has the right primitive. |
| Parallelism | Built-in milestone leases, worker coordination, slice parallel research, and reactive execution. | Multiple peers can exist, but coordination is mostly external to the peer records. | codex-peers lacks a durable multi-worker lease and dispatch ledger. |
| Tool scoping | Unit-specific tool surfaces and hook-based narrowing. | No comparable per-task tool contract in the peer supervisor. | codex-peers would need a prompt/tool policy layer. |
| Hooks / extension points | Explicit hooks, skills, custom workflows, templates, and extension registry. | Minimal MCP tool surface and supervisor controls. | codex-peers is much smaller and not extensible in the same way yet. |
| Recovery | Crash recovery, doctor, forensics, timeout recovery, validation retries, and replay-safe closeout. | Logs, wait status, kill, resume, and manual integration. | codex-peers does not persist as much durable workflow evidence. |
| Visibility | Status dashboard, visualizer, briefs, reports, history, logs, and forensics. | Dashboard, peer list, log tail, and per-peer status. | codex-peers has good operational visibility, but not the full artifact/report layer. |
| Merge and closeout | GSD auto-merges milestone work, writes summaries, validation artifacts, and learnings, then can open PRs. | Successful peers are integrated by committing and merging their linked worktree. | The merge primitive exists, but codex-peers does not generate the same closeout artifact stack. |

What this means in practice:

- GSD-2 is a workflow product with a runtime.
- codex-peers is an execution substrate with supervision.
- The useful overlap is the isolated worktree plus supervised peer process.
- The missing layer in codex-peers is a project-level state machine and artifact contract.

## 9. Alignment Strategy

If we want a GSD flow on top of codex-peers, the right approach is to keep codex-peers as the execution substrate and layer GSD semantics on top of it.

### Adopt Verbatim

- Keep one isolated worktree per unit.
- Keep a fresh session per unit instead of letting context accumulate.
- Keep explicit peer status transitions and durable logs.
- Keep model selection explicit per unit.
- Keep merge-after-success semantics, not ad hoc branch mutation.
- Keep terminal observability and the ability to kill or resume a run.

### Adapt

- Replace free-form peer tasks with a milestone -> slice -> task unit graph.
- Add a durable project store, not just peer JSON, for workflow state.
- Add prompt builders that inline the right context per unit.
- Add a dispatch table that derives the next unit from project state.
- Add unit-scoped tool policies so planning, execution, and validation do not share the same capability surface.
- Add closeout artifacts such as summaries, validation records, learnings, and reports.
- Add a lightweight coordinator for parallel work, including leases or claims if multiple workers can touch the same project.

### Reject

- Do not treat markdown as the runtime source of truth.
- Do not make the orchestration loop depend on prompt obedience alone.
- Do not let arbitrary peer tasks mutate workflow state without a schema.
- Do not keep a single unscoped prompt surface for planning and execution.
- Do not require operators to infer progress only from logs.

### Concrete Build Order

1. Introduce a project store with explicit milestone, slice, task, and run records.
2. Build a state-to-unit dispatch layer that chooses the next peer task from durable state.
3. Add prompt assembly that inlines the minimum required context for each unit.
4. Add worktree and merge closeout conventions for each unit type.
5. Add hook points for post-unit verification, reports, and recovery.
6. Add parallel worker coordination only after the single-worker path is stable.

## 10. Cost of Building a Peer-Driven GSD Flow on Top of codex-peers

Below is a realistic 5 milestone plan, assuming we keep the existing peer runner and worktree machinery and layer GSD semantics on top.

| Milestone | Scope | Rough LOC |
|---|---|---|
| 1. Project state model | Add durable milestone, slice, task, and run records; define projection files; add parsers and serializers. | 600 to 900 LOC |
| 2. Dispatcher and prompt assembly | Add the phase model, unit selection rules, prompt builders, and unit-scoped context inlining. | 900 to 1400 LOC |
| 3. Worktree and closeout integration | Add milestone branch conventions, closeout commits, summary artifacts, validation artifacts, and merge-on-success semantics. | 700 to 1100 LOC |
| 4. Hooks and extension layer | Add post-unit hooks, command routing, model selection hooks, and workflow template/custom workflow plumbing. | 800 to 1300 LOC |
| 5. Parallelism and recovery | Add worker leases, parallel dispatch, timeout recovery, stuck detection, dashboards, and reports. | 900 to 1500 LOC |

Expected total, if built cleanly: roughly 3,900 to 6,200 net new LOC, not counting tests and docs.

The main risk is not raw implementation size. It is accidentally building a thin wrapper around peer logs instead of a real project state machine. GSD-2 avoids that trap by putting the durable state in SQLite and treating markdown as a projection.

## Sources

### GSD-2 repository

- [README.md](https://github.com/gsd-build/gsd-2/blob/main/README.md)
- [package.json](https://github.com/gsd-build/gsd-2/blob/main/package.json)
- [.github/CODEOWNERS](https://github.com/gsd-build/gsd-2/blob/main/.github/CODEOWNERS)
- [docs/README.md](https://github.com/gsd-build/gsd-2/blob/main/docs/README.md)
- [docs/user-docs/auto-mode.md](https://github.com/gsd-build/gsd-2/blob/main/docs/user-docs/auto-mode.md)
- [docs/user-docs/commands.md](https://github.com/gsd-build/gsd-2/blob/main/docs/user-docs/commands.md)
- [docs/user-docs/migration.md](https://github.com/gsd-build/gsd-2/blob/main/docs/user-docs/migration.md)
- [docs/dev/architecture.md](https://github.com/gsd-build/gsd-2/blob/main/docs/dev/architecture.md)
- [docs/dev/FILE-SYSTEM-MAP.md](https://github.com/gsd-build/gsd-2/blob/main/docs/dev/FILE-SYSTEM-MAP.md)
- [src/resources/GSD-WORKFLOW.md](https://github.com/gsd-build/gsd-2/blob/main/src/resources/GSD-WORKFLOW.md)
- [src/resources/extensions/gsd/commands/catalog.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/commands/catalog.ts)
- [src/resources/extensions/gsd/commands/dispatcher.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/commands/dispatcher.ts)
- [src/resources/extensions/gsd/auto-dispatch.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/auto-dispatch.ts)
- [src/resources/extensions/gsd/auto-prompts.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/auto-prompts.ts)
- [src/resources/extensions/gsd/paths.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/paths.ts)
- [src/resources/extensions/gsd/state.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/state.ts)
- [src/resources/extensions/gsd/db-base-schema.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/db-base-schema.ts)
- [src/resources/extensions/gsd/db-coordination-schema.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/db-coordination-schema.ts)
- [src/resources/extensions/gsd/bootstrap/register-hooks.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/bootstrap/register-hooks.ts)
- [src/resources/extensions/gsd/bootstrap/register-shortcuts.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/bootstrap/register-shortcuts.ts)
- [src/resources/extensions/gsd/bootstrap/system-context.ts](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/bootstrap/system-context.ts)
- [src/resources/extensions/gsd/extension-manifest.json](https://github.com/gsd-build/gsd-2/blob/main/src/resources/extensions/gsd/extension-manifest.json)

### codex-peers baseline

- [README.md](../../README.md)
- [src/types.ts](../../src/types.ts)
- [src/peerManager.ts](../../src/peerManager.ts)
- [src/store.ts](../../src/store.ts)
- [src/lifecycle.ts](../../src/lifecycle.ts)
- [src/gsdRunner.ts](../../src/gsdRunner.ts)
- [src/gsdState.ts](../../src/gsdState.ts)
