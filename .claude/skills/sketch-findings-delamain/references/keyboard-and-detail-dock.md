# Keyboard Interaction & Detail Dock

## Design Decisions

- **Terminal-first: the dashboard is fully drivable from the keyboard**, using the real bindings in `src/dashboard/keybindings.ts` (`commandForKey()`): `↑/k ↓/j` select, `↵/space` toggle details, `tab` cycle focus pane, `c` collapse status group, `g/G` top/bottom, `e` jump to first error, `a` answer mode, `x` kill mode, `r` refresh, `t` theme, `?` help, `q` quit. Mouse works but is secondary.
- **Winner: Bottom Dock** for peer detail — a fixed-height (~16em) pane at the bottom that always shows the selected peer. Chosen over inline expand (list shifts down — jumpy) and a centered modal (hides the fleet). Moving selection with j/k live-updates the dock; the list never shifts.
- **Dock log is a scrollable history, not a 3-line tail:**
  - Mouse wheel scrolls when the pointer/focus is on the dock.
  - `tab` focuses the dock (logs pane): top border + scrollbar turn teal with glow; then `j/k/↑↓` scroll lines, `PgUp/PgDn` page, `b` jumps to bottom (log-bottom binding).
  - **Tail-follow:** stick to newest lines by default; scrolling up detaches, returning to bottom (or `b`) re-attaches. Changing peer selection resets to tail.
  - **Position indicator** in the dock title, right-aligned: `log 39/39 ▼ tail` / `log 12/39 ▲ scrolled`.
  - Themed scrollbar: amber thumb at rest, cyan + glow on hover/focus.
- **Modes live in the status line** (bottom, above keybar), mirroring DashboardMode: kill-confirm shows `kill <id>? ↵ confirm · esc cancel` in red with glow; answer mode shows an inline input `reply → <id>: [input]` in teal.
- **Always-visible footer keybar** that re-renders to reflect the focused pane (e.g. `↑↓/jk scroll log` when logs focused, `tab focus peers`).
- **Help overlay on `?`** — centered panel listing the keybindings, esc/?/q to close.

## CSS Patterns

```css
.dock { flex: none; height: 16em; border-top: 1px solid var(--color-border); display: flex; flex-direction: column; }
.dock.focused { border-top-color: var(--color-border-focus); box-shadow: 0 -4px 16px rgba(53,224,216,.22); }
.dock-body { flex: 1; overflow-y: auto; scrollbar-gutter: stable; scrollbar-width: thin;
	scrollbar-color: var(--color-border) var(--color-surface-2); }
.dock.focused .dock-body { scrollbar-color: var(--color-accent) var(--color-surface-2); }
.statusline.warn { color: var(--color-danger); text-shadow: var(--glow-red); }
.statusline.ask { color: var(--color-accent); }
```

## Interaction Logic (tail-follow)

```js
let dockScroll = null; // null = follow tail
function updateDockPos() {           // onscroll
	const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
	dockScroll = atBottom ? null : el.scrollTop;
	// indicator: `log ${line}/${total} ${atBottom ? "▼ tail" : "▲ scrolled"}`
}
// after each render: el.scrollTop = dockScroll === null ? el.scrollHeight : dockScroll;
// on selection change (j/k): dockScroll = null;  // jump back to tail
```

## What to Avoid

- **Inline expand under the row** (002 A) — the list shifting on ↵ is disorienting while scanning.
- **Centered peer modal** (002 C) — obscures the fleet; breaks the monitor-everything premise.
- Hover-only affordances — every action needs a key; hover is enhancement only.
- Auto-scroll that fights the user — never yank to bottom while they're scrolled up.

## Origin
Synthesized from sketch: 002 (winner B). Source: sources/002-signal-rack-terminal/
