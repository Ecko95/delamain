# Troubleshooting: Peer hangs at `turn.started`

## Symptoms

A spawned peer produces `{"type":"turn.started"}` in its log and then emits no further output — no tool calls, no message tokens, no `turn.completed`. The peer appears frozen for 30+ minutes. `codex-peers status <id>` shows `status: working` indefinitely.

## Root causes

### 1. `model_reasoning_effort = "xhigh"` in the user's codex config

**What happens.** When a user has `model_reasoning_effort = "xhigh"` set in `~/.codex/config.toml`, every spawned peer inherits it. This puts the model into extended deep-reasoning mode — even a modest codebase prompt can take 30–60+ minutes before the first output token is emitted. The peer is not stuck; it is thinking, but too slowly to be useful.

**Fixed in `src/runner.ts` and `src/gsdRunner.ts` (commit `fix/peer-codex-config-inheritance`).** The spawn now injects `-c model_reasoning_effort="high"` for any model other than `gpt-5.5`. `gpt-5.5` retains the user's configured effort level because it is the primary interactive model and the user may intentionally want `xhigh` there. All other models (e.g. `gpt-5.4`) are capped at `high`, which keeps peers responsive while still using strong reasoning.

```
// What is now injected at spawn time for non-gpt-5.5 models:
-c model_reasoning_effort="high"
```

**If you still see slow peers on `gpt-5.5`.** Either switch to `gpt-5.4` for background peer work, or set `model_reasoning_effort = "high"` globally in your `config.toml` for the duration of an autopilot run.

---

### 2. Stale `trusted_hash` for a GSD SessionStart hook

**What happens.** The GSD toolkit installs a `[[hooks.SessionStart]]` entry in `~/.codex/config.toml` that runs `gsd-check-update.js` on every session start. The hook command's sha256 hash is stored alongside it under `[hooks.state]`. When GSD updates the hook script, the stored hash becomes stale. In interactive mode codex prompts the user to re-approve the changed command; in non-interactive `codex exec` (how peers run), it silently waits for that approval forever — the peer hangs.

**Fixed in `src/runner.ts` and `src/gsdRunner.ts` (same commit).** The spawn now passes `--disable hooks` for all peers. Peers have no need for GSD session hooks, so disabling the feature entirely is correct and safe.

```
// Injected at spawn time for all peers:
--disable hooks

// Equivalent config override:
-c features.hooks=false
```

**Manual recovery (before the fix).** Create a minimal peer `CODEX_HOME` directory containing only `auth.json` and a `config.toml` that omits the `[[hooks.SessionStart]]` / `[hooks.state]` sections, then set `CODEX_HOME` in the environment before calling `codex-peers spawn`:

```bash
mkdir -p ~/.codex-peers/peer-codex-home
cp ~/.codex/auth.json ~/.codex-peers/peer-codex-home/auth.json
# write a config.toml without hooks and with model_reasoning_effort = "high"

CODEX_HOME=~/.codex-peers/peer-codex-home codex-peers spawn \
  --repo /path/to/repo \
  --model gpt-5.4 \
  --yolo \
  --prompt "..."
```

**Updating a stale hash manually (without this fix).** Compute the sha256 of the exact command string codex stores (the TOML-parsed value of `command =`) and replace the `trusted_hash` value in `[hooks.state]`:

```bash
CMD='"/path/to/node" "/path/to/gsd-check-update.js"'
echo -n "$CMD" | sha256sum
# Update trusted_hash = "sha256:<output>" in ~/.codex/config.toml
```

---

## Diagnostic checklist

If a peer is stuck at `turn.started`:

1. **Check CPU.** `ps aux | grep <codexPid>`. If the codex subprocess shows 0.0% CPU for more than 2 minutes, it is not reasoning — it is waiting.

2. **Test codex exec directly.**
   ```bash
   echo "say ok" | timeout 20 codex exec --json --model gpt-5.5 -C /tmp - 2>&1
   ```
   If this also hangs at `turn.started`, the issue is in your global config, not the peer prompt.

3. **Isolate with `--ignore-user-config`.**
   ```bash
   echo "say ok" | timeout 20 codex exec --json --ignore-user-config --model gpt-5.5 -C /tmp - 2>&1
   ```
   If this works but the previous command hangs, something in `~/.codex/config.toml` is the cause.

4. **Check `model_reasoning_effort`.** If `config.toml` contains `model_reasoning_effort = "xhigh"` and the peer is using a non-gpt5.5 model, upgrade to the fixed version of this package. As a temporary fix, override at spawn time: `CODEX_HOME=/path/to/minimal-home codex-peers spawn ...`.

5. **Check hooks.** If the `[hooks.state]` section has a `trusted_hash` and GSD was recently updated, the hash may be stale. Either update the hash or add `--disable hooks` or `-c features.hooks=false` to your spawn invocation.
