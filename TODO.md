# Delamain — TODO / Progress

## Current status
Session 2026-05-30: reinstall + rebuild, peer archive feature, smoke test, and
dashboard engine icons all complete. Source changes are in the working tree
(uncommitted) — rebuilt `dist/` is live, so the running dashboard + CLI already
have the new behavior.

## Completed (2026-05-30)
- [x] Reinstall deps + rebuild `dist` to latest `origin/main` (was already current).
- [x] **Peer archive feature** — archived peers move to `state.archive.json` and
      drop off the live list/dashboard; fully reversible.
  - `src/store.ts`: `readArchive`/`writeArchive`/`archivePeersByIds`/`unarchivePeersByIds`.
  - `src/peerManager.ts`: `archivePeers({ids?, allFinished?})`, `unarchivePeers`,
    `listArchivedPeers`, `isArchivable` (live statuses never archived).
  - `src/cli.ts`: `delamain archive [--all-finished | <id>...]`, `unarchive <id>...`, `archived`.
  - `src/mcpServer.ts`: MCP tools `archive_peers`, `unarchive_peers`, `list_archived_peers`.
  - Tests: `tests/archive.test.mjs` (4).
- [x] Archived all 274 finished peers; only the running peer kept. Backup at
      `~/.delamain/state.json.bak-<ts>`.
- [x] Smoke test: codex (gpt-5.4) + cursor (composer-2.5) peers both ran `done` and
      appeared on the channel. Confirms Composer 2.5 via BTS OAuth (cursor-agent
      logged in as joshua.duffill@bts.com).
- [x] **Dashboard engine icons** — per-engine glyph + brand colour in the peer row
      and an `engine` row in the details pane.
  - `src/dashboard/engineIcon.ts`: cursor → U+F245 (pointer, purple), codex →
    U+F121 (code, OpenAI green). ASCII fallback `CU`/`CX` via `DELAMAIN_ICONS=ascii`.
    Glyph overridable via `DELAMAIN_ICON_CURSOR`/`DELAMAIN_ICON_CODEX`.
  - `src/dashboard/model.ts` + `opentuiV2.ts`: row + details wiring.
  - Nerd Font installed in WSL (`~/.local/share/fonts/JetBrainsMonoNerdFont*`);
    Windows copies staged at `~/.delamain/fonts/`.
  - Tests: `tests/engineIcon.test.mjs` (6).

## Notes for future sessions
- The **Windows terminal** font must be set to "JetBrainsMono Nerd Font" for the
  glyphs to render (installing in WSL only covers Linux-side rendering). TTFs to
  install on Windows are at `~/.delamain/fonts/`.
- The live MCP server (this session) still runs pre-rebuild code, so the new
  `archive_peers` MCP tools appear only after the MCP server reloads. The CLI
  (`delamain archive ...`) already uses the new build.
- All 120 tests pass. Nothing committed/pushed — run a PR when ready.
- The old `50254b61` peer is a stale autopilot peer from 2026-05-17 (pid dead);
  it reconciles to `frozen` and can be archived too for a fully empty list.
