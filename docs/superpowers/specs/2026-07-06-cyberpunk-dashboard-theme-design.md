# Cyberpunk dashboard theme — design

**Status:** approved, ready for planning
**Mockup:** [`docs/superpowers/mockups/2026-07-06-cyberpunk-dashboard-theme-mockups.html`](../mockups/2026-07-06-cyberpunk-dashboard-theme-mockups.html) — variant 2, "Signal Room", chosen.

## Goal

Add a selectable "cyberpunk" visual theme to the OpenTUI peer dashboard (`src/dashboard/opentuiV2.ts`), inspired by a SAKA-style amber/orange retro terminal UI, without disturbing the existing default look. Amber body + cyan focus accent, red for failed/critical status, a dim row separator for scan texture.

## Non-goals

- No literal CSS scanline (terminals can't render translucency overlays) — approximated with a dim horizontal rule character between rows instead.
- No per-pane theme mixing.
- No persisting a runtime theme override across restarts — the env var is the persistent default; the keybind override is session-only.

## Architecture

### `src/dashboard/theme.ts` (new)

```ts
export type Theme = {
  border: string;
  borderFocused: string;
  text: string;
  textDim: string;
  statusColors: Record<DashboardStatus, string>;
  rowRule?: string; // dim separator drawn between peer/log rows; undefined = no rule
};

export const defaultTheme: Theme = { /* today's hardcoded values, extracted verbatim */ };
export const cyberpunkTheme: Theme = { /* amber body/text, cyan borderFocused, remapped status colors, rowRule: "─" */ };
```

Zero visual change for `defaultTheme` — it's a lossless extraction of the current hardcoded constants (`STATUS_COLORS` in `model.ts`, the `"#facc15"`/`"#475569"` literals in `opentuiV2.ts`'s `paneProps`).

### `model.ts`

`statusColor(status: DashboardStatus, theme: Theme = defaultTheme)` — gains a theme param defaulted to `defaultTheme` so existing callers and tests keep working unchanged.

### `opentuiV2.ts`

- `paneProps` reads `borderColor` / focused `borderColor` from `state.theme` instead of the two hardcoded hex literals.
- Peer-row rendering (`peerDisplayLines` / row-joining logic) and log-line rendering insert `theme.rowRule` between entries when the active theme defines one.
- `RuntimeState` gains a `theme: Theme` field.

### Toggle mechanism

- **Env var (persistent default):** `DELAMAIN_THEME=cyberpunk` at launch → `state.theme` initialized to `cyberpunkTheme`. Any other value or unset → `defaultTheme`.
- **Keybind (session override):** new `keybindings.ts` command `cycle-theme` bound to key `t` (currently unbound in `commandForKey`). Flips `state.theme` between `defaultTheme` and `cyberpunkTheme` at runtime; does not touch the env var or persist past the process.

## Testing

Add to `tests/dashboard.test.mjs`:
- `commandForKey("t")` → `"cycle-theme"`.
- `statusColor("working", cyberpunkTheme)` differs from `statusColor("working", defaultTheme)`.
- `defaultTheme`'s border/status colors match today's hardcoded values (regression guard for the "zero visual change" claim).
