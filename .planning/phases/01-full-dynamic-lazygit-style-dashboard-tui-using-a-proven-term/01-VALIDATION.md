---
phase: 01
slug: full-dynamic-lazygit-style-dashboard-tui-using-a-proven-term
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-07
---

# Phase 01 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | TypeScript compiler + Node built-in `node:test` |
| **Config file** | `tsconfig.json`, `tests/*.test.mjs` |
| **Quick run command** | `npm run check` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | < 30 seconds for current suite |

## Sampling Rate

- **After every task commit:** Run `npm run check`
- **After every plan wave:** Run `npm test`
- **Before `$gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-01 | 01 | 1 | DASH-05 | T-01-01 | No dependency/runtime change is accepted without a recorded compatibility result | typecheck/smoke | `npm run check` plus documented OpenTUI smoke command | yes | complete |
| 01-01-02 | 01 | 1 | DASH-05 | T-01-02 | Dashboard exits restore terminal state | typecheck/smoke | `npm run check` | yes | complete |
| 01-02-01 | 02 | 2 | DASH-04 | T-02-01 | Peer actions still call existing peer manager APIs | unit/typecheck | `npm run check` | yes | complete |
| 01-02-02 | 02 | 2 | DASH-04 | T-02-02 | Log reads remain bounded and file-based | unit/typecheck | `npm run check` | yes | complete |
| 01-03-01 | 03 | 3 | DASH-04 | T-03-01 | Kill action requires explicit key command and target confirmation | unit/manual | `npm test` | yes | complete |
| 01-03-02 | 03 | 3 | DASH-04, DASH-05 | T-03-02 | CLI smoke proves dashboard command starts in a TTY and exits cleanly | smoke/manual | `npm test` plus Bun dashboard smoke | yes | complete |

## Wave 0 Requirements

- [x] `tests/dashboard.test.mjs` exists and covers pure dashboard view-model helpers.
- [x] `npm run check` remains available and green.
- [x] `npm test` remains available and green.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full-screen layout and responsive resize | DASH-04 | Real terminal dimensions and alternate-screen behavior are difficult to validate in current node:test suite | Build, run `codex-peers --d` or `node dist/index.js dashboard`, resize terminal below and above 100 columns, verify no pane overlap. |
| Keyboard navigation in TTY | DASH-04 | Raw key handling depends on terminal runtime | In dashboard, verify `tab`, `shift+tab`, arrows, `j/k`, `enter`, `space`, `r`, `x`, `escape`, `q`, and `ctrl+c`. |
| OpenTUI native runtime | DASH-05 | Depends on local OS/runtime/native package behavior | Run the compatibility command documented by Plan 01 and record whether OpenTUI works under the intended CLI runtime. |

## Validation Sign-Off

- [x] All tasks have `<verify>` commands or manual smoke instructions.
- [x] Sampling continuity: no 3 consecutive tasks without automated verify.
- [x] Wave 0 covers all missing test references.
- [x] No watch-mode flags.
- [x] Feedback latency target is under 30 seconds.
- [x] `nyquist_compliant: true` set in frontmatter.
