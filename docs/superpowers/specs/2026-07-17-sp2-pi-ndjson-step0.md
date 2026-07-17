# SP2 Step 0 — pi 0.73.1 NDJSON/session/auth — VERIFIED findings

**Date:** 2026-07-17
**Status:** Verification complete (docs + `dist/*.d.ts` + partial live capture). Supersedes the 0.57.1-based sections of `2026-07-17-sp2-pi-engine-plan.md` — see the "PLAN DELTA" section below.
**Provenance:** cross-verified against the installed package `@mariozechner/pi-coding-agent@0.73.1` by a fan-out of 8 agents (5 investigate dimensions + 2 adversarial verifiers + 1 synthesis). Source-of-truth ranking: `dist/**/*.d.ts` > `docs/json.md` (incomplete) > the 0.57.1 research doc (stale).

## Two load-bearing verification verdicts

1. **NDJSON schema — a naive cursor/codex clone FAILS (`consistent=false`).** `parsePiJsonLine` must be written fresh as a top-level `switch(type)`, NOT by reusing `collectText`/`findThreadId` deep-walkers. Reasons (each verified against `.d.ts`): pi's session/thread `id` is on key `id` and appears **only on line 1**; assistant text is nested in `message.content[]` / `assistantMessageEvent.delta` (deep-walk duplicates it many times); there is **no `agent_message` discriminant and no `.item` wrapper**, so codex's `isAgentMessage` gate never fires and the `CODEX_PEERS_STATUS: WAITING` sentinel is never scanned; tool identity is in `toolName` (cursor's `walkToolUses` matches `tool_use`/`tool_call` and misses pi's `toolCall`).

2. **Resume handle — one opaque string works (`consistent=true`), with a real trap.** Store the session **UUID `id`** (from line 1) in `PeerRecord.threadId`, resume with **`--session <id>`** (never `--resume` — interactive TTY picker; never `--continue` — untargeted newest). `--session <id>` is **cwd-scoped**: resume from the identical worktree cwd **and** identical `--session-dir` or it silently degrades to an interactive fork prompt that hangs headless. And the `.jsonl` isn't written until the first assistant message — a captured id is a **dangling handle** until a `message_end`/`turn_end`/`agent_end` is observed.

## Live capture (confirmed on this host, no key needed)

- Session event (first stdout line, real 0.73.1): `{"type":"session","version":3,"id":"019f710c-...","timestamp":"...","cwd":"/srv/gits/repos/delamain"}` — emitted even with `--no-session`.
- No-key error: `No API key found for <provider>` on **stderr**, exit 1, after one stdout `session` line. `--model anthropic/...` correctly overrides the nominal `google` default.
- The full streaming/tool/failure-exit shapes still need one live-key run — see the LIVE-KEY CONFIRMATION CHECKLIST at the end.

---

All claims are verified against the installed 0.73.1 package. Here is the definitive SP2 step-0 document.

---

# SP2 Step 0 — pi 0.73.1 `--print --mode json` Engine Adapter (definitive)

Installed package: `/usr/lib/node_modules/@mariozechner/pi-coding-agent`, `package.json` → `"version": "0.73.1"`. Every shape below is verified against the version-matched `.d.ts` in that tree; where docs and types disagree the `.d.ts` wins. **No live NDJSON capture was possible** (no provider key configured) — items that still need a live run are flagged `[LIVE-NEEDED]`.

Source-of-truth ranking: `dist/**/*.d.ts` > `docs/json.md` (incomplete — omits 2 discriminants) > the 0.57.1 research doc (stale — see §5).

---

## 1. VERIFIED pi 0.73.1 print/json NDJSON event schema

### The serialization contract

`dist/modes/print-mode.js:85-92`: in `try`, when `mode==="json"` the session **header is written first** (`writeRawStdout(JSON.stringify(header)+"\n")`), *then* `await rebindSession()` calls `session.subscribe(...)` which for every event does `writeRawStdout(JSON.stringify(event)+"\n")` (`print-mode.js:79-83`). So:

- **Line 1 is always the `session` header.**
- Every subsequent line is exactly one `AgentSessionEvent`, JSON-stringified, `\n`-terminated, written synchronously/unbuffered (`output-guard.js` `writeRawStdout`).

`--print --mode json` and bare `--mode json` produce the identical stream: `dist/main.js:79` returns `"json"` when `parsed.mode === "json"` *before* the `parsed.print` branch at `:82`. `--print` is redundant-but-harmless. Prompt is a **positional** arg (`Args.messages`), read via `session.prompt(initialMessage)` — not stdin.

Top-level line discriminants a per-line `switch(type)` must handle (**18**): `session` + the 10 `AgentEvent` + 7 session-level. The 12 `AssistantMessageEvent` variants are **nested** inside `message_update.assistantMessageEvent.type`, never top-level.

### 1.1 `session` (header, line 1)

```json
{"type":"session","version":3,"id":"<uuidv7>","timestamp":"<ISO>","cwd":"/abs/path"}
```
- `dist/core/session-manager.d.ts:5-12` `interface SessionHeader { type:"session"; version?:number; id:string; timestamp:string; cwd:string; parentSession?:string; }`; `CURRENT_SESSION_VERSION = 3` (`:4`).
- **`id` is the session/thread id and appears ONLY here.** No other event carries a session/thread/conversation id (verified: no `AgentEvent`/`AgentSessionEvent` variant has such a field).
- `parentSession` present only on forked sessions. No file-path field is in the stream.

### 1.2 `agent_start`
```json
{"type":"agent_start"}
```
`pi-agent-core/dist/types.d.ts:330-331`.

### 1.3 `agent_end` (last event of a run)
```json
{"type":"agent_end","messages":[<AgentMessage>...]}
```
`types.d.ts:333-335`. Comment `:326`: "agent_end is the last event emitted for a run." `messages` = all messages generated this run. `[LIVE-NEEDED]` whether `messages` is per-run only or cumulative across sequential `session.prompt()` calls (matters for multi-prompt resume cost accounting).

### 1.4 `turn_start`
```json
{"type":"turn_start"}
```
`types.d.ts:336-337`. One prompt can emit multiple turn_start/turn_end pairs before one `agent_end`.

### 1.5 `turn_end`
```json
{"type":"turn_end","message":<AgentMessage>,"toolResults":[<ToolResultMessage>...]}
```
`types.d.ts:338-341`.

### 1.6 `message_start` / `message_end`
```json
{"type":"message_start","message":<AgentMessage>}
{"type":"message_end","message":<AgentMessage>}
```
`types.d.ts:342-343`, `:349-350`. **`message_end.message` is the final assistant message** (== `turn_end.message` == last `role:"assistant"` in `agent_end.messages`).

### 1.7 `message_update` (streaming deltas)
```json
{"type":"message_update","message":<AgentMessage>,"assistantMessageEvent":<AssistantMessageEvent>}
```
`types.d.ts:344-347`. Carries BOTH a full `message` snapshot AND `assistantMessageEvent.partial` (another full snapshot) — the duplication hazard for recursive text walkers (see §2).

`assistantMessageEvent` (12 nested variants, `pi-ai/dist/types.d.ts:187-241`), each with `contentIndex` and a `partial:AssistantMessage` unless noted:
- `start` `{partial}`
- `text_start` `{contentIndex,partial}`
- **`text_delta` `{contentIndex,delta,partial}`** ← incremental token in `delta`
- `text_end` `{contentIndex,content,partial}` ← `content` = the whole finished text block
- `thinking_start` / `thinking_delta {delta}` / `thinking_end {content}`
- `toolcall_start` / `toolcall_delta {delta}` / `toolcall_end {toolCall:ToolCall}`
- `done` `{reason: "stop"|"length"|"toolUse", message}`
- `error` `{reason: "aborted"|"error", error:AssistantMessage}`

### 1.8 `tool_execution_start` / `_update` / `_end`
```json
{"type":"tool_execution_start","toolCallId":"<id>","toolName":"<name>","args":<any>}
{"type":"tool_execution_update","toolCallId":"<id>","toolName":"<name>","args":<any>,"partialResult":<any>}
{"type":"tool_execution_end","toolCallId":"<id>","toolName":"<name>","result":<any>,"isError":<bool>}
```
`types.d.ts:351-368`. `partialResult` is the **accumulated** result (not a delta). Correlate via `toolCallId`. Tool identity is `toolName`. `args`/`result`/`partialResult` are typed `any` — shapes are tool-specific; `[LIVE-NEEDED]` for exact per-tool arg keys (note: built-in `edit` tool uses `edits[]`, not `oldText/newText`, since 0.63.2).

### 1.9 `queue_update`
```json
{"type":"queue_update","steering":[...],"followUp":[...]}
```
`agent-session.d.ts:41-44`. Steering/follow-up queue snapshots (RPC-oriented). Not in the 0.57.1 doc.

### 1.10 `compaction_start` / `compaction_end`
```json
{"type":"compaction_start","reason":"manual"|"threshold"|"overflow"}
{"type":"compaction_end","reason":"manual"|"threshold"|"overflow","result":<CompactionResult|undefined>,"aborted":<bool>,"willRetry":<bool>,"errorMessage":"<opt>"}
```
`agent-session.d.ts:44-59`. **Renamed** from 0.57.1's `auto_compaction_*` (drift, §5).

### 1.11 `session_info_changed` / `thinking_level_changed`
```json
{"type":"session_info_changed","name":"<string|undefined>"}
{"type":"thinking_level_changed","level":"off"|"minimal"|"low"|"medium"|"high"|"xhigh"}
```
`agent-session.d.ts:46-52`. **Both are ABSENT from the shipped `docs/json.md`** — a parser built from json.md alone hits an unhandled `default` here. `ThinkingLevel` (pi-agent-core) includes `"off"`.

### 1.12 `auto_retry_start` / `auto_retry_end`
```json
{"type":"auto_retry_start","attempt":<n>,"maxAttempts":<n>,"delayMs":<n>,"errorMessage":"<str>"}
{"type":"auto_retry_end","success":<bool>,"attempt":<n>,"finalError":"<opt>"}
```
`agent-session.d.ts:60-71`.

### Payload sub-types (verified, `pi-ai/dist/types.d.ts`)

- `AssistantMessage` (`:150-162`): `{role:"assistant", content:(TextContent|ThinkingContent|ToolCall)[], api, provider, model, responseModel?, responseId?, diagnostics?, usage:Usage, stopReason:StopReason, errorMessage?, timestamp}`.
- `TextContent` `{type:"text", text, textSignature?}` (`:98-102`).
- `ThinkingContent` `{type:"thinking", thinking, ...}` (`:103-113`).
- **`ToolCall` `{type:"toolCall", id, name, arguments, thoughtSignature?}`** (`:119-125`) — camelCase `toolCall`, NOT cursor's `tool_use`/`tool_call`.
- `ToolResultMessage` `{role:"toolResult", toolCallId, toolName, content:(TextContent|ImageContent)[], details?, isError, timestamp}` (`:163-171`).
- `StopReason = "stop"|"length"|"toolUse"|"error"|"aborted"` (`:144`).
- `Usage` `{input,output,cacheRead,cacheWrite,totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}` (`:126-142`).

### Error surfacing (verified — CRITICAL for exit handling)

- **There is NO top-level `error` event.** Model failure = (a) a `message_update` with `assistantMessageEvent.type==="error"`, and (b) the final `AssistantMessage.stopReason ∈ {"error","aborted"}` + `errorMessage`.
- **In JSON mode the process exit code stays 0 even on model failure.** `print-mode.js:99` — the `stopReason→exitCode=1` block is nested inside `if (mode === "text")` (`:104-106`). JSON mode never runs it. `piRunner` must derive failure from `stopReason`, not from the exit code.
- Fatal setup errors (no model, no key, thrown) print to **stderr** and `process.exit(1)`, bypassing the JSON stream (the session header line may still have been emitted first — see §3 auth).
- `extension_error` appears in `docs/rpc.md` but is **not** in the `AgentSessionEvent` union; in print mode extension errors go to stderr (`print-mode.js:75`). Do not rely on it. `[LIVE-NEEDED]` to fully confirm it never appears on stdout.

---

## 2. `parsePiJsonLine(line) -> ParsedCodexEvent` mapping

A naive clone of `codexEvents`/`cursorEvents` **fails 3 of 5 abilities** (session id, streamed text, waiting sentinel) and is partial on tool labels, because pi's schema is structurally different: flat top-level `type` (no `agent_message`, no `.item` wrapper), id only on line 1 under key `id`, assistant text nested in `message.content[]`, tool identity in `toolName`. Do **not** reuse `findThreadId`/`collectText` deep-walkers. Switch on top-level `type`.

Target type (`src/codexEvents.ts:20-28`): `{ type?, itemType?, isAgentMessage?, threadId?, text?, label?, waitingQuestion? }`. Reuse `parseWaitingQuestion` and `trim` verbatim (`import ... from "./codexEvents.js"`).

```ts
import { parseWaitingQuestion, trim } from "./codexEvents.js";
import type { ParsedCodexEvent } from "./codexEvents.js";

const WRITE_TOOL_HINTS = ["write", "edit", "str_replace", "create_file", "patch", "apply_patch", "file_write", "multiedit"];

export function parsePiJsonLine(line: string): ParsedCodexEvent {
  const trimmed = line.trim();
  if (!trimmed) return {};
  let ev: any;
  try { ev = JSON.parse(trimmed); } catch { return parseFallbackText(trimmed); }
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return {};

  const type: string | undefined = typeof ev.type === "string" ? ev.type : undefined;

  switch (type) {
    // (a) SESSION ID — special case, first line only. NOT via THREAD_ID_KEYS.
    case "session":
      return { type, threadId: typeof ev.id === "string" ? ev.id : undefined,
               label: `session ${trim(String(ev.id ?? ""), 60)}` };

    // (b) STREAMED TEXT — only the incremental delta; ignore message/partial snapshots.
    case "message_update": {
      const am = ev.assistantMessageEvent;
      if (am?.type === "text_delta" && typeof am.delta === "string")
        return { type, text: am.delta, label: undefined };
      if (am?.type === "error") { // model error mid-stream
        const msg = amText(am.error);
        return { type, isAgentMessage: true, text: msg,
                 label: `error: ${trim(am.error?.errorMessage || msg || "", 140)}`,
                 waitingQuestion: msg ? parseWaitingQuestion(msg) : undefined };
      }
      return { type }; // text_start/end, thinking_*, toolcall_* — no user-visible text
    }

    // (c)+(d) FINAL ASSISTANT MESSAGE + waiting sentinel.
    // message_end.message is the definitive final assistant text.
    case "message_end": {
      const m = ev.message;
      if (m?.role !== "assistant") return { type };
      const text = assistantText(m);          // join content[].text where type==="text"
      const failed = m.stopReason === "error" || m.stopReason === "aborted";
      return {
        type,
        isAgentMessage: true,                 // drives lifecycle terminal-response state
        text: text || undefined,
        label: failed ? `message_end error: ${trim(m.errorMessage || text || "", 140)}`
                      : trim(text, 140) || "message_end",
        waitingQuestion: text ? parseWaitingQuestion(text) : undefined,
      };
    }

    case "agent_end":
      return { type, label: "agent_end" };    // turn/run terminal marker

    // (e) TOOL LABELS — read toolName directly; correlate via toolCallId.
    case "tool_execution_start":
      return { type, label: `tool ${ev.toolName ?? "?"}${argHint(ev.args)}` };
    case "tool_execution_end":
      return { type, label: `tool ${ev.toolName ?? "?"} ${ev.isError ? "error" : "ok"}` };
    case "tool_execution_update":
      return { type };

    default: // turn_start, agent_start, queue_update, compaction_*, *_changed, auto_retry_*
      return { type, label: type };
  }
}

function assistantText(m: any): string {
  if (!Array.isArray(m?.content)) return "";
  return m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string")
                  .map((c: any) => c.text).join("\n").trim();
}
function amText(am: any): string { return assistantText(am); } // AssistantMessage shape

function parseFallbackText(text: string): ParsedCodexEvent {
  return { text, label: trim(text, 180), isAgentMessage: true, waitingQuestion: parseWaitingQuestion(text) };
}
function argHint(args: any): string { /* best-effort: file path/command, trimmed */ return ""; }

export function looksLikeFileWrite(name?: string): boolean {
  return !!name && WRITE_TOOL_HINTS.some((h) => name.toLowerCase().includes(h));
}
```

Notes / rationale (each verified):
- **(a) id capture:** `codexEvents.THREAD_ID_KEYS` (`:1-8`) lacks bare `id`; `cursorEvents.CHAT_ID_KEYS` too. Only the `session` line has it. Do NOT widen the generic key sets — read `ev.id` only when `type==="session"`. `piRunner` carries it forward onto `peer.threadId` (per-line parsing can't recover it for later lines).
- **(b) text:** emit only `text_delta.delta`. If you also harvested `message`/`partial`/`text_end.content`, the accumulated answer duplicates many times over. `piRunner` should accumulate `parsed.text` into `collectedText` (as cursorRunner does) — for pi, prefer taking the final answer from `message_end` rather than the delta stream to avoid any drift.
- **(c) final text** is nested at `message.content[].text` (type `"text"`), never a top-level `text` field.
- **(d) waiting:** codex's gate `type==="agent_message" || itemType==="agent_message"` is always false for pi. Set `isAgentMessage` from `message_end` with `role==="assistant"`, then run the engine-agnostic `parseWaitingQuestion` on the final text so `CODEX_PEERS_STATUS: WAITING` / `QUESTION:` still drives `status:"waiting"`. `[LIVE-NEEDED]`: confirm the sentinel survives verbatim through pi's assistant `content[].text` (no reformatting).
- **(e) labels:** `eventLabel`/`collectText` never read `toolName`. Read it directly. `walkToolUses` matches `tool_use`/`tool_call` and would miss pi's `toolCall` — use the `tool_execution_*` events for write detection instead.

---

## 3. `runPiPeer(args)` — argv, auth preflight, wiring

Clone `src/cursorRunner.ts` skeleton (detached `spawn`, `enginePid = child.pid`, 5s heartbeat, line-buffered stdout → `parsePiJsonLine` → `updatePeer`, `close` → terminal status + branch push). Binary: `process.env.PI_BIN || "pi"`.

### 3.1 Fresh-run argv
```
pi --print --mode json \
   --model <provider/id[:thinking]> \
   [--tools read,bash,edit,write] \
   --session-dir <peersHome>/pi-sessions/<peerId> \
   "<wrapped prompt>"          # LAST positional
```
- `--mode json` alone selects the stream; `--print` redundant-but-harmless (`main.js:79`). Keep both for explicitness.
- **Prompt must be the LAST arg.** `-p`/`--print` greedily consumes the next token as a message unless it starts with `@`/`-`; keep the prompt after `--mode json` and all flags.
- **Always pass an explicit `--model provider/id`.** There is no real hardcoded default at runtime — `findInitialModel` walks CLI→scoped→settings→first-authed-provider (`model-resolver.js`), so an omitted model is nondeterministic across environments. The `--provider` help text "default: google" is nominal only.
- Optional `--session-dir` per peer for isolation (see §4). Set `PI_CODING_AGENT_DIR=<per-peer dir>` if you want full config isolation (this IS pi's CODEX_HOME analog — the 0.57.1-based plan's "no isolation" claim is wrong; see §5).

`wrapPiPrompt` = a copy of `wrapCursorPrompt` (`cursorRunner.ts:268-293`) with the same operational contract and the `CODEX_PEERS_STATUS: WAITING` / `QUESTION:` sentinel block, so waiting-detection is identical.

### 3.2 Resume argv
```
pi --print --mode json \
   --model <provider/id[:thinking]> \
   --session-dir <SAME peersHome>/pi-sessions/<peerId> \
   --session <threadId> \
   "<wrapped follow-up prompt>"
```
- Use `--session <id>`; **never** `--resume` (interactive TUI picker, needs a TTY — `main.js:200-208`) or `--continue` (untargeted most-recent — `main.js:214-215`). `--fork` mints a NEW id, so it is a branch, not a continuation.
- `--session` with a bare UUID does a **cwd-scoped** local lookup (`resolveSessionPath`, `main.js:106-125` → `SessionManager.list(cwd, sessionDir)`). On a local miss it falls to a cross-project `listAll()` whose hit triggers an interactive `promptConfirm("Fork this session into current directory?")` (`main.js:188`) — which **hangs headless**. Mitigation: resume from the identical worktree cwd AND identical `--session-dir` (guarantees the local hit). Belt-and-suspenders: store the absolute `.jsonl` path instead of the id (path branch → `SessionManager.open`, zero cwd dependence, no prompt).

### 3.3 `checkPiAuth(provider)` preflight (new file `src/piAuth.ts`, modeled on `src/codexAuth.ts`)

Pi already fails cheaply (`exit 1`, before any network call) when the key is absent; the preflight exists for a **clear up-front message**, not to save token spend. Replicate pi's `hasAuth`: ok if EITHER the provider env var is set OR `<agentDir>/auth.json` has an entry keyed by the provider id.

Per-provider env vars (verified `pi-ai/dist/env-api-keys.js:80-116`):
| provider | env var(s), in precedence order |
|---|---|
| `anthropic` | `ANTHROPIC_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` (Gemini) | `GEMINI_API_KEY` (**not** `GOOGLE_*`) |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY` (or ADC) |
| `groq`/`xai`/`openrouter`/`deepseek`/`mistral`/`cerebras`/`zai`/`azure-openai-responses` | `GROQ_/XAI_/OPENROUTER_/DEEPSEEK_/MISTRAL_/CEREBRAS_/ZAI_/AZURE_OPENAI_API_KEY` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` \| `GH_TOKEN` \| `GITHUB_TOKEN` |
| `openai-codex`, Claude Pro/Max | OAuth only (no env var) |

`auth.json` location honors `PI_CODING_AGENT_DIR` (default `~/.pi/agent/auth.json`); keys are provider ids, entries `{type:"api_key"|"oauth", ...}`. Preflight signature mirroring `checkCodexPeerAuth`:
```ts
export function checkPiAuth(provider: string, agentDir = defaultPiAgentDir()):
  | { ok: true; warning?: string } | { ok: false; error: string }
```
Loud failure on `ok:false` (missing env AND no auth.json entry) with the exact `pi /login` / `export <ENV>=...` remedy. For `type:"oauth"` entries, an optional codexAuth-style staleness warning is possible — `[LIVE-NEEDED]` the exact oauth expiry field (no oauth login was performed).

Empirically confirmed no-key behavior: `pi --print --mode json --model anthropic/... "hi"` with the key unset emits exactly ONE stdout line (the `session` header) then writes `No API key found for anthropic.` to **stderr** and exits 1. So the runner must also treat "session header only, then non-zero exit" plus the stderr signature as an auth failure. `[LIVE-NEEDED]` to re-capture this exact wording on the current machine (it was captured in research, worth re-confirming).

### 3.4 enginePid + integrate:false wiring (unchanged from cursor)
- After `spawn`, `updatePeer(peerId, p => ({...p, enginePid: child.pid}))` — `killPeer` (`peerManager.ts:374-375`) and the frozen watchdog already cover `enginePid`, so kill/reap work for free.
- On `close`: `status = waitingQuestion ? "waiting" : code===0 ? "done" : "failed"`. **Additionally**: because JSON-mode exit code stays 0 on model failure (§1), treat a final `message_end` whose `stopReason ∈ {error,aborted}` as `failed` even when `code===0` — track this in the `close` handler (a small departure from cursorRunner, which trusts the exit code).
- `integrate:false`: exactly as codex/cursor — when the record's `integrate === false`, skip the branch push in the `done` block (a workflow leaf). Mirror the wave-1 runner guard. `--no-integrate` flows through `buildRunnerArgv` (`peerManager.ts`) already.

---

## 4. Resume wiring — `threadId ⇄ --session`, stable `--session-dir`, runner translation

**Yes — one opaque string in `PeerRecord.threadId` suffices**, symmetric with codex. Store the session `id` (uuidv7) captured from the first NDJSON `session` line.

- **Capture:** `handleStdoutLine` → `parsePiJsonLine` returns `threadId` for the `session` line; `updatePeer(p => ({...p, threadId: parsed.threadId || p.threadId}))` (identical to cursorRunner `:249`). Also record header `cwd` if you want a same-cwd assertion.
- **Durability caveat:** the `.jsonl` is not flushed to disk until the first assistant message is persisted (`session-manager.js` `_persist` buffers while `hasAssistant` is false). Only treat `threadId` as durably resumable after a `message_end`/`turn_end`/`agent_end` was observed; a crash before any assistant output leaves a dangling id (`--session <id>` → not_found → `exit 1`).
- **Stable `--session-dir` per peer** (`peersHome()/pi-sessions/<peerId>`), passed identically on fresh run AND resume. This isolates the peer's sessions so the cwd-scoped local id lookup is unambiguous and never hits the interactive cross-project fork prompt.

`buildRunnerArgv` / `runner.ts` translation (mirrors the cursor block at `peerManager.ts:531-535`):
- `buildRunnerArgv`: add `if (args.engine === "pi") { push --pi-tools / --pi-thinking / --pi-provider / --pi-session-dir }`. `piOptions` gated like `cursorOptions`.
- `resumePeer` (`peerManager.ts:232-245`) is **unchanged in shape** — it already passes `resumeThread: peer.threadId` and `engine: peer.engine`. The runner-side translation is: for `engine==="pi"`, `--resume-thread <x>` → `pi --session <x>`; for codex → `exec resume <x>`; for cursor → `--resume=<x>`.
- `spawnRunner`/`RunnerArgs`: widen `engine` union to `"codex"|"cursor"|"pi"`; parse `--pi-*` flags in `parseArgs`; add `piOptions` to `RunnerArgs`.

---

## 5. PLAN DELTA — corrections to the 2026-07-17 merged SP2 plan (0.57.1-based)

Line references are to `docs/superpowers/specs/2026-07-17-sp2-pi-engine-plan.md`.

1. **§2 / line 46 — do NOT "keep the `collectText`/`findThreadId` walker shape from `cursorEvents.ts`."** This is the single biggest correction. Reusing recursive `collectText` grossly duplicates text (every `message_update` carries `message` + `assistantMessageEvent.partial`, both full snapshots), and `findThreadId` never captures pi's id (key is bare `id`, only on line 1). **Rewrite `parsePiJsonLine` as a top-level `switch(type)`** (§2), not a walker clone.

2. **§2 / line 42 — text delta path is correct but under-specified.** The delta lives at `message_update.assistantMessageEvent.delta` only when `assistantMessageEvent.type==="text_delta"`. Prefer taking the *final* answer from `message_end.message.content[].text`, not the delta stream.

3. **§2 / line 43 — `message_end` gating.** The plan's `message_end → final text → parseWaitingQuestion` is right, but note pi has **no `agent_message` discriminant and no `.item` wrapper**, so `isAgentMessage` must be set from `message_end`/`agent_end` `role==="assistant"`, not from any codex-style type check.

4. **§2 — add the 2 undocumented events.** `session_info_changed` and `thinking_level_changed` exist in the `.d.ts` but are absent from `docs/json.md`; the `switch` needs a `default` that no-ops them. Also handle `queue_update`, `compaction_start/end` (renamed — next item), `auto_retry_start/end`.

5. **Drift: compaction events renamed.** Any 0.57.1-derived handling of `auto_compaction_start/end` is dead — 0.73.1 emits `compaction_start`/`compaction_end` with `reason:"manual"|"threshold"|"overflow"`.

6. **§3 / line 51 & §Risks/2 & line 103 — "no CODEX_HOME-style per-peer isolation" is WRONG for 0.73.1.** `PI_CODING_AGENT_DIR` relocates the entire agent dir (auth.json/models.json/settings/sessions); `PI_CODING_AGENT_SESSION_DIR` / `--session-dir` relocate just sessions. The plan should set `PI_CODING_AGENT_DIR` (or at least `--session-dir`) per peer for isolation, exactly like `CODEX_HOME`. Update Risk 2 accordingly.

7. **§3 / line 51 — auth exit behavior.** Correct that JSON mode exits 0 on *model* failure (stopReason error/aborted); only *setup* failures (no key/model) exit 1 with a stderr message and a lone stdout `session` header. `checkPiAuth` should key on env-var / auth.json presence (per-provider table §3.3), and the runner must additionally detect stopReason-based failure from the stream.

8. **§3 / line 51 — env var precision.** For anthropic the precedence is `ANTHROPIC_OAUTH_TOKEN` then `ANTHROPIC_API_KEY`; for google it is `GEMINI_API_KEY` (the plan lists `GEMINI_API_KEY` — correct — but should note it is NOT `GOOGLE_*`).

9. **§Resume / lines 19, 82-85 — resume-by-id caveat.** `--session <id>` is **cwd-scoped**; a bare-id resume from a different cwd or `--session-dir` silently degrades to an interactive fork prompt that hangs headless. The plan's "stable `--session-dir`" is the right mitigation but must be passed identically on both spawn and resume, from the same worktree cwd. Add the fallback: store the absolute `.jsonl` path (cwd-independent) if same-cwd cannot be guaranteed. Also: the `.jsonl` doesn't exist until the first assistant message — mark `threadId` resumable only after a completed turn.

10. **§Resume / line 29 — "`--continue`/`--resume`" listed as resume options is misleading.** Only `--session <id|path>` is deterministic headless. `--resume` needs a TTY; `--continue` is untargeted most-recent. Drop the other two from the resume path.

11. **§Build/1 & Risk 4 — model ids are release-pinned and differ from 0.57.1** (e.g. anthropic default `claude-opus-4-7`, openai `gpt-5.4`, google `gemini-3.1-pro-preview`). Keep pass-through, require explicit `provider/id`, and treat any 0.57.1 model-id constants as stale. Provider roster also expanded (deepseek, cloudflare, fireworks, xiaomi, zai, etc.).

12. **New info for §8 (workflow payoff):** usage/cost is on `AssistantMessage.usage` (`input/output/cacheRead/cacheWrite/totalTokens` + nested `cost`) — available for the plan's usage-capture note.

13. **Tool call shape:** pi assistant tool calls use `type:"toolCall"` (camelCase) and tool events use `toolName`; cursor's `walkToolUses` (matches `tool_use`/`tool_call`) does not transfer — use `tool_execution_*` events for write-tool detection.

14. **Non-blocking positives to keep as-is:** session format is stable at **v3** across the whole 0.57→0.73 window (no migration); stdout hygiene fixed (0.62.0), piped-stdin JSONL preserved (0.65.1), and openai-codex `--print` hang fixed (0.73.0) — all present in 0.73.1.

---

## 6. LIVE-KEY CONFIRMATION CHECKLIST

No provider key is configured (`auth.json` empty; `pi --list-models` → "No models available"; `pi --print --mode json` hangs → exit 124). Before finalizing `piEvents.ts`/fixtures, run each of the following with a real key (e.g. `export ANTHROPIC_API_KEY=...` and `--model anthropic/claude-opus-4-7`), from a scratch dir with an isolated `PI_CODING_AGENT_DIR`:

1. **Capture the canonical NDJSON stream** (the golden fixture for `tests/piEvents.test.mjs`):
   ```
   PI_CODING_AGENT_DIR=/tmp/pi-cap pi --print --mode json --model anthropic/claude-opus-4-7 \
     --session-dir /tmp/pi-cap/s "Say hello, then stop." > /tmp/pi.ndjson 2> /tmp/pi.err ; echo "exit=$?"
   ```
   Confirm: line 1 is `{"type":"session",...}` with `id`; exact key ordering / optional-field presence on `session`, `message_update.text_delta`, `message_end.message`, `agent_end`.

2. **Streaming text shape** — confirm `assistantMessageEvent.type==="text_delta"` carries `delta` and that the final `message_end.message.content[]` `type:"text"` text equals the concatenation of deltas:
   ```
   jq -c 'select(.type=="message_update") | .assistantMessageEvent | select(.type=="text_delta") | .delta' /tmp/pi.ndjson
   jq -c 'select(.type=="message_end") | .message.content' /tmp/pi.ndjson
   ```

3. **Waiting sentinel round-trip** — prompt the peer to emit the sentinel and confirm it survives verbatim in `message_end` text so `parseWaitingQuestion` fires:
   ```
   pi --print --mode json --model anthropic/claude-opus-4-7 --session-dir /tmp/pi-cap/s \
     "Reply with exactly: CODEX_PEERS_STATUS: WAITING\nQUESTION: which branch?" | \
     jq -c 'select(.type=="message_end") | .message.content'
   ```

4. **Tool-execution arg shapes** — trigger a bash + edit tool call, capture `tool_execution_start.args` / `_end.result` per tool (for labels and write detection):
   ```
   pi --print --mode json --model anthropic/claude-opus-4-7 --tools read,bash,edit,write --session-dir /tmp/pi-cap/s \
     "Run 'ls' then create file /tmp/x.txt with 'hi'." | jq -c 'select(.type|startswith("tool_execution"))'
   ```

5. **Failure exit code** — confirm JSON mode exits **0** on a `stopReason:"error"/"aborted"` turn (validates §3.4 stopReason-based failure detection). Easiest: abort mid-run, or force an error, then `echo exit=$?` and `jq 'select(.type=="message_end").message.stopReason'`.

6. **Resume determinism** — capture `id` from run (1), then from the SAME cwd + SAME `--session-dir`:
   ```
   pi --print --mode json --model anthropic/claude-opus-4-7 --session-dir /tmp/pi-cap/s \
     --session <id> "What did you just say?" | jq -c 'select(.type=="session")'
   ```
   Confirm it re-opens (no fork prompt) and re-emits the same `id`. Then repeat from a *different* cwd to observe the interactive fork-prompt hang (validates the same-cwd requirement).

7. **Auth failure wording** — re-confirm the exact stderr string + exit code on this machine:
   ```
   env -u ANTHROPIC_API_KEY PI_CODING_AGENT_DIR=/tmp/pi-noauth pi --print --mode json \
     --model anthropic/claude-opus-4-7 "hi" ; echo exit=$?
   ```
   Expect: one stdout `session` line, stderr `No API key found for anthropic.`, exit 1. Feed the exact string into `checkPiAuth`'s failure detection.

8. **`--no-session` header presence** `[open question]` — confirm whether the `session` header line is still emitted under `--no-session` (`print-mode.js` guards `if (header)`), since `piRunner` depends on line 1 for `threadId`. The plan uses `--session-dir` (sessions kept), so this is a fallback check only.

Relevant files for implementation: `/srv/gits/repos/delamain/src/piEvents.ts` (new), `/srv/gits/repos/delamain/src/piRunner.ts` (new), `/srv/gits/repos/delamain/src/piAuth.ts` (new, model on `/srv/gits/repos/delamain/src/codexAuth.ts`), and edits to `/srv/gits/repos/delamain/src/types.ts`, `/srv/gits/repos/delamain/src/runner.ts`, `/srv/gits/repos/delamain/src/peerManager.ts`, `/srv/gits/repos/delamain/src/mcpServer.ts`, `/srv/gits/repos/delamain/src/cli.ts`, `/srv/gits/repos/delamain/src/workflow/ctx.ts`.

---

## 7. LIVE-CONFIRMED on pi 0.73.1 (2026-07-17, `openai-codex` OAuth via `pi /login`)

Captured with `openai-codex/gpt-5.4-mini`, default agent dir (holds the OAuth) + scratch `--session-dir`. Golden fixtures committed at `tests/fixtures/pi/0.73.1-{text,tools,resume}.ndjson` (secret-scanned; `partial`/`message` snapshots slimmed on `message_update` lines). Live coverage: **11 of 18** top-level events (`session, agent_start, turn_start, message_start, message_update, message_end, turn_end, agent_end, tool_execution_start/update/end`) and **9 of 12** `assistantMessageEvent` variants (`text_*`, `thinking_*`, `toolcall_*`); the rest (`queue_update`, `compaction_*`, `*_changed`, `auto_retry_*`, `done/error/start`) are situational and stand on the `.d.ts`.

**Confirmed exactly as §1–§4:**
- `session` line 1 real: `{"type":"session","version":3,"id":"019f711f-…","timestamp":"…","cwd":"…"}`; `id` is a uuidv7, only on line 1.
- `message_end` fires for the **`user` message too** (echoed prompt) → the `role==="assistant"` guard is essential; assistant `content:[thinking, text]`, `stopReason:"stop"`, final text from `content[].text`.
- `assistantMessageEvent` order is `thinking_start/delta/end` then `text_start/delta/end` → keying on `type==="text_delta"` (not any `.delta`) is required so reasoning doesn't leak into text.
- Tools: `tool_execution_start {toolName, toolCallId:"call_…|fc_…", args}` with `args` keys `read→path`, `write→content,path`, `bash→command`; `_end {toolName, isError, result:object}`; assistant blocks are `{type:"toolCall", name}` (camelCase). `WRITE_TOOL_HINTS` on `toolName` (`write`/`edit`) works.
- **Resume (the load-bearing decision) — validated as specced:** `--session <id>` from the **same cwd + same `--session-dir`** re-opened the exact session (same `id`, `parentSession:null` = continuation, context retained → answered "hello"), no fork prompt, exit 0. On-disk file `<ts>_<uuid>.jsonl`, **flat under an explicit `--session-dir`** (the `--<cwd>--` subdir only applies to the default dir — simplifies per-peer isolation).

**⚠️ One PARSER REFINEMENT to §2 (confirmed live):** the `text_delta` token *and* the final `message_end` both carry the full answer, so a runner that accumulates both double-counts. **Change the `message_update`/`text_delta` case to NOT set `text`** — return `{ type, label: trim(delta, 180) }` for live progress only — and emit `text` **only** from `message_end` (assistant). `piRunner` then takes `finalResult` from `message_end`, never the delta stream.

**Still open (low-risk, non-blocking):** the WAITING-sentinel *verbatim* round-trip (trust `parseWaitingQuestion` on `message_end` text) and the `stopReason∈{error,aborted}` → exit-0 path (confirmed from `print-mode.js:99-104`, not re-triggered live). `--no-session` still emits the `session` line (confirmed earlier). Model used differs from the doc's `anthropic/claude-opus-4-7` example — this host authed `openai-codex`, so implementation/tests should default to an `openai-codex/*` model here.