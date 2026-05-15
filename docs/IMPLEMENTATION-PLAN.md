# codex-peers — Implementation Plan

Synthesized from 14 parallel research peers (256K of structured analysis under [docs/research/](./research/)). This is the alignment + build plan for evolving `codex-mcp-peers-server` into a self-hosted, multi-engine, GSD-aware peer spawner.

**Date:** 2026-05-15
**Author basis:** see [Sources](#sources) for the 14 primary research docs.

---

## 1. Where we are today

| Capability | Today | Gap to target |
|---|---|---|
| Engine support | `codex` (default) and `cursor` (just landed in `feat/cursor-engine`) | OK for v1; future plugin-style adapter optional |
| Peer isolation | One linked git worktree per peer | OK — the foundational primitive everyone in the field is converging on |
| State authority | JSON `state.json` under `~/.codex-peers/` + per-peer logs | Limited — need a real DB-backed coordination layer for parallel work |
| Workflow model | Free-form prompt per peer; one optional `gsd_phase_batch` mode | Missing milestone → slice → task hierarchy with rule-driven dispatch |
| Supervisor | In-flight on `feat/autonomous-supervisor-telegram-goals` (~613 LOC modified, 80 KB new control plane) | Custom Telegram poller reinventing solved problems |
| Hosting | Local MCP server (in-process to Claude Code) | No daemon boundary, no remote control plane |
| Observability | Logs + dashboard v2 | No structured event stream / OTEL / metrics |
| Cost tracking | `codexUsage.ts` (codex only) | No cursor-side cost; no per-goal aggregation |
| Auth + secrets | `CODEX_HOME`, env-passed credentials | No paired-machine model; not safe for remote/public exposure |
| Recovery | Halt + resume + watchdog stubs | No structured retry budgets, no fingerprinted CI-failure dedup |

**Bottom line:** the execution substrate is solid (workspace + spawn + integrate). What's missing is **coordination**, **workflow shape**, **daemonization**, and **operational hardening**.

---

## 2. The strategic decision: align with GSD-2, do not adopt it

GSD-2 (gsd-build/gsd-2 v3.0.0) is a workflow product with its own runtime built on the Pi SDK. It owns sessions, tools, context, and state. We are an **execution substrate with supervision**. The two are complementary, not competitive.

**Adopt the shape, build the substrate:**

| GSD-2 idea | We adopt | We do not adopt |
|---|---|---|
| Milestone → Slice → Task hierarchy | Yes — as a planning data model | We don't host the planning UI |
| Fresh-session-per-unit | Yes — already how peers work | — |
| DB-authoritative state, markdown as projection | Yes — replace JSON with SQLite for coordination | Not the full schema; only what we need for peers |
| State-driven dispatch table | Yes — as a "next-unit" selector | Not GSD's exact unit catalog |
| Per-unit tool scoping | Yes — already partial via `engine` + `cursor_options` | — |
| Worktree-per-unit | Yes — already the default | — |
| Rich command surface (`/gsd ...` 60+ commands) | No — we expose tools via MCP, not slash commands | Their TUI / web host |
| Pi SDK runtime | No — we shell out to `codex` and `cursor-agent` | — |

**For wire compatibility with `gsd-build/protocol-go`:** the gsd-protocol research recommends **option (b) — wrap our existing MCP server with a thin GSD adapter** (~600–1,200 LOC) instead of full verbatim parity (~1,500–3,500 LOC) or a parallel custom protocol. That keeps the MCP investment, exposes GSD-shaped envelopes where they matter (task / stop / stream / lifecycle / question), and leaves the door open to harden into full parity later.

**For daemonization / hosting:** the gsd-daemon research recommends **copying the boundary, not the relay protocol** — keep our existing peer code, wrap it in a long-lived service with paired-machine auth, owner-only Unix socket for local admin, and an authenticated WebSocket or mTLS channel for remote orchestration. Outbound-first is the safest default.

---

## 3. Borrowable features from the broader landscape

Pulled from the 9 non-GSD research docs (composio, claude-squad, cursor-mcp-comparison, overstory, swarm-patterns, cc-connect, repo-research-tools, community-reddit-hn, community-discord-x). Sorted by ROI (impact / cost).

### Tier 1 — port early (high ROI, low–medium risk)

| # | Feature | Source | LOC | Why now |
|---|---|---|---:|---|
| 1 | **Watchdog repair injection** — detect stalled peers, inject repair prompt, cooldown | hemishbiswas/codex-swarm-runtime | 120–220 | Smallest lift, biggest operational payoff. Addresses the runner's weakest failure mode (stall + deadlock). |
| 2 | **Fingerprinted CI-failure follow-up loop** — separate retry budgets for "nudge" vs "detail" messages | ComposioHQ/agent-orchestrator (`packages/core/src/lifecycle-manager.ts`) | 150–250 | Lets peers self-recover from broken builds before flagging a human. |
| 3 | **Persisted job metadata before launch + byte-offset log tail API** | ai-nuke/cursor-agent-mcp | 220–360 | Improves observability of long peers; non-lossy log streaming for the dashboard. |
| 4 | **Approval fence before bulk fan-out** (`propose_plan` → `confirm_plan` → `execute_plan`) | GustavoWinter/cursor-agent-orchestrator-mcp | 120–220 | Makes a 14-peer fan-out feel intentional, not accidental. Direct fit for our research-swarm pattern. |
| 5 | **Cursor-based event cursor** with `nextCursor` / `sinceSequence` | GustavoWinter | 140–240 | Replaces our coarse `wait_for_peer` polling with non-lossy event replay. |
| 6 | **TripleShot** — 3 parallel attempts per task, judge picks winner — with a **mixed-engine variant** (codex+cursor+codex) | Iron-Ham/claudio | 300–500 | Best quality multiplier. Our engine selection already supports the per-peer dispatch needed. |

**Tier 1 subtotal:** ~1,050–1,790 LOC, maybe 1–2 weeks. Each feature is independently shippable.

### Tier 2 — port when scaling up (medium ROI, medium risk)

| # | Feature | Source | LOC | Trigger |
|---|---|---|---:|---|
| 7 | **Merge-conflict reaction with dedup + reset-on-resolution** | Composio | 80–130 | When you regularly run >3 peers against the same target branch |
| 8 | **Worktree adoption + stale-path recovery** | Composio (`workspace-worktree` plugin) | 90–140 | When peer crashes leave orphaned worktrees |
| 9 | **Write-scope contracts** — peer declares allowed write roots; supervisor enforces | ai-nuke | 180–320 | When you want to YOLO peers without trusting their prompt obedience |
| 10 | **Ralph loop** — fresh context per iteration | cj-vana/claude-swarm | 150–220 | Only if a single peer ever becomes long-lived (currently each is fresh) |
| 11 | **4-tier conflict resolver** (auto → semantic → LLM → human) — start with tier 1+2 only | jayminwest/overstory | 700–1000 (full); ~200 (tier 1+2) | Tier 1+2 are cheap; tiers 3+4 only if you measure conflict pain |
| 12 | **Tmux pane-per-agent attach/detach** for human inspection | smtg-ai/claude-squad | 200–400 | When operating peers from a shared host for multiple humans |

### Tier 3 — defer or reject (low ROI or wrong shape)

| Feature | Source | Verdict |
|---|---|---|
| Reverse MCP bridge (peer-side MCP installed in cursor-agent) | thsunkid | Defer — `send_peer_reply` already covers the use case |
| Plugin-style agent registry | Composio | Defer — `engine: codex \| cursor` enum is enough until we have a 3rd engine |
| SQLite mail bus between peers | overstory | Reject as default — peers don't need to talk to each other; supervisor mediates |
| File-based atomic task locks | cj-vana | Reject — linked worktrees already provide the concurrency boundary |
| Devin/Composio-style web workspace UI | (commercial) | Defer — dashboard v2 is enough until remote-team use case appears |

### Repo-research tooling

The `jgravelle/jcodemunch-mcp` evaluation concluded: **don't install it for repo discovery**. Instead, install the **official GitHub MCP Server** in `peer-codex-home/.mcp.json` so research peers get a single broad GitHub entry point. Build-vs-buy: a 200-LOC custom MCP wrapping `gh search repos` + `gh api` would deliver 80% of the value, with these tools: `search_repos`, `repo_snapshot`, `repo_readme`, `repo_tree`, `repo_issues`, `repo_pulls`, `repo_health`. (See `docs/research/repo-research-tools.md`.)

### Community signal — what the field has already converged on

From Reddit + HN (Mar–May 2026): **worktree-per-agent is now table stakes**. At least 6 open-source projects (`shep-ai/cli`, `spencermarx/orc`, `rchaz/git-stint`, `rohansx/workz`, `nekocode/agent-worktree`, `pld/wt`, `bugrax/git-lanes`) ship worktree-based parallel orchestration in some form. Our codex-peers + cursor-engine + supervisor combo is meaningfully ahead of all of them in **autonomous chaining + halt-on-failure + Telegram control + worktree integration** — but they own the "lightweight wrapper" niche.

From Discord + X: persistent memory across runtimes (`gigabrain`-style) is the next emerging theme. Worth tracking, premature to build.

---

## 4. Hosting plan — codex-peers as a daemon on a separate machine

Combining gsd-daemon (boundary pattern), gsd-protocol (wire) and self-hosted-infra (deployment) recommendations:

**Hardware:** Hetzner AX52 or equivalent dedicated (16-core / 64 GB / 2× 1 TB NVMe), Ubuntu 24.04 LTS, ~€60–80/month.

**Stack:**
- **Supervisor:** `systemd` outer service that owns a rootless Docker Compose stack (one container per agent sandbox, or unprivileged user-per-agent if Docker overhead is too much for short-lived peers)
- **Network:** Tailscale for private operator access; **never expose the agent port publicly**. Cloudflare Tunnel + Access if browser remote use is needed.
- **Auth:** start with single-user API key (matches Continue/OpenHands pattern); upgrade to mTLS when a 2nd device joins; add `oauth2-proxy` only if a team forms.
- **Secrets:** `systemd credentials` for host-level injection; `SOPS/age` for source-controlled config. Provider keys (Anthropic, OpenAI, Cursor, GitHub PAT, Telegram) stay host-only.
- **Storage:** local clone + `git worktree` per peer (we already do this). Plan for hundreds of GB on a busy host. Schedule `git worktree prune` + `git gc` daily.
- **Observability:** structured JSON logs per peer → Loki; OTEL traces for tool calls + lifecycle → tempo or Jaeger; Prometheus for host metrics; Grafana for everything. Pattern: copy `disler/claude-code-hooks-multi-agent-observability` (1.4k★) — Claude Code/Codex hooks → Bun/Node server → SQLite → Vue UI.
- **Sandbox:** rootless Docker container per peer is the minimum bar for `--yolo` peers on a publicly-reachable host. Per-peer VMs/microVMs only if isolation requirements escalate.

**Daemon shape (boring + explicit):**
- single Go-or-Node binary, started by systemd
- writes to `~/.codex-peers/{config.json,logs/,daemon.sock,pids/,prompts/,runs/,worktrees/}`
- **local API:** Unix socket HTTP for `/health`, `/status`, `/peers`, `/workers` (read-only) and `/admin` (write)
- **remote API:** authenticated WebSocket (or mTLS gRPC) for orchestrator commands when supervisor is on a different machine. **Outbound-first** is the safer default — daemon dials a relay rather than listening publicly.
- **paired-machine auth:** single `codex-peers pair` command writes a machine ID + bearer token to `~/.codex-peers/config.json` (mode 0600). Per-task control sockets get short-lived tokens.

**Estimated infra cost:** €80–160/month for the host + ops, before model spend.

---

## 5. Implementation milestones

Priority order. Each milestone ships independently. LOC is rough.

### M1 — Supervisor merge + cc-connect transport (1 week)

**Goal:** finish the supervisor branch and stop reinventing chat transport.

- Land `feat/autonomous-supervisor-telegram-goals` (already +613 modified / +80K new)
- **Replace `controlPlane/telegram.ts` (21K LOC) with cc-connect co-existence pattern** — keep our supervisor, delegate chat transport to `chenhg5/cc-connect` (9.4k★, supports Telegram + Slack + Discord + Feishu + 4 more out of the box). Net: +300–900 glue LOC, −14–18K Telegram code.
- Final shape: `supervisor.ts` calls cc-connect over WebSocket; cc-connect handles per-platform message I/O.

**Cost-of-impl:** 600–1,500 LOC delta (mostly removals). 1 dependency added (cc-connect as sidecar binary).

### M2 — Tier-1 reliability features (1–2 weeks)

Land the 6 Tier-1 borrowable features. Each is independently testable:

1. Watchdog repair injection (~120–220 LOC) — `src/watchdog.ts`
2. Fingerprinted CI-failure follow-up loop (~150–250 LOC) — `src/peerCiRecovery.ts`
3. Persisted job metadata + byte-offset log tail (~220–360 LOC) — extend `src/store.ts` + new `tail_peer_log` MCP tool
4. Approval fence (`propose_plan`/`confirm_plan`/`execute_plan` MCP tools) (~120–220 LOC)
5. Cursor-based event cursor (`peer_events` MCP tool with `since_sequence`) (~140–240 LOC) — replaces `wait_for_peer` polling
6. TripleShot multi-engine variant (`spawn_tripleshot` MCP tool: spawns 3 peers with different engines, judge picks winner) (~300–500 LOC)

**Cost-of-impl:** 1,050–1,790 LOC. ~$0–50 in dev API spend. No new dependencies.

### M3 — GSD planning data model (2 weeks)

**Goal:** add the milestone → slice → task hierarchy without absorbing GSD-2's runtime.

1. Replace `state.json` with SQLite (`better-sqlite3` already widely vendored in agent projects). Schema: `milestones`, `slices`, `tasks`, `peers`, `dispatches`, `runtime_kv`. Keep markdown projections under `.codex-peers/` for human review.
2. Add a state-driven dispatcher: `selectNextUnit(state) → { unitType, prompt, tools, engine, model }`.
3. Migrate `spawnGsdPhaseBatch` to operate on the new schema instead of free-form phase strings.
4. Add MCP tools: `start_milestone`, `add_slice`, `add_task`, `dispatch_next`, `unit_status`.
5. Add markdown rendering: `.codex-peers/milestones/M001/{ROADMAP,CONTEXT,RESEARCH}.md` etc — projection only, DB is source of truth.

**Cost-of-impl:** 600–900 LOC (project state model) + 900–1,400 LOC (dispatcher + prompt assembly). Total ~1,500–2,300 LOC. New dep: `better-sqlite3`.

This is the **single biggest semantic change** and the foundation for everything below.

### M4 — Daemon boundary + remote control (2–3 weeks)

**Goal:** make codex-peers hostable on a separate machine.

1. **Service install/update/rollback** (200–350 LOC) — `codex-peers install` writes systemd unit, `codex-peers update` pulls signed release, `codex-peers rollback` restores prior binary
2. **Paired machine auth** (150–250 LOC) — `codex-peers pair` writes config, bearer-token rotation, `0600`-perm config file
3. **Local Unix socket API** (100–200 LOC) — `/health`, `/status`, `/peers`, `/workers` over HTTP-on-Unix-socket
4. **Remote control transport** (250–500 LOC) — outbound WebSocket to a relay (or mTLS gRPC for direct LAN); messages carry orchestrator commands and stream peer events back
5. **Session-actor refactor of peer runner** (500–1,000 LOC) — one actor per peer with heartbeat, timeout, reaper, cleanup hooks (mirroring gsd-daemon's `internal/session/actor.go` pattern)

**Cost-of-impl:** 1,200–2,300 LOC. New deps: `ws` or `grpc`, `lumberjack`-equivalent log rotation.

### M5 — GSD protocol-go wire adapter (1–2 weeks)

**Goal:** be reachable from any GSD-compatible client without rewriting the daemon.

Implement option (b) from the gsd-protocol research: thin adapter that translates GSD wire envelopes ↔ our internal MCP tool calls.

Map (from gsd-protocol research):
- `task` → `spawn_peer`/`spawn_peer_and_wait`
- `stop` → `kill_peer`
- `permissionResponse` / `questionResponse` → `send_peer_reply`
- `stream` / `taskLifecycle` / `taskStarted` / `taskComplete` → `peer_events` (M2 feature 5)
- `hello` / `welcome` / `heartbeat` → daemon handshake (M4 feature 4)

Skip: `preview*`, `terminal*`, `agentTerminal*`, `compactRequest`, `contextStatsRequest` — these are tied to GSD's runtime, not our model.

**Cost-of-impl:** 600–1,200 LOC.

### M6 — Observability stack (1 week)

1. Structured JSON logs per peer with stable field schema (`agent_id`, `session_id`, `repo`, `branch`, `model`, `engine`, `turn`, `tool_name`, `exit_status`, `git_commit`, `cost`)
2. OTEL exporters for tool calls + lifecycle
3. Prometheus metrics endpoint
4. Loki + Grafana dashboard from `disler/claude-code-hooks-multi-agent-observability` as the starting template

**Cost-of-impl:** 300–500 LOC + Compose stack config. New deps: `@opentelemetry/sdk-node`, `prom-client`.

### M7 — Optional Tier-2 features (as needed, 2–4 weeks total)

Pick from the Tier-2 table when their triggers fire. None are blocking.

---

## 6. Total cost & timeline

| Milestone | LOC | Effort | Dependencies |
|---|---:|---|---|
| M1 — Supervisor + cc-connect | -14K to +900 | 1 week | cc-connect sidecar |
| M2 — Tier-1 reliability (6 features) | 1,050–1,790 | 1–2 weeks | none |
| M3 — GSD data model | 1,500–2,300 | 2 weeks | better-sqlite3 |
| M4 — Daemon + remote control | 1,200–2,300 | 2–3 weeks | ws or grpc |
| M5 — GSD protocol adapter | 600–1,200 | 1–2 weeks | none new |
| M6 — Observability | 300–500 | 1 week | otel, prom-client |
| M7 — Tier-2 (optional) | 1,250–2,090 | 2–4 weeks | varies |

**Net new code:** ~6,000–10,000 LOC across 6–8 weeks of focused work for M1–M6. Tier-2 adds ~2 more weeks if all options taken.

**Net code removed:** ~14–18K LOC of custom Telegram poller (replaced by cc-connect glue). Real diff is closer to **+0 to +5K LOC** for the whole plan if M1 lands cleanly.

**Direct dollar cost:** trivially low for dev work itself. **API spend during dev** maybe $50–200 (testing peers). **Production infra** €80–160/month for the host (M4+).

---

## 7. Sequencing & dependencies

```
M1 (supervisor + cc-connect)        ┐
                                    ├─→ M3 (GSD data model) ──→ M5 (protocol adapter)
M2 (tier-1 reliability)             ┘                ↑
                                                      │
M4 (daemon + remote control) ────────────────────────┤
                                                      │
M6 (observability) ──────────────────────────────────┘
```

- M1 and M2 are independent; ship in parallel
- M3 needs M1 done (control plane stabilized)
- M4 is independent of M1-M3; can ship as soon as M2 lands
- M5 needs M3 (for the unit/task model) and M4 (for the daemon transport)
- M6 can ship after M2

**Recommended execution order:** M1 → (M2 || M4) → M3 → M5 → M6 → M7.

---

## 8. Alignment with the user's stated goals

| User goal | How this plan delivers |
|---|---|
| GSD flow following peer-spawning methodology | M3 adds the milestone/slice/task hierarchy on top of the existing peer primitive; M5 wraps it in GSD-wire-compatible envelopes |
| Locally-hosted agent spawner on a separate machine | M4 adds the daemon boundary + paired auth + remote control; matches the gsd-daemon outbound-first topology |
| Multi-engine (codex + cursor + future) | Already shipping in `feat/cursor-engine`; M2 feature 6 (TripleShot) lets you race engines |
| Use cursor work seat for billing | Already supported via `cursor` engine in `feat/cursor-engine` |
| Better than freema/cursor-plugin-cc | Already past it: parallel + worktree + integrate-back vs. their single-task delegate |
| Avoid reinventing chat transport | M1 adopts cc-connect; saves 14–18K LOC |

---

## 9. Strategic risks

1. **Building a thin wrapper around peer logs instead of a real state machine** — explicit warning from the gsd-2 research. Mitigation: M3 must land DB-authoritative state, not just better JSON.
2. **GSD protocol parity drift** — if we ship M5 then GSD-2 evolves the protocol, we maintenance-burden. Mitigation: option (b) keeps the surface thin so a re-port is cheap.
3. **Daemon attack surface** — every public byte is a liability. Mitigation: outbound-first transport (M4), Tailscale by default, never `0.0.0.0:port` directly.
4. **cc-connect coupling** — if cc-connect becomes unmaintained (currently 9.4k★, active), our supervisor inherits a cold dependency. Mitigation: co-exist (M1 plan) not replace; we own the supervisor logic, cc-connect is a transport sidecar that can be swapped.
5. **Per-peer cost runaway with TripleShot** — racing 3 engines per task triples model spend. Mitigation: TripleShot is opt-in via dedicated MCP tool, not the default `spawn_peer`.

---

## 10. What we deliberately are NOT building

- A planning/IDE TUI (GSD-2 owns that lane; integrate via M5 instead)
- A web workspace (Devin-style); dashboard v2 is enough
- Per-peer VM isolation (rootless Docker is the bar; revisit only if attack surface demands it)
- A multi-tenant service (single-operator design; multi-user only if a team forms)
- An evaluation harness (Aider's leaderboards are still the field benchmark; no point duplicating)
- A persistent memory layer (let `gigabrain`-style projects mature first)

---

## Sources

All 14 research docs in [`docs/research/`](./research/):

1. [composio-agent-orchestrator.md](./research/composio-agent-orchestrator.md) — multi-engine orchestrator with CI-failure remediation + worktree adoption
2. [claude-squad.md](./research/claude-squad.md) — backend-agnostic abstraction over Claude/Codex/Gemini/Aider
3. [cursor-mcp-comparison.md](./research/cursor-mcp-comparison.md) — 3 cursor-agent MCP wrappers compared
4. [overstory.md](./research/overstory.md) — SQLite mail bus + 4-tier conflict resolver
5. [swarm-patterns.md](./research/swarm-patterns.md) — Ralph loop + TripleShot + watchdog patterns
6. [cc-connect.md](./research/cc-connect.md) — multi-platform chat transport (Telegram/Slack/Discord/Feishu/+4)
7. [gsd-2.md](./research/gsd-2.md) — GSD-2 deep dive: workflow + state model + dispatch
8. [gsd-v1.md](./research/gsd-v1.md) — GSD v1 history + lessons
9. [gsd-daemon.md](./research/gsd-daemon.md) — GSD daemon hosting model
10. [gsd-protocol.md](./research/gsd-protocol.md) — gsd-build/protocol-go inventory + adapter strategy
11. [community-reddit-hn.md](./research/community-reddit-hn.md) — community signals on agent orchestrators
12. [community-discord-x.md](./research/community-discord-x.md) — Discord + X chatter
13. [repo-research-tools.md](./research/repo-research-tools.md) — jcodemunch-mcp + alternatives evaluation
14. [self-hosted-infra.md](./research/self-hosted-infra.md) — self-hosted runtime infra best practices
