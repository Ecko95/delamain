# Agent Orchestration System — Design Overview

**Date:** 2026-07-16
**Status:** Design agreed (brainstorming complete); SP1 spec follows in `2026-07-16-sp1-workflow-engine-design.md`
**Owner:** Joshua Duffill

Grounding research (verified against local tooling on 2026-07-16) lives in
`../../research/2026-07-16-*.md`: orchestration-design-input (synthesis), codex-ultra-mode,
pi-harness, ultracode-target, delamain-extension-map, sandbox-tech, open-gsd-gsd-pi.

---

## 1. Goal

Expand **delamain** from a flat "spawn & supervise headless peers" supervisor into a **full agent
orchestration system**: a code-defined, terminating, multi-phase **workflow engine** — matching Claude
Code's "ultracode" Workflows — that fans work across interchangeable **Codex / Cursor / Pi** leaf agents,
verifies and loops with guaranteed termination, and surfaces live state to multiple cockpits (delamain's
own TUI, a **Pi** extension, and the **gitscode / T3 Code** GUI).

Four target use-cases, all in scope: parallel dev across repos · multi-phase build→review→verify
pipelines · migrations / codebase sweeps · autonomous GSD phase execution.

## 2. The one-line architectural verdict

> **delamain owns the workflow engine, in TypeScript.** Neither codex "ultra mode" nor Pi provides
> code-defined, terminating workflows — codex sub-agents are model-driven and don't reliably terminate,
> and Pi ships no orchestration layer at all. Codex/Cursor/Pi are **leaf executors**. The "control flow
> is code, so it ends" property — the reason ultracode uses ~¼ the tokens — must live in delamain.
> delamain's existing `gsdRunner` (a working, tested, terminating loop) is the proof-of-concept to
> generalize.

## 3. The spine

```
        ┌─────────────── COCKPITS (views over one core) ───────────────┐
        │   Pi extension: pi-delamain-workflows      gitscode / T3 GUI   │
        └───────────────┬───────────────────────────────────┬──────────┘
             subscribe (event stream)          HTTP: orchestration.dispatch/snapshot
                         │                                   │  (coordinator-above-T3)
        ┌────────────────▼───────────────────────────────────▼──────────┐
        │                    delamain  —  ORCHESTRATION CORE              │
        │  ┌──────────────────────────────────────────────────────────┐  │
        │  │  WORKFLOW ENGINE (SP1, new)                                │  │
        │  │   sandbox(run(ctx))  →  agent/parallel/pipeline/phase/verify│ │
        │  │   semaphore(two-pool) · budget · termination guards        │  │
        │  │   → emits WORKFLOW EVENT STREAM (single source of truth)   │  │
        │  └───────────────────────────┬──────────────────────────────┘  │
        │                spawnPeer / waitForPeer / resumePeer             │
        │  ┌───────────────────────────▼──────────────────────────────┐  │
        │  │  LEAF ENGINES (heavyweight, isolated worktrees)            │  │
        │  │   codex · cursor · pi(SP2)   [codex multi_agent = leaf opt]│  │
        │  └──────────────────────────────────────────────────────────┘  │
        │  SQLite state · frozen-gate · MCP tools · OpenTUI dashboard     │
        └────────────────────────────────────────────────────────────────┘
```

- **Core** = delamain workflow engine. The one place control flow lives; deterministic and terminating.
- **Leaves** = codex / cursor / pi peers, each a full process in its own git worktree. Interchangeable per node.
- **Event stream** = a single lifecycle-event channel every view subscribes to (no view re-derives state).
- **Cockpits** = renderers only: Pi extension, gitscode/T3, and delamain's own TUI.
- **codex `multi_agent`** = available *inside a leaf* as a bounded accelerator, never as the orchestrator.

## 4. Sub-projects & build order

Each sub-project gets its own spec → plan → implementation cycle.

| SP | Sub-project | Order | Effort | Notes |
|----|-------------|-------|--------|-------|
| **SP1** | **delamain workflow engine + event stream** | **1st** | M–L | This milestone. Full ultracode parity. Spec: `2026-07-16-sp1-workflow-engine-design.md` |
| **SP2** | **Pi leaf engine** (`pi` as 3rd engine) | with/after SP1 | S | ~2 files; unlocks multi-model jurors + codex-max/xhigh via API |
| **SP3** | **gitscode / T3 coordinator-above-T3** | later milestone | M + fork upkeep | delamain dispatches `thread.*` into T3's HTTP orchestration API; thin, API-only |
| **SP4** | **`pi-delamain-workflows` Pi extension** (the `/workflows` view) | after SP1 event stream | S–M | Subscribes to the event stream; renders the Claude-Code-style panel; vendor gsd-pi visualizer patterns |
| **SP5** | **codex `multi_agent` bounded leaf** | optional/later | XS | Opt-in accelerator inside one leaf; prefer `spawn_agents_on_csv` |

## 5. Cross-cutting decisions (locked 2026-07-16)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Who owns orchestration | **delamain (TS)** | Only place that guarantees code-defined termination; codex/pi can't |
| Script sandbox (v1) | **child-process + `node:vm` global + OS jail** | isolated-vm is **verified broken on Node 25.5.0** (segfaults on isolate creation); this runs natively today behind a stable `ctx` interface |
| Sandbox (later) | **isolated-vm behind same `ctx`** | Adopt on a Node-24 pin, or on Node 26 + isolated-vm 7.x; no functional change to workflows |
| Concurrency | **two-pool** | Oversubscribe cheap IO-blocked *scripts*; hard-cap heavy *agents* to real RAM/CPU. This is how the VPS is exploited |
| State store | **SQLite in v1** | `state.json`'s whole-file read-modify-write loses updates under the high fan-out the VPS enables |
| Structured output | **`schema` on `agent()`** | Keystone: today a peer returns free text @6000 chars, which can't drive branching |
| Integration under fan-out | **`integrate:false` on all leaves** | Only the final synthesized artifact opens a PR; otherwise N leaves flood the remote with N branches |
| Autonomous GSD | **harden `gsdRunner` + vendor gsd-pi** | Keep delamain's multi-engine + frozen-gate differentiator; port gsd-pi's reliability patterns; don't adopt its pi-only engine wholesale |
| gitscode integration | **coordinator-above-T3** | T3 is itself an Effect CQRS engine with worktrees; reuse its UI via its HTTP API rather than fork `apps/*`. It does **not** ingest MCP |

## 6. Prior art being mined (not adopted wholesale)

- **Claude Code ultracode Workflows** — the primitive set and the termination property (design target).
- **gsd-pi / open-gsd** (`@opengsd/gsd-pi`, MIT) — auto-mode reliability patterns (crash-recovery via
  lock + tool-call replay, timeout supervision, stuck-retry, reassess/replan, headless restart) and its
  web/TUI visualizer for SP4. Your `Ecko95/gsd-cursor-dispatch` is a fork of its predecessor.
- **`@vigolium/piolium`** (MIT) — multi-phase sub-agent orchestration packaged as a Pi extension; TUI + orchestration reference for SP4.
- **`@ai-hero/sandcastle`** (MIT) — agent-sandbox provider abstraction + branch strategies; reference if delamain later makes its *peer* sandbox pluggable.
- **`pi-acp`** — an ACP adapter for Pi; a path for Pi to appear as a provider inside T3 later.

## 7. Non-goals (this milestone)

- Replacing T3's engine or deep `apps/*` edits in the gitscode fork.
- Adopting gsd-pi or piolium as delamain's engine.
- isolated-vm on Node 25 (deferred; verified non-viable).
- A hosted/multi-tenant deployment (single-user VPS scope).
