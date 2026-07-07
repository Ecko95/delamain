# Layout & Density — Signal Rack

## Design Decisions

- **Winner: Signal Rack** — one dense monospace row per peer, grouped under status headers in triage order: WORKING → WAITING → STARTING → FAILED → DONE. Chosen over a card grid (B) and a roster+detail cockpit split (C) because the operator's primary mode is scanning the whole fleet, and it's the cheapest to build on the existing OpenTUI dashboard.
- **Row contents (left→right):** selection caret `▶` + status glyph, peer id (teal), engine chip, branch, activity, context meter, compacted flag `⛁`, elapsed (right-aligned, dim).
- **Status glyphs:** working `◉`, waiting `◍` (blinking), starting `◌`, done `●`, failed `✖`.
- **Context-window telemetry inline per row** as a 10-cell block meter `████░░░░░░ 42%`, colored by contextLevel — green `#35e0d8`, yellow `#ffb066`, red `#ff7a1a`, skull `#ff4433` (skull blinks + glows).
- **Fleet header bar:** `DELAMAIN ▍FLEET` logo (orange, glow) + per-status count chips + codex 5h usage meter (teal).
- **Palette is exactly `cyberpunkTheme` from `src/dashboard/theme.ts`** — bg `#100a04`, surface `#1a1006`/`#2a1808`, border `#3a2410`, text `#ffb066`, dim `#8a5a2e`, primary orange `#ff7a1a`, accent teal `#35e0d8`, danger `#ff4433`, selection bg `#7a3d0d`. Cursor-engine chips use purple `#c084fc`.
- **Aesthetic details:** monospace/Nerd Font everywhere, sharp corners (2–4px radius), CRT scanline overlay, glow shadows on focused/alert elements, box-drawing `─` group rules.

## CSS Patterns

```css
/* CRT scanlines over the whole page */
body::after {
	content: ""; position: fixed; inset: 0; pointer-events: none;
	background: repeating-linear-gradient(0deg, rgba(0,0,0,.18) 0 1px, transparent 1px 3px);
}
/* glow vocabulary */
--glow-orange: 0 0 8px rgba(255,122,26,.35);
--glow-cyan: 0 0 8px rgba(53,224,216,.35);
--glow-red: 0 0 10px rgba(255,68,51,.45);
/* blinking urgency (waiting status, skull context) */
@keyframes blink { 50% { opacity: .35; } }
/* selected row */
.row.sel { background: var(--color-sel-bg); color: #fff; }
```

## HTML Structures

Terminal frame: a single flex column — header bar / scrollable rows / (dock) / status line / keybar — with `white-space: pre` so alignment is character-based like the TUI.

```html
<div class="term">
	<div class="hdr">DELAMAIN ▍FLEET ◉2 working ◍1 waiting … codex 5h ▓▓▓▓▓▓░░░░ 63%</div>
	<div class="rows">
		<div class="grp">▾ WORKING 2 ─────────</div>
		<div class="row sel">▶ ◉ e86e7ad2 codex peer/… EDIT … ████░░ 42% 12m04s</div>
	</div>
	<div class="statusline"></div>
	<div class="keybar">↑↓/jk move · ↵ details · …</div>
</div>
```

## What to Avoid

- **Card grid** (001 variant B) — nice for triage-at-a-glance but wastes space, hides ordering, and drifts from the terminal idiom.
- **Cockpit split with permanent side roster** (001 variant C) — the 300px roster steals width from logs; detail-first, not fleet-first.
- Rounded/soft-shadow "web app" styling — everything stays sharp, mono, scanlined.

## Origin
Synthesized from sketch: 001 (winner A). Source: sources/001-peer-monitor-layout/
