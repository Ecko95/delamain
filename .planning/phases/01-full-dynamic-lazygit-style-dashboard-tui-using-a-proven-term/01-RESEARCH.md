# Phase 1: Full dynamic lazygit-style dashboard TUI using a proven terminal UI library - Research

**Researched:** 2026-05-07
**Domain:** TypeScript terminal UI, OpenTUI, Node/Bun CLI packaging
**Confidence:** MEDIUM

<user_constraints>
## User Constraints

No repo-local `01-CONTEXT.md` exists. The orchestrator brief supplies these planning constraints:

### Locked Decisions
- Use OpenTUI as the chosen primary TUI library for now.
- Preserve a fallback note: `blessed-contrib` can be reconsidered only if OpenTUI has unacceptable build/runtime friction.
- Do not implement the dashboard during planning.

### the agent's Discretion
- Split implementation into executable plans.
- Add compatibility checks before replacing the current `src/dashboard.ts` behavior.
- Choose file boundaries and tests consistent with this small TypeScript/Node ESM project.

### Deferred Ideas
- Browser dashboard remains out of scope.
- Mouse support, filtering/search, and theme configuration remain v2 requirements (`DASH-06` through `DASH-08`).
</user_constraints>

<architectural_responsibility_map>
## Architectural Responsibility Map

Single-tier CLI application. All Phase 1 capabilities live in the local CLI/TUI tier, with existing process/worktree operations remaining in `src/peerManager.ts`, `src/store.ts`, and `src/git.ts`.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Full-screen terminal dashboard | CLI/TUI | Existing peer manager | `codex-peers --d` already routes into `startDashboard()`; Phase 1 replaces rendering, not peer lifecycle. |
| Peer list, details, logs, and status panes | CLI/TUI | State/log filesystem | Existing `listPeers()`, `readPeerLog()`, and exported dashboard helpers already supply the data. |
| Keyboard navigation and kill action | CLI/TUI | Peer manager | Input handling should call existing `killPeer()` rather than duplicating process logic. |
| Responsive layout | CLI/TUI | OpenTUI renderer | OpenTUI uses Yoga/Flexbox-like layout and resize events. |
</architectural_responsibility_map>

<research_summary>
## Summary

OpenTUI is the best-aligned primary choice for the requested lazygit-style dashboard because it provides a native terminal renderer, TypeScript bindings, component primitives (`Box`, `Text`, `Select`, `ScrollBox`), built-in focus/input handling, and Yoga-backed responsive layout. The official docs describe it as a component-based core for complex terminal apps, and the repository README says `@opentui/core` is the imperative TypeScript binding package.

The key implementation risk is runtime/package friction. Official OpenTUI getting-started docs state that OpenTUI is currently Bun-exclusive and that Deno/Node support is still in progress. This project is a Node >=20 ESM CLI with an npm lockfile and a `codex-peers` bin pointing at `node dist/index.js`. Therefore the implementation plan must begin with a small compatibility proof before replacing `src/dashboard.ts`.

**Primary recommendation:** Plan OpenTUI as the first path, but require a Wave 1 compatibility task that proves the installed package can render under this repo's intended CLI runtime or documents the exact friction before broader migration.
</research_summary>

<standard_stack>
## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@opentui/core` | `0.2.4` latest on npm as of 2026-05-07 | Native terminal renderer and imperative TypeScript components | Official OpenTUI core package; exposes `createCliRenderer`, `Box`, `Text`, `Select`, `ScrollBox`. |
| `@opentui/keymap` | `0.2.4` latest on npm as of 2026-05-07 | Optional layered shortcut engine | Official keymap package; useful if raw renderer handlers become too ad hoc. |

### Existing Project Stack

| Tool | Current Use | Planning Impact |
|------|-------------|-----------------|
| Node.js >=20 ESM | Runtime and global CLI packaging | Must remain supported unless the execution phase intentionally changes distribution strategy. |
| npm + package-lock | Dependency management | Executor should use `npm install @opentui/core@0.2.4` only after runtime proof is acceptable. |
| TypeScript `tsc --noEmit` | Existing check gate | Every plan must keep `npm run check` green. |
| node:test | Existing test runner | Add dashboard unit/smoke tests without changing test framework. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| OpenTUI | `blessed-contrib` | More Node-native and established for dashboards, but not the chosen user decision. Reconsider only if OpenTUI cannot run/build acceptably in this CLI. |
| OpenTUI components | Custom ANSI renderer | Current implementation already shows the maintenance limit; custom layout/input should be retired where OpenTUI is viable. |
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### System Architecture Diagram

```text
codex-peers --d
  -> src/index.ts / src/cli.ts command routing
  -> startDashboard()
  -> DashboardController
       -> poll listPeers() every 1000ms
       -> derive DashboardViewModel
       -> render OpenTUI root layout
       -> handle keymap/input commands
            -> selection/focus state updates
            -> readPeerLog(selected.id)
            -> killPeer(selected.id) after explicit command
       -> renderer.destroy() on q/Ctrl+C/SIGINT/SIGTERM
```

### Recommended Project Structure

```text
src/
├── dashboard.ts              # public exports: startDashboard(), printTmuxStatus(), pure helpers kept for tests
├── dashboard/
│   ├── model.ts              # peer sorting, status counts, labels, row/detail/log view models
│   ├── opentui.ts            # OpenTUI renderer creation, component tree, repaint/update lifecycle
│   └── keybindings.ts        # command mapping for focus, selection, logs, refresh, kill, quit
└── peerManager.ts            # existing peer operations; do not duplicate
tests/
└── dashboard.test.mjs        # pure view-model/keybinding tests plus CLI smoke where feasible
```

### Pattern 1: Full-screen renderer ownership

Use `createCliRenderer({ screenMode: "alternate-screen", exitOnCtrlC: false, targetFps: 30, consoleMode: "disabled" })` for the dashboard. The official renderer docs describe alternate screen as the standard full-screen TUI mode and document cleanup via `renderer.destroy()`.

### Pattern 2: Flexbox pane layout

Use OpenTUI `Box` components with `width: "100%"`, `height: "100%"`, `flexDirection`, `flexGrow`, fixed side widths, titles, borders, and `renderer.on("resize", ...)` for narrow terminal mode. OpenTUI docs state it uses Yoga for CSS Flexbox-like responsive layouts and supports resize event handling.

### Pattern 3: Select + detail preview

Use `Select` or `SelectRenderable` for the peer list if it can display enough row metadata. The official Select docs provide `SELECTION_CHANGED`, which should update detail/log panes when highlighted peer changes. If Select is too constrained for multi-column rows, use `ScrollBox` plus explicit selected row styling while retaining OpenTUI for layout/rendering.

### Pattern 4: ScrollBox for logs

Use `ScrollBoxRenderable`/`ScrollBox` for the log pane with `stickyScroll: true`, `stickyStart: "bottom"`, and `viewportCulling: true`. The official ScrollBox docs explicitly call out log/chat use cases and keyboard scrolling support.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Bordered responsive panes | Manual ANSI border/table layout | OpenTUI `Box` + Yoga layout | Handles resize, spacing, border styles, and nested layout. |
| Scrollable logs | Manual line slicing as the primary UI mechanism | OpenTUI `ScrollBox` | Supports viewport culling, sticky bottom behavior, keyboard scrolling. |
| Focusable peer selection | Custom raw key loop as the only navigation model | OpenTUI `Select` or keymap-backed focus state | Reduces edge cases for selection, fast scroll, and focus. |
| Terminal cleanup | Manual cursor/ANSI restoration only | OpenTUI renderer lifecycle plus signal cleanup | Renderer owns terminal modes and must be destroyed cleanly. |
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: OpenTUI runtime mismatch
**What goes wrong:** The package installs but the built `node dist/index.js dashboard` cannot load or render the native core.
**Why it happens:** Official docs say OpenTUI is Bun-exclusive today while this project is Node/npm.
**How to avoid:** Put compatibility proof before migration. The executor must record the command and exact outcome, then continue only if Node packaging remains acceptable or the project explicitly adopts a Bun-backed dashboard entry path.
**Warning signs:** `ERR_MODULE_NOT_FOUND`, native library load failures, Bun-only APIs, or required Zig/build steps during normal npm install.

### Pitfall 2: Losing exported pure helper behavior
**What goes wrong:** Tests and current dashboard semantics regress when `src/dashboard.ts` is rewritten.
**Why it happens:** `projectLabel()` is already exported and covered by tests; row sorting/status labels also encode useful product behavior.
**How to avoid:** Move pure helpers into `src/dashboard/model.ts`, re-export `projectLabel()` from `src/dashboard.ts`, and add tests before or alongside UI migration.

### Pitfall 3: Interleaving OpenTUI rendering with normal stdout
**What goes wrong:** Logs or console output corrupt the dashboard.
**Why it happens:** Full-screen TUIs own the terminal region; OpenTUI has documented external output and console overlay modes.
**How to avoid:** Disable console overlay for production dashboard, keep dashboard diagnostics in a status/message pane, and ensure peer logs are read from files rather than streamed to stdout.

### Pitfall 4: Keyboard shortcuts collide with text entry
**What goes wrong:** Kill confirmation or future search mode consumes normal navigation keys unexpectedly.
**Why it happens:** Current dashboard uses `killMode` and raw stdin directly.
**How to avoid:** Model modes explicitly: `normal`, `kill-confirm`, `help`. Bind `q`, `ctrl+c`, `escape`, `tab`, `shift+tab`, arrows, `j/k`, `enter`, `space`, `r`, `x`, `g/G`, `pageup/pagedown`.
</common_pitfalls>

<validation_architecture>
## Validation Architecture

| Requirement | Automated Coverage | Manual/Smoke Coverage |
|-------------|--------------------|-----------------------|
| DASH-04 | Unit tests for dashboard view model, status counts, focus/selection transitions, and log pane derivation. `npm run check` must pass. | Run `codex-peers --d` or `node dist/index.js dashboard` in a TTY with seeded peer state and verify bordered panes, resize behavior, navigation, and kill prompt. |
| DASH-05 | Dependency/runtime proof documents `@opentui/core@0.2.4` installation and render command outcome. | If OpenTUI fails, record friction and stop for fallback decision instead of silently switching libraries. |

Suggested automated additions:
- `tests/dashboard.test.mjs` for `projectLabel`, sorted peer view model, status summaries, selected peer clamp, detail/log formatting.
- A smoke script or test that imports the dashboard module without starting an interactive renderer.
- Optional fixture seeding through `CODEX_PEERS_HOME` to verify dashboard data derivation without real peer processes.
</validation_architecture>

<code_examples>
## Code Examples From Official Sources

### Renderer creation
```typescript
import { createCliRenderer } from "@opentui/core";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
});
```
Source: https://opentui.com/docs/core-concepts/renderer/

### Bordered component composition
```typescript
import { Box, Text } from "@opentui/core";

renderer.root.add(
  Box(
    { borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 },
    Text({ content: "Welcome", fg: "#FFFF00" }),
  ),
);
```
Source: https://opentui.com/docs/getting-started/

### ScrollBox log behavior
```typescript
const scrollbox = new ScrollBoxRenderable(renderer, {
  id: "logs",
  width: 60,
  height: 20,
  stickyScroll: true,
  stickyStart: "bottom",
});
```
Source: https://opentui.com/docs/components/scrollbox/
</code_examples>

<open_questions>
## Open Questions

1. **Can the Node CLI load OpenTUI without changing runtime?**
   - What we know: OpenTUI `@opentui/core@0.2.4` is published to npm, but official docs still state Bun exclusivity.
   - What's unclear: Whether current releases can run from `node dist/index.js` in this project's packaging model.
   - Recommendation: Wave 1 compatibility proof must answer this before replacing the dashboard.

2. **Should the peer list use `Select` or a custom OpenTUI row component?**
   - What we know: `Select` handles keyboard navigation and selection events; current rows need multiple compact columns.
   - What's unclear: Whether `SelectOption` formatting is enough for rich columns.
   - Recommendation: Prefer `Select` first. If it cannot render compact columns cleanly, use `ScrollBox` with explicit row renderables and document the reason in the implementation summary.
</open_questions>

<sources>
## Sources

### Primary
- https://opentui.com/docs/getting-started/ - installation, Bun exclusivity, component composition.
- https://opentui.com/docs/core-concepts/renderer/ - renderer config, screen modes, input handling, cleanup.
- https://opentui.com/docs/core-concepts/layout/ - Yoga-backed flexbox layout and resize handling.
- https://opentui.com/docs/components/box/ - borders, titles, layout container properties.
- https://opentui.com/docs/components/select/ - focusable list navigation and selection events.
- https://opentui.com/docs/components/scrollbox/ - sticky log scrolling, viewport culling, keyboard scrolling.
- https://opentui.com/docs/keymap/overview/ - layered key binding model.
- https://github.com/anomalyco/opentui - package names, repository status, release metadata.

### Local
- `.planning/ROADMAP.md` - Phase 1 goal and success criteria.
- `.planning/REQUIREMENTS.md` - `DASH-04`, `DASH-05`.
- `src/dashboard.ts` - current hand-rendered ANSI dashboard and exported helper.
- `package.json` - Node/npm runtime and check/test scripts.
</sources>

<metadata>
## Metadata

**Research scope:** OpenTUI official docs, GitHub README, npm package metadata, current dashboard implementation.

**Confidence breakdown:**
- Standard stack: MEDIUM - official docs and npm metadata agree on package names/version, but runtime support is the key uncertainty.
- Architecture: HIGH - local code boundaries are small and current dashboard behavior is clear.
- Pitfalls: HIGH - runtime mismatch and terminal cleanup risks are directly supported by official docs.
- Code examples: HIGH - sourced from official OpenTUI docs.

## RESEARCH COMPLETE
</metadata>
