# Delamain Skill Kit — Design Spec

**Date:** 2026-05-30
**Status:** Approved, implementing
**Author:** Ecko95 (with Claude)

## Context

`codex-mcp-peers-server` was renamed to **delamain** — a multi-engine peer
supervisor (MCP server + `delamain` CLI + Bun/OpenTUI dashboard) that spawns
autonomous "peer" agents using either the **codex** CLI or the **cursor-agent**
CLI. Peers run in isolated linked git worktrees, surface on the dashboard, and
integrate back to a target branch on success.

The existing Claude skills `codex-peers-autopilot` and `gsd-codex-autopilot`
remain **untouched as reference**. This spec defines a new **delamain skill
kit** that reflects the multi-engine (codex|cursor) reality and the dashboard.

## Decisions (locked)

- **2-skill kit**: `delamain-peers` (operator) + `delamain-autopilot` (chain driver).
- **Autopilot basis**: faithful **port** of `codex-peers-autopilot`, made engine-aware.
- **Dashboard command**: there is now **one** dashboard (the v2 grid). It is
  launched with **`delamain --d`** (also `-d`/`--d2`/`-d2`/`dashboard`). The kit
  standardizes on `delamain --d`.
- **Engine default**: `codex`. `cursor` is opt-in per spawn / per roadmap slice.
- Location: `~/.claude/skills/delamain-peers/` and `~/.claude/skills/delamain-autopilot/`.

## Grounding: delamain MCP tool surface

MCP server registered as **`delamain-peers`** (tool names unchanged from the
codex-peers era). Tools: `spawn_peer`, `spawn_peer_and_wait`, `list_peers`,
`peer_status`, `wait_for_peer`, `read_peer_log`, `send_peer_reply`,
`integrate_peer`, `kill_peer`, `spawn_gsd_phase_batch`, `inspect_gsd_milestone`,
`classify_frozen_batch`.

Key `spawn_peer` params: `repo` (req), `prompt` (req), `name`, `start_ref`,
`merge_branch`, `target_branch` (legacy), `model`, `engine` ("codex"|"cursor",
default "codex"), `sandbox` ("read-only"|"workspace-write"|"danger-full-access",
codex only), `yolo` (codex only), `cursor_options` ({ cloud, approve_mcps,
force }, cursor only).

Engine runners: codex (`runner.ts`, model_reasoning_effort=high default unless
gpt-5.5); cursor (`cursorRunner.ts`, default model `composer-2-fast`, aliases:
composer, sonnet, opus, gpt/codex, grok, gemini). State lives in `~/.delamain/`
(`state.json`, `worktrees/`, `runs/`, `prompts/`, `peer-codex-home/`).

Peer statuses: starting, working, waiting, idle, done, failed, frozen, killed,
+ gsd_* states. `waiting` peers expose `.question`; answer with `send_peer_reply`.
`integrate_peer` is the **only** push path.

## Skill 1: `delamain-peers` (operator)

Drive individual peers end-to-end. Files:

- `SKILL.md` — intake + workflow: pre-spawn verification → spawn (engine choice)
  → monitor on dashboard → answer/integrate/kill.
- `references/tool-surface.md` — every MCP tool with exact params/enums.
- `references/engines.md` — codex vs cursor: model tiers, sandbox/yolo,
  cursor_options, when to pick which.
- `references/state-and-dashboard.md` — `~/.delamain` layout, statuses,
  `delamain --d` dashboard launch + keys + engine display.

Mandatory **pre-spawn verification** (ported principle): confirm repo path +
origin + start ref, and engine + model, before any `spawn_peer`. Engine-aware:
codex needs a seeded `~/.delamain/peer-codex-home/`; cursor needs `cursor-agent`
auth.

## Skill 2: `delamain-autopilot` (chain driver)

Port of `codex-peers-autopilot`. Keeps: cron `supervisor.py` + `flock`
single-instance lock, halt-on-failure, idempotent Telegram via `notified_events`,
auto-review (lint/typecheck/test/build + forbidden-touch diff), auto-PR
rebase-merge, `git cherry` patch-id merge detection, `responder.py`, `notify.sh`.

Changes from the original:

- All `~/.codex-peers` paths → `~/.delamain`; peer-codex-home references updated.
- Any user-facing `codex-peers` MCP/CLI references → `delamain-peers` / `delamain`
  (tool names like `spawn_peer` unchanged).
- `handoffs.tsv` gains an **`engine`** column (codex|cursor) and per-engine
  `model`; supervisor builds `spawn_peer` args per engine (incl. `cursor_options`).
- **Engine-aware bootstrap**: codex slices verify a seeded `peer-codex-home`;
  cursor slices verify `cursor-agent` auth (no CODEX_HOME requirement).
- **Model tiers**: keep the codex tier table; add a cursor model table.
- Dashboard references use `delamain --d`.

Originals left intact.

## Verification

- `delamain-peers`: live smoke — spawn one codex and one cursor peer into a
  throwaway repo, confirm both render on the dashboard with correct engine,
  answer a `waiting` one, `integrate_peer`, `kill_peer`.
- `delamain-autopilot`: `supervisor.py` parses an engine-column TSV and emits
  correct spawn args for both engines (`python3 -m py_compile` + a parse check);
  no full live chain required.

## Out of scope

- Modifying the existing reference skills.
- A dedicated dashboard skill (folded into `delamain-peers`).
- GSD-specific autopilot (the `gsd-*` tools exist but the GSD chain skill is the
  separate `gsd-codex-autopilot`, kept as reference).
