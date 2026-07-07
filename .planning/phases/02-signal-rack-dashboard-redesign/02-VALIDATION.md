---
phase: 2
slug: signal-rack-dashboard-redesign
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-07
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 02-RESEARCH.md § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node --test` against compiled `dist/*.js` (see `tests/*.test.mjs`); `tests/dashboard.test.mjs` is the relevant suite |
| **Config file** | none dedicated — `package.json` script `"test": "npm run build && node --test tests/*.test.mjs"` |
| **Quick run command** | `npx tsc -p tsconfig.json --noEmit` (fast type-check, no full build) |
| **Full suite command** | `npm run test` (builds, then runs all `tests/*.test.mjs`) |
| **Estimated runtime** | ~30–60 seconds (build-dominated) |

---

## Sampling Rate

- **After every task commit:** Run `npx tsc -p tsconfig.json --noEmit` + the relevant `node --test tests/dashboard.test.mjs` subset
- **After every plan wave:** Run `npm run test` (full suite, includes build)
- **Before `/gsd-verify-work`:** Full suite green, plus a manual `CODEX_PEERS_DASHBOARD_SMOKE=1` dashboard run (OpenTUI rendering has no headless assertion path in this repo today)
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

> Task IDs are provisional — the planner finalizes plan/wave assignment. Requirement→behavior→command mapping is fixed by research.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 2-xx | — | — | DASH-09 | — | N/A | unit | `node --test tests/dashboard.test.mjs` (view-model exposes `contextPercent`/`contextLevel`/`compacted` + status counts) | ✅ file exists, ❌ new assertions W0 | ⬜ pending |
| 2-xx | — | — | DASH-09 | — | N/A | unit | `node --test tests/dashboard.test.mjs` (pure `contextMeterChunks()`-style glyph/color helper) | ❌ W0 — extract as small pure exported fn | ⬜ pending |
| 2-xx | — | — | DASH-09 | — | N/A | unit | `node --test tests/dashboard.test.mjs` (5-bucket triage-order grouping helper) | ❌ W0 | ⬜ pending |
| 2-xx | — | — | DASH-10 | V5 | trimmed, empty-rejected answer text (preserve `.trim()` + empty reject from `submitAnswer`) | unit | `node --test tests/dashboard.test.mjs` (kill-confirm/answer status-line mode transitions in `v3Input.ts`) | ✅ pattern exists (~L371-402), needs rename | ⬜ pending |
| 2-xx | — | — | DASH-10 | — | N/A | unit | `node --test tests/dashboard.test.mjs` (Tab focus cycle rack↔dock) | ❌ W0 | ⬜ pending |
| 2-xx | — | — | DASH-10 | — | N/A | manual smoke | `CODEX_PEERS_DASHBOARD_SMOKE=1 bun src/dashboard/bunEntryV2.js` (tail-follow / scroll indicator — no headless assertion surface) | ✅ smoke path exists | ⬜ pending |
| 2-xx | — | — | Success #6 | — | MCP/CLI/supervision unaffected | full suite | `npm run test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Extend `tests/dashboard.test.mjs` `createDashboardViewModel` tests with `contextPercent`/`contextLevel`/`compacted` fixtures once `DashboardPeerRow` carries them
- [ ] Add unit tests for the new 5-bucket triage-order grouping helper (WORKING → WAITING → STARTING → FAILED → DONE), distinct from the current 15-status `STATUS_ORDER`
- [ ] Add unit tests for the renamed kill-confirm/answer status-line mode transitions in `v3Input.ts` once the modal flow is retired
- [ ] Spike `ScrollBox` factory export in `@opentui/core@0.2.4` before committing the dock's log body to it; if absent, keep hand-rolled scroll math and add the (currently missing) unit tests for `visibleLogContent`/scroll-position helpers

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Tail-following log + `log N/M ▼ tail / ▲ scrolled` indicator, `b` jumps to tail, re-attach on selection change | DASH-10 | Live OpenTUI renderer scroll state has no headless assertion path in this repo | `CODEX_PEERS_DASHBOARD_SMOKE=1 bun src/dashboard/bunEntryV2.js` or interactive `bun` run; scroll dock, switch selection, press `b`, confirm indicator text |
| Palette exactly matches `cyberpunkTheme`; CRT scanlines/glow/sharp corners; focus glow on Tab | DASH-09/10 & Success #5 | Visual fidelity is not machine-assertable | Interactive `bun` dashboard run; compare against `sketch-findings-delamain` sources/002 mock |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
