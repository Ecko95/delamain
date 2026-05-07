---
phase: 01-full-dynamic-lazygit-style-dashboard-tui-using-a-proven-term
plan: 01
status: complete
completed: 2026-05-07
---

# Plan 01-01 Summary: OpenTUI Dependency/Runtime Proof

## Dependency Decision

- `npm view @opentui/core version --json` returned `"0.2.4"`.
- Installed `@opentui/core` at exact version `0.2.4`.
- `package.json` keeps `"node": ">=20"`.
- Production dashboard code now keeps the Node CLI wrapper in `src/dashboard.ts` and launches a Bun-backed OpenTUI entrypoint for dashboard commands.

## OpenTUI Compatibility Result

OpenTUI compatibility result: Proceed with OpenTUI through a Bun-backed dashboard runtime.

Direct package import command:

```bash
node --input-type=module -e "const m = await import('@opentui/core'); console.log(typeof m.createCliRenderer, typeof m.Box, typeof m.Text, typeof m.ScrollBoxRenderable)"
```

Runtime: Node.js v25.5.0 under the repo's Node ESM CLI package.

Terminal: non-interactive Codex worker shell; the failure occurs during module import before TTY rendering begins.

Result: failed before renderer creation.

Error:

```text
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".scm" for node_modules/@opentui/core/assets/javascript/highlights.scm
```

Built smoke command:

```bash
npm run build
node --input-type=module -e "const m = await import('./dist/dashboard/opentuiRuntime.js'); await m.runOpenTuiCompatibilitySmoke()"
```

Built smoke result: failed with the same `ERR_UNKNOWN_FILE_EXTENSION` for `node_modules/@opentui/core/assets/javascript/highlights.scm` before renderer creation.

Additional checks:

```bash
node --input-type=module -e "const m = await import('@opentui/core/renderer.js'); console.log(typeof m.createCliRenderer)"
node --input-type=module -e "const m = await import('@opentui/core/renderables/index.js'); console.log(typeof m.BoxRenderable, typeof m.TextRenderable)"
node --input-type=module -e "const m = await import('@opentui/core/renderables/composition/constructs.js'); console.log(typeof m.Box, typeof m.Text)"
```

Each subpath check failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, because `@opentui/core@0.2.4` only exports the package root plus testing/runtime-plugin entries.

## Bun Runtime Decision

The orchestrator selected a Bun-backed dashboard runtime rather than the `blessed-contrib` fallback. The package remains a Node >=20 ESM CLI for MCP/server/non-dashboard behavior. Only `codex-peers dashboard`, `codex-peers --d`, and `codex-peers -d` require Bun.

Bun proof command:

```bash
bun --eval "const m = await import('@opentui/core'); console.log(typeof m.createCliRenderer, typeof m.Box, typeof m.Text, typeof m.ScrollBox)"
```

Result: passed with Bun 1.3.11.

## Outcome

Proceed with OpenTUI using the Bun-backed dashboard runtime. Node remains the main package runtime for MCP/server/CLI behavior, and dashboard commands fail with an actionable Bun installation message if Bun is missing.

## Verification

- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: passed.
- `CODEX_PEERS_DASHBOARD_SMOKE=1 node dist/index.js --d`: passed with Bun and exited cleanly.
