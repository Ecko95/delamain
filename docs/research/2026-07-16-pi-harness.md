I have authoritative local coverage. Compiling the report now.

---

# Pi (`@mariozechner/pi-coding-agent`) — Orchestration Capabilities for delamain

**Provenance legend:** ✅ VERIFIED locally (ran the CLI / read installed source & docs on this machine) · 🌐 web/npm registry · 🧠 recall. Pi installed at `/home/joshuaduffill/.nvm/versions/node/v25.5.0/bin/pi`, **v0.57.1**, npm pkg `@mariozechner/pi-coding-agent@0.57.1` (Mario Zechner, `github.com/badlogic/pi-mono`). Config dir `~/.pi/agent/`. Full docs ship inside the package at `…/pi-coding-agent/docs/` and there's an extra local doc set at `/home/joshuaduffill/dev/gsd-cursor-dispatch/docs/what-is-pi/`.

---

## 1. What Pi is — agent loop, tools, model config ✅

Pi is a **terminal-native, aggressively-extensible coding-agent harness** (not a workflow engine). It sits between you and an LLM and runs the classic tool-calling loop. Core subsystems (from `docs/…/04-the-architecture`): Model Registry, Auth Storage, Agent Session (the orchestrator), Session Manager (JSONL entry-tree with **branching + compaction**), Agent Loop, Tool Executor, Event System, Extension Runtime, Resource Loader, Mode Layer.

**Agent loop** (`05-the-agent-loop`): assemble context → LLM call (stream tokens) → if tool calls, execute each (firing `tool_call`/`tool_result` events extensions can gate/modify) → append results → repeat **until the LLM stops calling tools**. Stop reasons: `stop` (done), `toolUse` (loops again), `length`, `error`, `aborted`. **Key for orchestration: a single prompt runs 1..N turns and terminates on its own when the model emits no tool call.** There is no built-in iteration cap / phase concept — termination is model-decided.

**Built-in tools** (7, 4 on by default): `read, bash, edit, write` (default) + `grep, find, ls`. Control via `--tools read,bash,edit,write`, `--no-tools`. All tool output truncated to 50KB/2000 lines. Extensions can register arbitrary additional tools and call `pi.setActiveTools([...])` at runtime.

**Model config:** `--provider` (default `google`; user's default is `anthropic`) · `--model` (supports `provider/id` and `:thinking` shorthand, e.g. `sonnet:high`, `openai/gpt-5`) · `--thinking off|minimal|low|medium|high|xhigh` · `--api-key` or env vars. **20+ providers** built into the Model Registry (Anthropic, OpenAI incl. Azure, Google, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, ZAI, Mistral, MiniMax, OpenCode, Kimi, AWS Bedrock). Model switching mid-session via `cycle_model`.
- **Codex-model relevance ✅:** `pi --help` states `xhigh` thinking is *"only supported by OpenAI codex-max models."* `docs/models.md` exposes `openai-responses` API + a `compat.supportsReasoningEffort` flag. So Pi drives **OpenAI reasoning / codex-max models directly over the API** (`OPENAI_API_KEY`), *not* by wrapping the `codex` CLI. → If you want **codex-cli "ultra mode"** (the CLI's own sub-agent behavior), that stays in delamain's existing `codex exec --json` engine; Pi is the complementary path for "use a codex-max model with xhigh reasoning as a raw model."

**User's current install state ✅:** `~/.pi/agent/settings.json` → `defaultProvider: anthropic`, `defaultModel: claude-haiku-4-5`, `defaultThinkingLevel: medium`. `~/.pi/agent/auth.json` holds an **Anthropic OAuth token that is expired** (`expires: 1773245378480` ≈ 2026-03-11; today is 2026-07-16) — see §2 live test. Skills present: `~/.pi/skills/{animation-best-practices,remotion-best-practices,react-doctor}`.

---

## 2. Headless / non-interactive execution ✅ (this is Pi's strong suit)

Pi has **four modes** (`--mode`, plus `-p`). Three are non-interactive and directly drivable:

| Mode | Invocation | Output | Use for |
|---|---|---|---|
| **Print** | `pi -p "…"` | final text, then exit | quick scripting |
| **JSON stream** | `pi --mode json "…"` | **JSONL event stream** on stdout, then exit | **programmatic driving of a one-shot agent** (what delamain wants) |
| **RPC** | `pi --mode rpc` | bidirectional JSONL over stdin/stdout, long-lived | embedding a persistent, steerable agent |
| Interactive | `pi` | TUI | humans |

**Exact one-shot command Pi's own subagent extension uses ✅** (from `examples/extensions/subagent/index.ts`, spawned via `child_process.spawn("pi", args)`):
```
pi --mode json -p --no-session [--model <id>] [--tools t1,t2] --append-system-prompt <tmpfile.md> "Task: <task text>"
```
- `--append-system-prompt` accepts **text OR a file path** (extension writes the agent persona to a temp `.md`, mode 0600).
- `--no-session` = ephemeral (no JSONL session written).
- Other useful flags: `--session-dir <dir>`, `--session <path>`, `--continue`/`-c`, `--no-extensions`/`-ne`, `--no-skills`/`-ns`, `--offline`, `--export session.jsonl out.html`.

**JSON event stream shape ✅** (`docs/json.md`). Line 1 is a session header, then events:
```
{"type":"session","version":3,"id":"…","cwd":"…"}
{"type":"agent_start"} / {"type":"turn_start"}
{"type":"message_start"|"message_update"|"message_end","message":{…}}
{"type":"tool_execution_start"|"tool_execution_update"|"tool_execution_end","toolName","args","result","isError"}
{"type":"turn_end","message":{…},"toolResults":[…]}
{"type":"agent_end","messages":[…]}
```
Also `auto_compaction_start/end`, `auto_retry_start/end`. **Parsing recipe actually used** (subagent/index.ts lines 465–500): accumulate on `message_end` — push `event.message`; when `role==="assistant"` read `msg.usage` (`input, output, cacheRead, cacheWrite, cost.total, totalTokens`), `msg.model`, `msg.stopReason`, `msg.errorMessage`; final answer = last assistant text part. Error if `exitCode!==0 || stopReason ∈ {error,aborted}`.

**RPC protocol ✅** (`docs/rpc.md`, 33KB): commands `prompt` / `steer` / `follow_up` / `abort` / `new_session` / `get_state` / `get_messages` / `set_model` / `cycle_model` / `set_thinking_level` / `set_steering_mode` / `set_follow_up_mode`. `steer` = interrupt mid-run (delivered after current tool, skips remaining); `follow_up` = deliver only once agent goes idle. **Strict JSONL framing (LF only)** — the docs explicitly warn Node `readline` is non-compliant (splits on U+2028/2029). This is the interface for a *persistent, steerable* Pi you talk to across many turns.

**Live smoke test ✅** — I ran `pi --mode json -p --no-session --no-tools --model claude-haiku-4-5 "Reply with exactly: PONG"` in the delamain repo. It emitted the correct session header line, then errored: `Authentication failed for "anthropic"… Run '/login anthropic'`. **So the spawn + JSONL framing + error surfacing are verified; a full agent turn could not run because the stored Anthropic OAuth token is expired.** For programmatic use, pass a live key via env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / …) or `--api-key`, or `pi` (interactive) `/login`.

---

## 3. Native sub-agents / agent teams / orchestration / workflows

**Verdict ✅: Pi has NO built-in workflow/orchestration engine and NO built-in sub-agent tool.** Theo's claim ("you'll have to build all orchestration yourself") is **CONFIRMED** against the shipped code — the loop terminates per-turn, but multi-phase fan-out/verify/loop is not a first-class concept. What Pi ships instead is the *substrate* + an **official example extension** you copy:

**`examples/extensions/subagent/` ✅ — the canonical orchestration pattern (fully read).** A ~1140-line extension that registers one `subagent` tool with three modes:
- **single**: `{ agent, task }`
- **parallel**: `{ tasks:[{agent,task,cwd?}] }` — **max 8 tasks, 4 concurrent** (`mapWithConcurrencyLimit`), all streaming live.
- **chain**: `{ chain:[{agent,task}] }` — **sequential handoff**, each step's `task` may contain a `{previous}` placeholder replaced with the prior step's final output; **stops at first failing step** (`exitCode!==0 || stopReason∈{error,aborted}`).

Each sub-agent = **a separate `pi --mode json -p --no-session` subprocess with an isolated context window**, defined by a markdown "agent card" (`~/.pi/agent/agents/*.md`, or project-local `.pi/agents/*.md` with `agentScope:"both"` + a trust confirmation prompt). Agent card frontmatter: `name`, `description`, `tools`, `model` (e.g. scout=Haiku read-only recon; planner=Sonnet; reviewer=Sonnet+bash; worker=Sonnet all-tools). **Workflow "presets" are just prompt-template `.md` files** (`/implement` = scout→planner→worker; `/implement-and-review` = worker→reviewer→worker) that instruct the top agent to call the `subagent` tool with a `chain`. So even "workflows" are prompt-driven, not code-driven control flow.

**Two takeaways for delamain:**
1. Pi's "fan-out / chain / verify-loop" is **LLM-orchestrated** (a driver agent decides to call `subagent` with a chain). It is *not* deterministic code-defined control flow, and the loop's termination is model-judgment, not a coded fixpoint. For **CODE-DEFINED multi-phase workflows that provably terminate**, you should own the loop in delamain (TypeScript) and use Pi only as the per-node worker — exactly mirroring how delamain already owns the loop and shells out to codex/cursor. The subagent extension is your reference implementation for the *spawn+parse* half.
2. Everything sub-agent-ish is built from two primitives you can reuse directly: **`spawn("pi", ["--mode","json","-p",…])`** + the **JSONL parser**.

Other relevant example extensions ✅: `handoff.ts` = intra-process *context transfer* (LLM-summarize current thread into a fresh focused prompt — this is the "Pi to Pi" handoff idea, but same-process, not two processes); `bash-spawn-hook.ts`, `tool-override.ts`, `dynamic-tools.ts`, `permission-gate.ts`, `git-checkpoint.ts`, `auto-commit-on-exit.ts`, `plan-mode/`.

**Adjacent proof the user already has ✅:** `/home/joshuaduffill/dev/gsd-cursor-dispatch/docs/parallel-orchestration.md` documents a **GSD-branded Pi fork** doing exactly delamain-style orchestration: a coordinator + N workers, **git worktrees per unit** (`.gsd/worktrees/<MID>`), **file-based IPC** (`.status.json` heartbeats + `.signal.json` pause/resume/stop), eligibility analysis (deps + file-overlap), budget ceilings, `GSD_PARALLEL_WORKER` to block nested spawns, conflict-aware merge. This is a real-world template for wrapping Pi in a terminating multi-phase driver.

---

## 4. MCP client + server support

- **Native MCP: NONE ✅.** `grep -ri mcp` across `@mariozechner/pi-coding-agent/dist`, `pi-agent-core/dist`, and `pi-ai/dist` finds **zero** real hits (only a false positive inside a vendored `highlight.min.js`). `pi --help` has no `mcp` command. Pi is *not* an MCP client out of the box and does *not* expose an MCP server. Its programmatic surfaces are the **SDK, RPC mode, and JSON mode** — MCP is simply not the integration mechanism.
- **MCP client via third-party extension 🌐:** npm has **`pi-mcp-adapter` v2.11.0** (by `nicopreme`, published 2026-07-03, keywords `pi-package pi mcp model-context-protocol`) — *"MCP adapter extension for Pi coding agent."* This is how you'd let a Pi agent consume MCP servers (install with `pi install npm:pi-mcp-adapter`). Unverified beyond the registry listing — treat as a lead, inspect before trusting.
- **MCP server (Pi-as-server): NONE.** Nothing exposes Pi's tools/session over MCP. To let another MCP host drive Pi, you wrap Pi yourself (RPC/JSON subprocess behind your own MCP tools) — which is precisely what delamain would do.
- Also on npm 🌐: `@oh-my-pi/pi-coding-agent` (a fork, v17.x) and `@hypabolic/pi-hypa` (context-compression extension). Ecosystem is small/young.

**Implication:** delamain's MCP layer stays the integration hub. Pi doesn't speak MCP; delamain speaks MCP outward and spawns Pi inward as a subprocess.

---

## 5. Adding Pi as a delamain ENGINE (analogous to cursor-agent) ✅ — concrete

delamain's engine seam is clean and Pi drops into it as a **third arm**. Verified shape:
- `src/types.ts`: `export type PeerEngine = "codex" | "cursor";` (used on `PeerRecord.engine`, default backfilled to `"codex"`).
- `src/runner.ts::runPeer()`: `if (args.engine === "cursor") return runCursorPeer({…}); ` else falls through to the codex path (`spawn("codex", codexArgs, {cwd, detached, stdio:["pipe","pipe","pipe"]})`).
- `src/cursorRunner.ts`: spawns `process.env.CURSOR_AGENT_BIN || "cursor-agent"`, reads **newline-delimited stdout**, calls `handleStdoutLine` → `parseCursorJsonLine` (`src/cursorEvents.ts`) → normalizes into the shared `ParsedCodexEvent` shape (`{type,itemType,isAgentMessage,threadId,text,label,waitingQuestion}`), updates the peer store via `updatePeer`, heartbeats every 5s, and on `close` pushes the peer branch (`pushPeerBranch`) + integrates.
- `src/peerManager.ts`: forwards `--engine <engine>` (and cursor-only flags) to the runner subprocess; `spawn_peer` MCP tool exposes `engine` (`src/mcpServer.ts` doc: *"'cursor' shells out to cursor-agent…"*).

**Drop-in plan for a `pi` engine:**

1. `PeerEngine = "codex" | "cursor" | "pi"` in `src/types.ts`; thread it through `peerManager` (`--engine pi`), `runner.ts` dispatch, and the `spawn_peer` enum in `mcpServer.ts`.
2. **`src/piRunner.ts`** (clone `cursorRunner.ts`). Build args:
   ```ts
   const bin = process.env.PI_BIN || "pi";
   const args = ["--mode","json","-p","--session-dir", peerSessionDir]; // keep session (not --no-session) so resume works
   if (model)  args.push("--model", model);            // e.g. "openai/gpt-5-codex", "anthropic/claude-sonnet-4-5:high"
   if (tools)  args.push("--tools", tools.join(","));
   if (persona) args.push("--append-system-prompt", personaTmpFile);
   args.push("--no-extensions","--no-skills");          // hermetic peer; opt in explicitly if you want them
   args.push(`Task: ${prompt}`);
   const child = spawn(bin, args, { cwd: repo, detached:true, stdio:["ignore","pipe","pipe"],
       env: { ...process.env /*, ANTHROPIC_API_KEY / OPENAI_API_KEY must be live */ } });
   ```
   Auth note ✅: unlike codex (which delamain isolates via `CODEX_HOME`), Pi reads `~/.pi/agent/auth.json` **or** provider env vars / `--api-key`. Give the peer a live key via env (the stored Anthropic OAuth is expired). Consider a `PI_CONFIG`/`--session-dir` under `~/.delamain/…` to isolate peer sessions.
3. **`src/piEvents.ts`** — parse Pi's JSONL into `ParsedCodexEvent`:
   - `message_end` + `message.role==="assistant"` → text parts → `text`/`label`; capture `stopReason` (`stop`=done, `error`/`aborted`=fail), `usage`, `model`.
   - `tool_execution_start`/`end` → write-tool detection for your dirty-tree/integration signal (reuse cursor's `WRITE_TOOL_HINTS`).
   - `agent_end` → turn complete → trigger `pushPeerBranch` (Pi does NOT auto-commit; delamain's existing commit→merge→push integration applies unchanged).
   - `waitingQuestion`: Pi has no native "WAITING" convention like codex's `CODEX_PEERS_STATUS: WAITING`; if you want interactive peers, run Pi in **`--mode rpc`** instead and use `steer`/`follow_up` for `send_peer_reply`. For fire-and-forget peers, `--mode json -p` is simpler.
4. Model mapping: accept Pi's `provider/id[:thinking]` syntax directly (already how the `--model` arg works). For "codex-max + xhigh": `--model openai/<codex-max-id> --thinking xhigh`.

**Net:** a Pi engine is ~2 new files + an enum widen, structurally identical to the cursor engine. Pi's `--mode json` stream is *richer and better-specified* than cursor-agent's (typed `AgentSessionEvent` union, per-message usage/cost), so parsing is actually easier.

---

## 6. Pi as the TOP-LEVEL orchestrator calling delamain's MCP tools

Pi can be the driver, but **because Pi has no native MCP client**, "call delamain's MCP tools" needs a bridge. Three concrete options, best-first:

**Option A — Custom Pi extension wrapping delamain (recommended).** Write a Pi extension (TS, `~/.pi/agent/extensions/delamain/index.ts`) that `pi.registerTool(...)` for `spawn_peer`, `wait_for_peer`, `list_peers`, etc. Implementation options: (a) import delamain's TS APIs in-process (delamain is ESM TS — you can call `peerManager`/`store` directly), or (b) spawn delamain's CLI, or (c) open an MCP stdio client to delamain's `mcpServer.ts` from inside the extension. Then a top-level Pi agent (interactive or `--mode rpc`) issues natural-language requests and Pi calls those tools. This gives Pi a native, typed, TUI-rendered orchestration toolset. **But note the control-flow caveat from §3: the *loop* is then LLM-driven, so "terminates" depends on the driver model's judgment** — fine for interactive supervision, weaker for guaranteed-terminating batch workflows.

**Option B — `pi-mcp-adapter` 🌐 (fastest, least code).** `pi install npm:pi-mcp-adapter`, point it at delamain's MCP server (`node dist/mcpServer.js` / whatever stdio entry), and delamain's tools appear as Pi tools. Zero delamain changes. Risk: third-party extension, unverified; audit before use.

**Option C — bash bridge (crudest).** Give the Pi agent only the `bash` tool + a skill/prompt-template describing a `delamain` CLI (`delamain spawn --engine codex …`, `delamain wait <id>`). Pi drives delamain by shelling out. No MCP at all. Trivial but loses structured results.

**Recommended architecture given your goals.** Keep **delamain as the deterministic, code-defined top-level driver** (it already owns the terminating loop, worktrees, integration, dashboard, and the MCP server). Use **Pi as a worker engine (§5)** and, optionally, as an *added model path* to OpenAI codex-max/xhigh. If you additionally want a conversational "orchestrator agent" a human can talk to, run **Pi in `--mode rpc`** with an extension exposing delamain's MCP tools (Option A) — but let the *guaranteed-termination* fan-out/verify/loop logic live in delamain TypeScript (like `spawnGsdPhaseBatch` / the gsd-cursor-dispatch coordinator pattern), not inside a Pi prompt. That gives you: code-defined control flow + termination (delamain) × isolated multi-model workers with the best headless event stream of the three engines (Pi), and codex-cli "ultra mode" remains available through delamain's existing `codex exec --json` engine.

---

### Key file references
- Pi CLI: `/home/joshuaduffill/.nvm/versions/node/v25.5.0/bin/pi`
- Installed docs (authoritative): `/home/joshuaduffill/.nvm/versions/node/v25.5.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/{json.md,rpc.md,sdk.md,extensions.md,models.md,skills.md,packages.md}`
- **Sub-agent reference impl:** `…/pi-coding-agent/examples/extensions/subagent/{index.ts,README.md,agents/*.md,prompts/*.md}`
- Local narrative docs: `/home/joshuaduffill/dev/gsd-cursor-dispatch/docs/what-is-pi/*.md` and `…/docs/parallel-orchestration.md`
- Pi config/auth: `/home/joshuaduffill/.pi/agent/{settings.json,auth.json}` (auth token **expired**)
- delamain engine seam: `/home/joshuaduffill/dev/delamain/src/{types.ts (PeerEngine L24),runner.ts (dispatch L31-50),cursorRunner.ts,cursorEvents.ts,codexEvents.ts,peerManager.ts,mcpServer.ts}`