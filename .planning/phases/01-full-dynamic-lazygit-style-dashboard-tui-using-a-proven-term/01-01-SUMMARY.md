---
phase: 01-full-dynamic-lazygit-style-dashboard-tui-using-a-proven-term
plan: 01
status: blocked
completed: 2026-05-07
---

# Plan 01-01 Summary: OpenTUI Dependency/Runtime Proof

## Dependency Decision

- `npm view @opentui/core version --json` returned `"0.2.4"`.
- Installed `@opentui/core` at exact version `0.2.4`.
- `package.json` keeps `"node": ">=20"`.
- Production dashboard code in `src/dashboard.ts` was not migrated.

## OpenTUI Compatibility Result

OpenTUI compatibility result: OpenTUI friction unacceptable.

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

## Outcome

Do not continue to Plans 01-02 or 01-03 under the current Node CLI runtime. The recorded blocker matches the fallback policy: reconsider `blessed-contrib` or make an explicit runtime/distribution decision for a Bun-backed dashboard path before replacing `src/dashboard.ts`.

## Verification

- `npm run check`: passed.
- `npm run build`: passed.
- `npm test`: passed, 5 tests.
- Manual TTY smoke: not run because OpenTUI fails during Node module import before TTY rendering begins.
