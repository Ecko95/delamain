# TUI Library Research: Dynamic Dashboard

**Date:** 2026-05-07
**Purpose:** Identify useful GitHub libraries for a lazygit-style `codex-peers` dashboard instead of expanding the current custom ANSI renderer.

## Shortlist

| Library | Fit | Notes |
|---------|-----|-------|
| OpenTUI | Strong candidate | Modern TypeScript TUI library with React/Solid/core packages; used by opencode ecosystem, but package notes mention native build requirements. |
| blessed + blessed-contrib | Pragmatic candidate | Mature Node terminal stack with widgets, borders, colors, and built-in grid/dashboard patterns. API is older and imperative but close to current implementation style. |
| Ink | Strong candidate if React is acceptable | React renderer for CLIs with Yoga/Flexbox layout. Good component model, but dashboard panes, focus, scrolling, and logs may require companion components. |
| Silvery | Emerging candidate | Polished React terminal framework with focus, mouse, scroll containers, theming, and testing focus. Evaluate maturity and dependency footprint. |
| TermUI | Emerging candidate | TypeScript framework with widgets, terminal style sheets, command palette, log view, testing, and dev server; evaluate package maturity before adopting. |

## Recommendation For Phase 1 Planning

Start with a spike comparing OpenTUI, blessed-contrib, and Ink/Silvery against this dashboard's concrete needs:

- grid layout with bordered panes
- keyboard focus across peer list, details, logs, and controls
- scrollable recent log view
- color/status themes that work in common terminals
- clean resize handling
- testability without a real terminal
- Node ESM/TypeScript compatibility
- dependency/build friction for npm users

Default recommendation for the first implementation pass: evaluate OpenTUI first for a modern TypeScript lazygit-style TUI, and keep blessed-contrib as the pragmatic fallback if OpenTUI's native/build requirements are too heavy for this package.

## Sources

- OpenTUI GitHub: https://github.com/sst/opentui
- blessed GitHub: https://github.com/chjj/blessed
- blessed-contrib GitHub: https://github.com/yaronn/blessed-contrib
- Ink GitHub: https://github.com/vadimdemedes/ink
- Silvery docs/GitHub entrypoint: https://silvery.dev/
- TermUI docs/GitHub entrypoint: https://www.termui.io/
