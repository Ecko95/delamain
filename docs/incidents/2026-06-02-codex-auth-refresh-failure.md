# Incident: Codex auth refresh failure stopped five Delamain peers

Date: 2026-06-02

Times below are UTC as recorded in Delamain archived peer state. Local time on the orchestrator machine was CEST (UTC+02:00).

## Summary

Five Delamain Codex peers failed immediately after launch because the Codex CLI could not refresh its access token:

```text
Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.
```

Delamain reached the handoff point successfully: worktrees were created, peer branches were created, runner processes started, and Codex was launched. Codex then exited during startup/auth refresh before any repository task execution began.

This was a shared environment/session problem, not five independent task failures and not a code issue in `experiencecloud` or `isomer-calc-engine`.

## Impact

- All five affected peers ended with `status: failed`.
- No peer reached task execution.
- No implementation or analysis work was produced by these peers.
- Worktrees and branches existed only as failed launch artifacts.

## Affected peers

| Peer ID | Name | Source repo | Base ref | Started at | Finished at | Duration | Last event | Exit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `646dc0ef` | `ec-runtime-metadata` | `/home/joshua/dev/bts/experiencecloud` | `origin/development` | `2026-06-02T20:43:32.902Z` | `2026-06-02T20:43:36.689Z` | 3.787s | `codex exited code=1` | 1 |
| `c71a267c` | `ec-participant-bridge` | `/home/joshua/dev/bts/experiencecloud` | `origin/development` | `2026-06-02T20:43:54.756Z` | `2026-06-02T20:43:58.711Z` | 3.955s | `codex exited code=1` | 1 |
| `e0fea24f` | `ec-facilitator-bridge` | `/home/joshua/dev/bts/experiencecloud` | `origin/development` | `2026-06-02T20:44:12.237Z` | `2026-06-02T20:44:16.025Z` | 3.788s | `codex exited code=1` | 1 |
| `944d0130` | `isomer-api-discovery` | `/home/joshua/dev/projects/isomer-calc-engine` | `origin/main` | `2026-06-02T20:45:22.171Z` | `2026-06-02T20:45:26.515Z` | 4.344s | `codex exited code=1` | 1 |
| `86244b71` | `ec-demo-docs` | `/home/joshua/dev/bts/experiencecloud` | `origin/development` | `2026-06-02T20:45:41.399Z` | `2026-06-02T20:45:47.857Z` | 6.458s | `codex exited code=1` | 1 |

All five records were archived at `2026-06-02T20:52:55.143Z`.

## Evidence

Each peer record had the same terminal shape:

- `status: failed`
- `lastEvent: codex exited code=1`
- `exitCode: 1`
- `finalResult` contained the Codex refresh-token failure

Log paths:

- `/home/joshua/.delamain/runs/2026-06-02T20-43-32-896Z-646dc0ef.log`
- `/home/joshua/.delamain/runs/2026-06-02T20-43-54-751Z-c71a267c.log`
- `/home/joshua/.delamain/runs/2026-06-02T20-44-12-232Z-e0fea24f.log`
- `/home/joshua/.delamain/runs/2026-06-02T20-45-22-165Z-944d0130.log`
- `/home/joshua/.delamain/runs/2026-06-02T20-45-41-394Z-86244b71.log`

## Secondary warning

The failed peers also emitted this warning before the auth failure:

```text
`[features].codex_hooks` is deprecated. Use `[features].hooks` instead.
```

That warning did not kill the peers. It was configuration drift in the Delamain Codex launch flags. The runtime fix is to disable hooks through Codex's current flag:

```bash
--disable hooks
```

or the equivalent config key:

```bash
-c features.hooks=false
```

## Recovery

1. Re-authenticate Codex on the same machine/user account that Delamain uses:

   ```bash
   codex logout
   codex login
   ```

2. Run a direct Codex smoke test before respawning the batch:

   ```bash
   printf 'say ok\n' | timeout 30 codex exec --json --disable hooks -C /tmp -
   ```

   The smoke passes when Codex starts, emits a normal JSON event stream, and exits without the refresh-token error.

3. Respawn the failed peers after the smoke passes:

   - `ec-runtime-metadata`
   - `ec-participant-bridge`
   - `ec-facilitator-bridge`
   - `isomer-api-discovery`
   - `ec-demo-docs`

4. Keep the failed peer records archived. They are useful as incident evidence, but they should not be resumed because the failure occurred before task execution.

## Prevention

- Keep Delamain launch flags on `--disable hooks` or `features.hooks=false`; do not use deprecated `features.codex_hooks`.
- After Codex auth changes, run one direct `codex exec` smoke before launching a large peer batch.
- Treat multiple peers failing within seconds with the same Codex startup message as a shared environment failure first.
