# Dashboard v3 — "OPERATOR DECK" (synthesis of two Fable design passes)

**Status:** approved for implementation
**Sources:** Fable design agents — "Operator Deck" (React app patterns) + "Signal Deck" (lazygit/btop TUI craft). This doc is the binding synthesis.
**Palette (Signal Room, unchanged):** bg `#050403` · body `#ffb066` · accent `#ff7a1a` · cyan focus `#35e0d8` · critical `#ff4433` · dim `#8a5a2e` · rule `#3a2410` · selBg `#7a3d0d` · selFg `#ffffff`.

## 1. Concept

A React-app shell translated to the terminal: a left **icon rail** switches five **routes** in one main content area (replaces the 7 always-on panes); the FLEET route is a dense TUI **roster list** (btop/lazygit density — scales to 60+ peers) with a read-only **inspector** side panel; pressing Enter on a peer opens a centered, z-indexed **peer modal** with tabs and chip buttons over a muted backdrop; a **command palette** fuzzy-jumps to any peer or action; **toasts** replace the footer message slot; **logs** live in a bottom drawer. CRT scanline sweeps are pure functions of `nowMs`. Selection is negative/inverse video everywhere, via explicit bg/fg pairs (never the `reverse` attribute — unpredictable over sweep backgrounds).

## 2. Wide layout (≥142 cols)

```
 ◢ DELAMAIN ▸ FLEET     ▐ 12 PEERS ▌ ▐ 3 ACTIVE ▌ ▐ 1 WAITING ▌ ▐ 0 FAILED ▌   : palette
 ─────────────────────────────────────────────────────────────────────────────────────────
 │◉ │ ┌◢ ROSTER ⟨9-14/22⟩ ────────────────────────────◤┐┌◢ INSPECTOR :: p-4f2a ───◤┐
 │1 │ │ ▾ WORKING 4 ▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚ ││ ◉ working   12m34s        │
 │◍ │ │ ◉ ■⬝⬝⬝⬝⬝⬝ p-04  12m4s  deploy-pipeline      ││ codex · gpt-5.5           │
 │2 │ │▐▸ ⬝⬝■⬝⬝⬝⬝ p-07  3m11s  api-fix            ▌││ delamain · feat/gsd-33    │
 │⣿ │ │ ◉ ⬝⬝⬝⬝⬝■⬝ p-11  41s    parser               ││ ◢ GIT                     │
 │3 │ │ ▾ WAITING 2 ▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚▚ ││ base  origin/main         │
 │⇅ │ │ ◍ WAIT     p-09  22m    "run migration?"     ││ tree  linked              │
 │4 │ │ ▸ DONE 6 · KILLED 2 ······················    ││ diff  +120 -8             │
 │⚠ │ │ · · · (empty texture) · · ·                   ││ ◢ TASK                    │
 │5 │ │                                               ││ implement phase 33 …      │
 │  │ └───────────────────────────────────────────────┘└───────────────────────────┘
 ─────────────────────────────────────────────────────────────────────────────────────────
 ▴ LOGS :: p-4f2a ⟨201-220/220⟩                                                  ` toggle
 ▸ TURN turn.started t-88                                                               █
 ⌁ CMD  bun test src/dashboard   exit=0                                                 │
 ─────────────────────────────────────────────────────────────────────────────────────────
 j/k nav · ↵ open · : palette · ` logs · 1-5 view · tab drawer · ? help      ▐ ◉ LIVE ▌
```

- **App bar** h2, `border:["bottom"]` `#3a2410`. Spinner + `DELAMAIN` accent bold, breadcrumb `▸ <ROUTE>` (`▸` dim, route accent), then count chips (reverse pills): `▐ 12 PEERS ▌` bg `#3a2410` fg `#ffb066`; ACTIVE bg `#7a3d0d` fg `#ffd9a8`; WAITING bg `#35e0d8` fg `#050403` when >0 else dim text; FAILED bg `#ff4433` fg `#050403` when >0 else dim text. Right: `: palette` hint dim.
- **Icon rail** width 4, `border:["right"]`, entries stacked 2 rows each (glyph, digit). Routes: `1 ◉ FLEET` · `2 ◍ MAP` · `3 ⣿ LIMITS` · `4 ⇅ UPLINK` · `5 ⚠ ALERTS`. Active entry reversed `bg #ff7a1a fg #050403`. Inactive glyph `#8a5a2e`, digit `#3a2410`. ALERTS glyph alternates `#ff4433`/`#7a3d0d` per `floor(nowMs/480)%2` when warnings exist.
- **Main area** flexGrow 1 — hosts current route.
- **FLEET route** (default): roster list (grow) + inspector (width 30, wide only, `border:["left"]`). Roster = group headers + peer rows (see §5/§6). Inspector = read-only selection summary: status glyph+status+elapsed, engine·model, project·branch, `◢ GIT` (base/tree/diff), `◢ TASK` (3 lines), `◢ LAST` event. Full detail lives in the modal.
- **MAP route:** existing fleetGrid stage×project matrix, full main area, h/j/k/l blip nav kept, Enter on blip opens modal.
- **LIMITS route:** codex limits as braille meters (§6), one block per limit + reset labels.
- **UPLINK route:** telegram supervisor fields (existing content).
- **ALERTS route:** warnings as `⚠`-prefixed rows; empty state = centered `NO SIGNALS` `#3a2410` over `▚▞` dither rows.
- **Logs drawer**: full width, open h = max(9, 24% of screen) / closed h1 (single dim row `▸ LOGS :: <peer> — \` to open`). `border:["top"]`. Reuses current log content/scrollbar/position logic. Route-independent.
- **Footer** h2, `border:["top"]`: key hints (key accent, label dim) + right status chip `▐ ◉ LIVE ▌` bg `#ff7a1a` fg `#050403`, or `▐ ⏸ SCROLLED ▌` bg `#35e0d8` when logOffset>0. Toasts render above the footer right-aligned (§4.4).

## 3. Peer modal (Enter on a peer)

Geometry: `position:"absolute"`, `zIndex:100`, `width min(80, w-8)`, `height min(22, h-6)`, centered, `borderStyle:"double"` color `#35e0d8`, `backgroundColor:"#050403"` (opaque). Title ` ◢ PEER <id> ◤ ` cyan; right corner hint `⟦✕ esc⟧`.

- **Backdrop:** while modal (or palette) open, the entire base tree renders through `mutedTheme(theme)`: all fg → `#2a1808`, borders → `#1a1006`, status colors → `#3a2410`, bg chips dropped. Pure color-mapping function in theme.ts.
- **Summary strip** row: status glyph+status+elapsed · engine·model · project · diff meter.
- **Tabs:** `INFO` (task/question/started/runtime/integration/log path — from view details), `LOG` (last log lines for the peer, j/k scroll, live), `GIT` (source/worktree/base/target/branch/diff). Active tab reversed `bg #ff7a1a fg #050403`; inactive `#8a5a2e`. `tab`/`S-tab`/`h`/`l` cycle.
- **Button row:** chips — focused `▐ ↳ ANSWER ▌` reversed `bg #35e0d8 fg #050403`; unfocused `⟦ ≡ VIEW LOG ⟧` brackets dim, hotkey letter accent; KILL letters `#ff4433`, focused KILL bg `#ff4433`. ANSWER disabled (all `#3a2410`, skipped by focus) unless status waiting. `←/→` move focus, Enter activates, direct hotkeys `a`/`v`/`x`.
- **Answer flow** (`modal-answer`): button row becomes ` ▐ ↳ ▌ input▏` (prompt chip reversed accent, blinking cursor via `floor(nowMs/480)%2`); Enter sends via resumePeer + toast `✔ reply sent`, closes modal; Esc back to buttons.
- **Kill flow** (`modal-kill`): KILL chip becomes `▐ ✕ CONFIRM KILL ▌` bg `#ff4433`, others dim; Enter kills + toast, closes; Esc disarms.
- **VIEW LOG:** closes modal, opens drawer, focuses drawer.
- Close: `esc`/`q` — instant (no close animation). Roster selection unchanged. Data stays live while open.

## 4. CRT scan animations (pure functions of nowMs; 120ms tick)

Phosphor ramp bg tints: `P1 #100a04 · P2 #1a1006 · P3 #2a1808`. Cyan band: `CB #0e2624`, trail `#081413`. Sweeps only set row *backgrounds* (plus one dim-fg brighten), never touch reverse-video rows, and are skipped when `theme === defaultTheme`.

1. **Modal open sweep** (`modalOpenedAt`; D=360ms): `p = min(1, t/D)`, `reveal = ceil(p*modalContentRows)`. Rows < reveal render normally; row == reveal is a full-width cyan bar `bg #35e0d8 fg #050403`; rows > reveal render `▚` filler fg `#150b03` (phosphor not yet lit). t≥D → steady.
2. **Focus/route-change sweep** (`focusChangedAt` set on route switch or drawer focus toggle; D=240ms): `band = floor((t/D)*H)`; row band → bg `P3`, band-1 → `P2`, band-2 → `P1`. Skip when t≥D.
3. **Ambient idle sweep** (no state; period 9000ms): `sweepRow = floor(((nowMs%9000)/9000)*(rosterRows+3))`; roster rows only: row==sweepRow → bg `P2` + dim fg `#8a5a2e` promoted to `#a86f3a`; sweepRow-1 → `P1`. Disabled <100 cols and while modal/palette open. Never on the selected row.
4. **Toast slide-in** (per-toast `createdAt`): width grows `w = ceil(min(1,t/240)*toastW)` anchored right, right-truncated; drop at t≥3000ms; final 240ms fg `#8a5a2e`. Toast chip: `▐ ✔ text ▌` bg `#3a2410` fg `#ffb066` (level error: fg `#ff4433`).

## 5. Negative-highlight rules

| Surface | Active rendering |
|---|---|
| Roster row (selected, main focused) | full-width `bg #ffb066 fg #050403 bold`, `▸` lead |
| Roster row (selected, drawer focused) | `bg #7a3d0d fg #ffb066` |
| Rail route (active) | `bg #ff7a1a fg #050403` both rows |
| Modal tab (active) | `bg #ff7a1a fg #050403` |
| Modal button (focused) | `bg #35e0d8 fg #050403`; armed kill `bg #ff4433` |
| Palette result (highlighted) | `bg #7a3d0d fg #ffffff` |
| MAP blip (selected) | `bg #7a3d0d fg #35e0d8`, 1-char pad each side |
| Footer status chip | `bg #ff7a1a` LIVE / `bg #35e0d8` SCROLLED |
| App-bar count chips | see §2 |

Rules: accent-orange reverse = current location; cyan reverse = acts on Enter; red reverse = destructive armed. Explicit bg/fg only.

## 6. Glyph vocabulary (widely-supported unicode only)

**Status:** working/gsd_running_phase `◉ #ff7a1a` · starting `◌ #35e0d8` · waiting `◍ #35e0d8` · gsd_polling_state `◎ #35e0d8` · gsd_running_gate_check `◐ #35e0d8` · frozen `▣ #35e0d8` · cleanup `⇡ #ffb066` · done/gsd_completed `○ #8a5a2e` · failed/gsd_failed `✖ #ff4433` · gsd_halted_on_gate_failure `⊘ #ff4433` · killed `✕ #ff4433` · idle/gsd_pending `· #8a5a2e`. Working rows keep the knight-rider `■⬝⬝⬝⬝⬝⬝⬝` activity bar.

**Actions:** answer `↳` · view log `≡` · kill `✕` · confirm `✔` · open `▸` · refresh `⟳` · theme `◐` · warning `⚠` · branch `⎇`. **Log-line lead glyphs:** TURN `▸` · CMD `⌁` · FILE `✎` · ERR `✖` · MSG `▪`.

**Chrome:** pane/section titles `◢ TITLE ◤` corner marks; section headers in details/inspector `◢ SECTION` accent; chips focused `▐ … ▌` / idle `⟦ … ⟧`; group-header fill `▚` repeated dim-rule; empty texture `· ` interleave `#3a2410`; unrevealed modal texture `▚` `#150b03`; scrollbar `│`/`█`.

**Braille meters** (limits + header micro-meter + diff density): 7-level cells `⣀⣄⣤⣦⣶⣷⣿`; for percent u over N cells: `filled = round(u/100*N*6)`, cell i = `LEVELS[clamp(filled - i*6, 0, 6)]`. Limits: 12 cells, ok `#ffb066` / warn `#ffd166` / red+skull `#ff4433` (skull keeps `💀` prefix). Diff density single glyph: 0-9 `⣀`, 10-49 `⣤`, 50-199 `⣶`, 200+ `⣿`.

## 7. State machine & keys

**Modes:** `normal | palette | modal | modal-answer | modal-kill | help`. Top-level `answer`/`kill-confirm` modes are deleted (flows live in the modal). Help renders as a modal-styled overlay (same open sweep).

**RuntimeState v3 fields:** `route: "fleet"|"map"|"limits"|"uplink"|"alerts"` · `drawerOpen: boolean` · `drawerFocused: boolean` · `modalPeerId?` · `modalOpenedAt?` · `modalTab: 0|1|2` · `modalButton: number` · `modalScroll: number` · `focusChangedAt?: number` · `paletteQuery: string` · `paletteIndex: number` · `toasts: Array<{text: string; level: "info"|"error"; createdAt: number}>`. Removed: `focusPane`, `collapsedPanes`, `message` (toasts replace it). Keep: `selectedIndex/selectedPeerId/peerOffset/logOffset/collapsedStatuses/followSelectedPeer/forceLogRefresh/visiblePeers/logEventLevels/theme/answerInput`.

**Normal-mode keys:** `1-5` switch route · `j/k/↓/↑` selection (or drawer scroll when drawerFocused) · `h/l/←/→` MAP columns · `enter`/`space` open modal · `tab`/`S-tab` toggle main↔drawer focus · `` ` `` toggle drawer · `:` or `Ctrl+K` palette · `c` collapse focused status group · `g/G` top/bottom · `pgup/pgdn` page · `b` latest logs · `e` previous error (opens+focuses drawer) · `a` open modal straight into answer (if waiting) · `x` open modal with kill armed · `t` theme · `r` refresh toast · `?` help · `q`/Ctrl-C quit.

**Modal keys:** `tab/S-tab/h/l` tabs · `←/→` buttons · `j/k` scroll body · `enter` activate · `a/v/x` direct · `esc/q` close. **modal-answer:** text edit / backspace / enter send / esc back. **modal-kill:** enter kill / esc (or any other key) disarm. **palette:** printable filter, `↑/↓` or Ctrl+P/N move, enter run, esc close.

**Palette contents:** all peers (`▸ <id> · <status> · <project>` → opens modal), `↳ answer <waiting peer>`, `✕ kill <peer>`, `route <name>` ×5, `◐ theme`, `⟳ refresh`, `? help`, `q quit`. Fuzzy = case-insensitive subsequence match. Geometry: absolute zIndex 110, top 3, centered, width min(64, w-8), input row + ≤10 results, border single `#35e0d8`, same muted backdrop.

## 8. Medium / narrow

- **Medium (100-141):** rail unchanged; inspector dropped (modal is the detail surface); drawer h8; else identical.
- **Narrow (<100):** rail becomes a 1-row tab bar under the app bar (`▐◉ FLEET▌ ◍ MAP ⣿ LIM ⇅ UPL ⚠ ALR`, active reversed); roster rows compact (v2 peerDisplayLine style survives); modal w-4 wide, glyph-only chips `▐↳▌ ⟦≡⟧ ⟦✕⟧` + hint row; palette w-4, 6 results; ambient sweep off.

## 9. Implementation plan

**Untouched:** `model.ts`, `logEvents.ts`, data/cache loop in opentuiV2.ts lines 46-180 (copy verbatim), scroll math (`visibleLogContent`/`withScrollbar`), `dashboard.ts` bun launcher.

**New files:** `src/dashboard/opentuiV3.ts` (renderer: app bar, rail, routes, inspector, drawer, modal, palette, toasts, sweep fns — sweeps ~30 lines), `src/dashboard/v3Input.ts` (mode enum, RuntimeState v3, key table in `commandForKey` style, palette filter, toast push/expiry). `bunEntryV2.ts` → point at `runOpenTuiDashboardV3`; keep `runOpenTuiDashboardV2` exported for one release (env `DELAMAIN_DASHBOARD=v2` falls back).

**theme.ts additions:** `ramp: [P1,P2,P3]`, `cyanBand`, `chipBg/chipFg`, `mutedTheme(theme)` function, glyph color table export. Neutral equivalents on `defaultTheme` so `t` toggle keeps working.

**Sequencing:** (1) theme + v3Input + tests; (2) static renderer (routes/roster/inspector/drawer/footer); (3) modal + palette + muted backdrop; (4) sweeps + toasts (pure decoration). Verify each step with `CODEX_PEERS_DASHBOARD_SMOKE=1` pty render.

**Risk to spike first:** absolute-position + zIndex Box over the rebuilt flex tree (5-line spike before building the modal). Per-row bg bands must pad rows to content width (`padEnd` trick from v2's selected row).
