I have everything needed — including a decisive ground-truth result. Compiling the report.

---

# Codex CLI "Ultra Mode" & Sub-Agents — Research for delamain

**Verified locally against `codex-cli 0.144.5`** (binary: `/home/joshuaduffill/.nvm/.../@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`, a 298 MB Rust native binary; npm `bin/codex.js` is just a launcher). Labels below: **[V]** = verified by running the CLI / inspecting the binary or config on this machine; **[W]** = web/docs/recall (2026 sources, post-training).

---

## 0. TL;DR for the caller

- **"Ultra mode" ≠ a CLI flag.** It is a ChatGPT/Codex *product tier* behavior: the model **proactively** delegates to cooperating sub-agents. The underlying mechanism is the `multi_agent` feature + the `spawn_agent` tool family, which **is** reachable from the CLI (and, **[V] confirmed**, from headless `codex exec`) by *manual instruction*. Note: there is *also* a separate `Ultra` **reasoning-effort** level in the effort enum — don't conflate the two.
- **[V] DECISIVE FINDING:** `spawn_agent` **works in non-interactive `codex exec`**. A ground-truth test spawned a real sub-agent (`collab: SpawnAgent` → `collab: Wait` → sub-agent returned `PING`) headlessly. So delamain *could* enable it per-peer today with zero code change (existing `-c` passthrough).
- **But it does NOT give you code-defined, terminating workflows.** Control flow is model-decided, and it is prone to non-termination / token runaway (Theo's core complaint, corroborated by cost docs). **Recommendation: delamain owns orchestration in TypeScript (the deterministic "workflow"); drive plain `codex exec` leaves; use `multi_agent` only as a *bounded* optional accelerator inside a leaf** (ideally the CSV batch tool, which actually terminates).

---

## 1. What "Ultra mode" actually is

**[W]** Codex "Ultra" (a.k.a. "Sol Ultra" / GPT-5.6 Sol Ultra) is a mode where **the model proactively decides to parallelize** — spawning sub-agents "when parallel agents would materially improve speed or quality," without you asking. Its distinguishing claim: the sub-agents are **"trained to cooperate and allowed to communicate with each other during a task"** and share context (not independent parallel shells). Up to **8 parallel agents**, each with its own context window / sandbox. The *proactive* trigger is gated to the ChatGPT/Codex app; the *mechanism* (the `spawn_agent` tool) is also invocable in the CLI by explicit instruction ("spawn two agents," "delegate this in parallel").

**[V]** There is no `ultra` feature flag. `codex features list` shows the relevant machinery under different names:

| feature flag | stage | effective | meaning |
|---|---|---|---|
| `multi_agent` | **stable** | **true** | the V1 sub-agent system (`spawn_agent` etc.) |
| `multi_agent_v2` | under development | false | experimental V2 (deep nesting + message passing) |
| `multi_agent_mode` | **removed** | false | old toggle, gone |
| `collaboration_modes` | removed | true | legacy collab modes |
| `enable_fanout` | under development | false | (fan-out gating, not yet on) |
| `deferred_executor`, `rollout_budget`, `token_budget` | under development | false | budget/termination-adjacent, not shipped |

**[V]** `Ultra` also appears as the top of the **reasoning-effort enum** (`Minimal, Low, Medium, High, XHigh, Max, Ultra`). However the current default model `gpt-5.6-luna` **rejects it** — API error: *"Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'."* So "Ultra reasoning" is not usable on the default model right now and is orthogonal to "Ultra mode / sub-agents."

---

## 2. V1 vs V2 sub-agents

**[W] + transcript (Theo, verified quote from the saved transcript):**
- **V1** (`multi_agent`, **stable, on by default**): top-level agent spawns **one level** of sub-agents with scoped tasks, gets responses back when they finish. Simple hierarchy.
- **V2** (`multi_agent_v2`, **experimental, off, must manually enable**): **copies the whole context window over by default** (annoying/expensive); sub-agents can **spawn their own *named* sub-agents** with layering + **message passing** between them. Adds many coordination tools. Theo: *"takes a very simple hierarchy and makes it absurdly complex… the result's a bit chaotic and clearly still being tuned. That's why it's off by default."*

**[V] binary corroboration** — the version selector is `multi_agent_version` with values `default_v1` / `default_v2`. V2 emits a richer collab event set (all present as strings in the binary): `collab_agent_spawn_begin/end`, `collab_agent_interaction_begin/end`, `collab_waiting_begin/end`, `collab_close_begin`, `collab_resume_begin/end`, `sub_agent_activity`. **Nuance:** even the *V1* `spawn_agent` tool description says *"The spawned agent will have the same tools as you and the ability to spawn its own subagents"* — so nesting is technically possible in V1 too; it's bounded by `agents.max_depth` (default **1**), not by version.

---

## 3. HOW to invoke it programmatically from a supervisor

**Enable (any of):** **[V/W]**
```toml
# config.toml (user ~/.codex/ or project .codex/)
[features]
multi_agent = true

[agents]
max_threads = 4              # concurrent open threads (default 6)   [V: key = agents.max_threads]
max_depth   = 1              # nesting depth, 0 = root only (default 1)
job_max_runtime_seconds = 900
```
- **[V]** CLI sugar: `--enable multi_agent` ≡ `-c features.multi_agent=true`; `--disable` likewise. `codex features enable <name>` / `disable` **persist to config.toml**. All accepted on `codex`, `codex exec`, `codex review`.
- **[V]** Per-invocation override: `-c agents.max_depth=1 -c agents.max_threads=4` etc. (any dotted TOML path).
- **[V] peer-codex-home already has `[features] multi_agent = true`** (`~/.delamain/peer-codex-home/config.toml`), and the main `~/.codex/config.toml` too.

**Define named sub-agents (optional):** **[V/W]** standalone TOML in `~/.codex/agents/` (73 present here) or `.codex/agents/`:
```toml
name        = "security-reviewer"        # required
description = "…"                        # required
developer_instructions = "…"             # required
# optional overrides:
model = "…"; model_reasoning_effort = "high"; sandbox_mode = "workspace-write"
mcp_servers = [...]; skills.config = {...}; nickname_candidates = [...]
```
(The older `[agents.<name>] config_file = "...toml"` form in `~/.codex/config.toml` — used by GSD — points at these files.)

**Tool surface the model gets (V1):** **[V] extracted from binary + verified live:**
| tool | purpose |
|---|---|
| `spawn_agent` | spawn one sub-agent. **Params [V from tool description]:** `task_name` (canonical hierarchical name, e.g. `/root/task1/task_3`), `model` (optional — *inherits parent by default*), `fork_turns` = `"none"` (no context passed) \| `"all"` (full surrounding context). |
| `wait_agent` | block for a spawned agent's result |
| `send_input` | send a message/steer a running sub-agent |
| `resume_agent` | resume a completed/paused thread |
| `close_agent` | close a finished thread |
| `spawn_agents_on_csv` | **fan-out / map**: `csv_path`, `instruction` (template with `{column}`), `id_column`, `output_schema`, `output_csv_path`, `max_concurrency` (≤ max_threads), `max_runtime_seconds`. Each worker must call `report_agent_job_result` exactly once or the row = `status: error`. |

**Observability:** **[V]** hooks `SubagentStart` / `SubagentStop` (event names `subagent_start`/`subagent_stop`) fire around sub-agent lifecycle; PreToolUse fires per collab tool call (seen live). Config knobs include `default_wait_timeout_ms`, `min/max_wait_timeout_ms`, `max_concurrent_threads_per_session`, `tool_namespace`, `hide_spawn_agent_metadata`, `non_code_mode_only`.

**Does it run headless in `codex exec`? YES — [V] ground-truth verified.** Running:
```
codex exec --skip-git-repo-check -s read-only --enable multi_agent \
  -c agents.max_threads=4 -c agents.max_depth=1 \
  'Use spawn_agent to delegate a trivial task … report its reply'
```
produced in the log: `collab: SpawnAgent` → `hook: PreToolUse` → `collab: Wait` → sub-agent replied `PING` → parent reported it. **~11,463 tokens for one trivial 1-level nested spawn.** **[W]** GitHub issue openai/codex#12713 confirms `spawn_agent` in exec forces `approval_policy=never` (which non-interactive exec already uses). **Caveat [W]:** in `codex exec`, *any action a sub-agent takes that needs a fresh approval errors back to the parent* — design workers to stay inside inherited sandbox perms.

> **[V] Reliability caveat for whoever tests this:** asking the model to "list your tools" in `codex exec` returns a list that **omits** `spawn_agent`/`wait_agent` (it lists only `exec, wait, apply_patch, exec_command, update_plan, request_user_input, goals, mcp*, view_image, write_stdin, image_gen, web`). That self-report is **unreliable** — the tool is registered and callable, the model just doesn't volunteer it (system-prompt guidance says *"Do not spawn sub-agents unless the user/AGENTS.md/skill explicitly ask"*). Only an actual spawn instruction reveals it.

---

## 4. Does it yield "dynamic workflows"? Control flow & termination

**No — not in the sense delamain wants.** **[W] + transcript + [V] behavior:**
- **Control flow is model-driven and emergent**, not code-defined. The top agent decides *if/when/how many* sub-agents to spawn at runtime. There is no program that enumerates phases/stages. `spawn_agent`/`wait_agent` block until results return, then the model chooses what to do next.
- **Termination is not structurally guaranteed.** Theo: *"They tend to just kind of go forever with Ultra… Ultra can just go forever, workflows won't."* Cost corroboration **[W]**: Ultra sessions run **6–12× token** multipliers; one commenter had a full home dir deleted by a runaway Ultra run. The only structural brakes are `agents.max_depth` (caps nesting, not loops) and `agents.job_max_runtime_seconds` / `max_runtime_seconds` (only for the **CSV batch** path).
- **Contrast — Claude Code "Workflows" (what the user is targeting):** **[W]** the *model writes a JavaScript file* defining stages, prompts, and which sub-agents run at each stage; the file **executes top-to-bottom and therefore ends**. Because control flow is *code*, it is deterministic, terminates, and (per Theo) uses **~¼ the tokens** for equal-or-better output. Codex's `spawn_agents_on_csv` is the *only* Codex primitive with comparable "starts, maps, and finishes" semantics — it's a bounded batch job, not open-ended orchestration.

**Bottom line:** Codex multi_agent = dynamic **fan-out**, yes; **dynamic *terminating workflow*** = no. The "code defines the workflow, so it ends" property lives in the *harness/driver*, not in Codex's sub-agent feature.

---

## 5. Key limitations (Theo + verified)

1. **Non-termination / runs forever** [W/transcript] — no code-level end condition; only depth/time caps on batch jobs.
2. **Token runaway** [W] — 6–12× multiplier; V2 *copies the full context window per sub-agent by default*.
3. **Chaos at depth** [W/transcript] — V2 named sub-agents + message passing "absurdly complex… clearly still being tuned," off by default.
4. **Model won't self-declare the tools** [V] — hard to introspect; only manual instruction reveals capability.
5. **Headless approval trap** [W] — sub-agent actions needing fresh approval hard-error back to parent in `codex exec`.
6. **Blast radius** [W] — real reports of destructive commands under autonomous Ultra runs (relevant to delamain's `--yolo` path).
7. **System-prompt baggage** [transcript] — the stock Codex system prompt is bloated (front-end "constitution," "update every 30s," "continue until solved" → over-persistence). delamain already mitigates by injecting its own `developer_instructions` and `--disable hooks`.

---

## 6. Concrete implication for delamain

**delamain must be the orchestrator; do NOT delegate top-level orchestration to Codex ultra/multi_agent.** Rationale: delamain's goal is *code-defined, multi-phase, fan-out/verify/loop workflows that terminate*. That determinism+termination property is exactly what Codex's model-driven sub-agents **lack**, and exactly what a code driver (delamain's TypeScript, or Pi as top driver) **provides** — it is the same architecture as Claude Code Workflows (code owns control flow; the model is a leaf).

**How this maps onto delamain today [V] (grounded in `src/runner.ts`):**
- delamain already drives leaves as `codex exec --json -C <repo> -` with injected `developer_instructions`, `--disable hooks`, and reasoning-effort (`buildCodexArgs`, `reasoningEffortArgs`). Its `spawnGsdPhaseBatch`/`gsdRunner` is the embryonic code-driver. **This is the right layer to grow into the workflow engine.** Keep the workflow (phases, fan-out set, verify gate, bounded retry loop, terminate) in delamain code; each node = one `codex exec`. delamain already gets clean termination + observability because it sees each exec's exit code / last-message file.
- **Zero-code path to *optionally* use Codex sub-agents inside a leaf:** `buildCodexArgs` already appends caller-supplied `-c` pairs (`args.codexConfig`, unrestricted passthrough). So a supervisor can enable per-peer multi_agent via `codexConfig: ["features.multi_agent=true", "agents.max_depth=1", "agents.max_threads=4"]` with no change. **Caveat [V]:** delamain hard-codes `--disable hooks`, which suppresses `SubagentStart`/`SubagentStop` — you'd lose sub-agent lifecycle observability unless you make that conditional.

**Recommended division of labor:**
- **delamain / Pi (code):** owns phases, fan-out enumeration, verify steps, loop-with-max-iterations, and the *terminate* decision. Deterministic. This is the "workflow."
- **`codex exec` leaf (plain):** the default executor — one bounded task per process, delamain integrates the result. Predictable tokens, clean exit.
- **`codex exec` leaf + `multi_agent` (opt-in, bounded):** only for *embarrassingly-parallel, well-scoped* sub-tasks where the model spawning 2–4 workers beats delamain fanning out N processes — and prefer **`spawn_agents_on_csv`** (it terminates: per-row `report_agent_job_result` + `max_runtime_seconds`). Cap with `agents.max_depth=1`, small `max_threads`, and a hard wall-clock timeout in delamain. Never let it be the top-level driver.
- **Avoid `multi_agent_v2`** for now (experimental, context-copying, non-terminating, off by default).

**One-line answer to the user's core question:** delamain **cannot** safely delegate orchestration to Codex "ultra mode" (it's model-driven and doesn't reliably terminate); delamain **must provide the workflow logic itself** and drive plain `codex exec` peers — optionally invoking Codex `multi_agent`/`spawn_agents_on_csv` as a *bounded* fan-out accelerator inside individual leaves.

**Sources [W]:** [OpenAI Codex Subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents) · [Codex KB: TOML/parallelism/spawn_agents_on_csv](https://codex.danielvaughan.com/2026/03/26/codex-cli-subagents-toml-parallelism/) · [openai/codex#12713 (spawn_agent in exec / approval_policy)](https://github.com/openai/codex/issues/12713) · [Ultra subagent token cost](https://tokenkarma.app/blog/codex-sol-ultra-subagent-token-cost-2026/) · [GPT-5.6 Sol Ultra cooperative subagents](https://www.developersdigest.tech/blog/gpt-56-sol-ultra-codex-subagents) · transcript `newsletter-curator/transcripts/i-need-you-to-hear-me-out-…Noo0NWD0gHU.md` (Theo, Ultra vs Workflows).