# Claude Squad Research

## 1. Overview

Claude Squad is a Go terminal app for managing multiple AI coding agents in separate workspaces. The upstream repo is `smtg-ai/claude-squad`, licensed under AGPL-3.0, and was last pushed on 2026-05-15. Its stack is Go plus Bubble Tea for the TUI, tmux for terminal isolation, git worktrees for workspace isolation, and the GitHub CLI for push/sync flows.

The README frames it as a multi-agent terminal manager for Claude Code, Codex, Gemini, Aider, OpenCode, and Amp, but the actual implementation is narrower: the core runtime is a shell-command launcher plus tmux/worktree management. The "backend" is mostly a command string, not a typed interface.

## 2. Backend Abstraction

There is no Go interface such as `Backend`, `Runner`, or `AgentDriver`. The abstraction boundary is `config.Profile.Program` and `session.Instance.Program`, both plain strings.

Key code paths:

- `config/config.go`: defines `Profile` and `Config`, and resolves the active program via `Config.GetProgram()`.
- `ui/overlay/profilePicker.go` and `ui/overlay/textInput.go`: let the user choose a profile before starting an instance.
- `app/app.go`: copies the selected profile's `Program` into the new `session.Instance` before `Start(true)`.
- `session/tmux/tmux.go`: passes `program` directly into `tmux new-session ... <program>`.

The actual dispatch logic is string-based:

- Claude, Aider, and Gemini are only special-cased for trust-prompt detection and prompt heuristics in `session/tmux/tmux.go`.
- Codex is not special-cased at all; it is just another executable name that can be put in `Program` or a profile.
- There is no per-backend compile-time branching like our `PeerEngine = "codex" | "cursor"` type in `src/types.ts`.

Comparison to this repo:

- In our code, `src/types.ts` constrains backend choice to `PeerEngine = "codex" | "cursor"`, and `src/runner.ts` dispatches on that enum to either `codex` or `cursor-agent`.
- In Claude Squad, the equivalent choice is a shell command string, so it is more flexible but less type-safe and less explicit.
- Our model is better for supervised orchestration and invariants; Claude Squad's model is better for "launch whatever command I want in a tmux workspace".

Code snippets:

```go
type Profile struct {
    Name    string `json:"name"`
    Program string `json:"program"`
}
type Config struct {
    DefaultProgram string `json:"default_program"`
    AutoYes bool `json:"auto_yes"`
    Profiles []Profile `json:"profiles,omitempty"`
}
func (c *Config) GetProgram() string {
    for _, p := range c.Profiles {
        if p.Name == c.DefaultProgram { return p.Program }
    }
    return c.DefaultProgram
}
```

```go
if strings.HasSuffix(t.program, ProgramClaude) {
    if strings.Contains(content, "Do you trust the files in this folder?") ||
        strings.Contains(content, "new MCP server") {
        if err := t.TapEnter(); err != nil {
            log.ErrorLog.Printf("could not tap enter on trust/MCP screen: %v", err)
        }
        return true
    }
} else {
    if strings.Contains(content, "Open documentation url for more info") {
        if err := t.TapDAndEnter(); err != nil {
            log.ErrorLog.Printf("could not tap enter on trust screen: %v", err)
        }
        return true
    }
}
```

## 3. Tmux Session-per-Agent Model

Claude Squad uses one tmux session per instance. The session name is derived from the instance title and prefixed with `claudesquad_`, so each agent gets an isolated tmux session rather than a shared multiplexer.

Code pointers:

- `session/tmux/tmux.go:64-152` for session creation and startup.
- `session/tmux/tmux.go:258-373` for attach/detach lifecycle.
- `session/instance.go` for how the tmux session is owned by an instance.

Attach/detach mechanics:

- `Start()` runs `tmux new-session -d -s <name> -c <workDir> <program>`.
- It polls for session existence, then `Restore()` attaches to the tmux session through a PTY.
- `Attach()` wires `io.Copy(os.Stdout, t.ptmx)` plus stdin forwarding.
- Pressing `Ctrl-Q` in the attach loop calls `Detach()`.
- `Detach()` closes the PTY, restores a fresh `tmux attach-session` PTY, and keeps the tmux session alive.
- `DetachSafely()` is the non-panicking variant used by pause/cleanup paths.

Code snippet:

```go
cmd := exec.Command("tmux", "new-session", "-d", "-s", t.sanitizedName, "-c", workDir, t.program)
```

```go
if nr == 1 && buf[0] == 17 {
    // Detach from the session
    t.Detach()
    return
}

// Forward other input to tmux
_, _ = t.ptmx.Write(buf[:nr])
```

## 4. Workspace Isolation + Review Gate

The workspace isolation is implemented with git worktrees, one per instance:

- `session/git/worktree.go` chooses a branch name from the configured prefix plus session title.
- `session/git/worktree_ops.go` creates a unique worktree directory under `~/.claude-squad/worktrees/...`.
- New sessions use `git worktree add -b ... <head-commit>` so they start from a clean commit, not from uncommitted state.
- Existing branches can be opened as worktrees too, and are preserved on cleanup.

The exact "review before applying" behavior is UI-driven, not a hard policy engine:

- `app/app.go:712-734` wraps push in a confirmation modal before calling `worktree.PushChanges(...)`.
- `app/app.go:735-748` wraps checkout in a help-screen step before calling `selected.Pause()`.
- `session/instance.go:Pause()` commits dirty changes locally, detaches from tmux, removes the worktree, and prunes the worktree metadata.

So the gate is:

1. Show the diff/preview in the TUI.
2. Ask for explicit confirmation before push.
3. On checkout/pause, keep the branch and remove the isolated workspace.

This is a manual-review gate, not an automated diff approval gate. I did not find a code path that enforces a formal "review changes before applying" decision beyond the modal and the TUI preview.

Code snippets:

```go
if dirty, err := i.gitWorktree.IsDirty(); err != nil {
    errs = append(errs, fmt.Errorf("failed to check if worktree is dirty: %w", err))
    log.ErrorLog.Print(err)
} else if dirty {
    commitMsg := fmt.Sprintf("[claudesquad] update from '%s' on %s (paused)", i.Title, time.Now().Format(time.RFC822))
    if err := i.gitWorktree.CommitChanges(commitMsg); err != nil {
        errs = append(errs, fmt.Errorf("failed to commit changes: %w", err))
        log.ErrorLog.Print(err)
        return i.combineErrors(errs)
    }
}

if err := i.tmuxSession.DetachSafely(); err != nil {
    errs = append(errs, fmt.Errorf("failed to detach tmux session: %w", err))
    log.ErrorLog.Print(err)
}
```

```go
if _, err := os.Stat(i.gitWorktree.GetWorktreePath()); err == nil {
    if err := i.gitWorktree.Remove(); err != nil {
        errs = append(errs, fmt.Errorf("failed to remove git worktree: %w", err))
        log.ErrorLog.Print(err)
        return i.combineErrors(errs)
    }

    if err := i.gitWorktree.Prune(); err != nil {
        errs = append(errs, fmt.Errorf("failed to prune git worktrees: %w", err))
        log.ErrorLog.Print(err)
        return i.combineErrors(errs)
    }
}
```

```go
pushAction := func() tea.Msg {
    commitMsg := fmt.Sprintf("[claudesquad] update from '%s' on %s", selected.Title, time.Now().Format(time.RFC822))
    worktree, err := selected.GetGitWorktree()
    if err != nil { return err }
    if err = worktree.PushChanges(commitMsg, true); err != nil { return err }
    return nil
}
return m, m.confirmAction(message, pushAction)
```

## 5. Features Worth Porting

| Feature | LOC estimate | deps | risk |
|---|---:|---|---|
| Safe tmux attach/detach with PTY restoration | 150-220 | `tmux`, `creack/pty`, stdin/stdout plumbing | Medium: PTY lifecycle bugs are easy to get wrong |
| Per-session git worktrees with pause/resume | 200-300 | `git`, `gh`, filesystem cleanup, branch naming | Medium: branch/worktree cleanup can corrupt user state if mishandled |
| Profile picker for launching different backends | 80-120 | Bubble Tea overlay, config JSON | Low: mostly UI and config wiring |
| Auto-accept daemon | 50-90 | background poll loop, prompt detection | High: false positives can accept dangerous prompts |
| Explicit confirm modal before push/kill | 30-60 | Bubble Tea confirmation overlay | Low: simple UX, good safety payoff |

## 6. What's It Missing vs Codex-Peers

- No typed engine abstraction like `PeerEngine = "codex" | "cursor"`.
- No MCP/CLI-style headless supervisor that can spawn, wait on, and integrate peers programmatically.
- No autonomous chaining or queue-driven state machine.
- No explicit halt-on-failure policy beyond the UI flow and normal error handling.
- No explicit integration audit trail equivalent to our peer record lifecycle.
- No Cursor-specific options or engine-specific process dispatch.

The closest analogue to automation is the `AutoYes` daemon, but it only polls existing sessions and presses Enter when a known prompt is detected. It is not an orchestrator.

## 7. Recommendation

**Inspire, do not port wholesale.**

Port the tmux/worktree ergonomics and the profile-picker UX. Those are practical and low risk. Skip the backend abstraction style itself, because Claude Squad's "backend" is just a command string. For `codex-peers`, the stronger model is our explicit `PeerEngine` enum plus separate runner paths in `src/runner.ts` and `src/mcpServer.ts`.

What I would actually port first:

- Safe attach/detach semantics.
- Worktree pause/resume lifecycle.
- Confirmation modal pattern before irreversible actions.
- Optional auto-accept daemon ideas, but only with stricter prompt classification than Claude Squad has today.

## Sources

- GitHub repo metadata from `gh api repos/smtg-ai/claude-squad`
- Upstream README: `https://github.com/smtg-ai/claude-squad/blob/main/README.md`
- Upstream config: `https://github.com/smtg-ai/claude-squad/blob/main/config/config.go`
- Upstream instance lifecycle: `https://github.com/smtg-ai/claude-squad/blob/main/session/instance.go`
- Upstream tmux runtime: `https://github.com/smtg-ai/claude-squad/blob/main/session/tmux/tmux.go`
- Upstream worktree ops: `https://github.com/smtg-ai/claude-squad/blob/main/session/git/worktree.go`
- Upstream worktree mutations: `https://github.com/smtg-ai/claude-squad/blob/main/session/git/worktree_ops.go`
- Upstream app flow: `https://github.com/smtg-ai/claude-squad/blob/main/app/app.go`
- Upstream profile picker: `https://github.com/smtg-ai/claude-squad/blob/main/ui/overlay/profilePicker.go`
- This repo's peer engine type: `src/types.ts`
- This repo's engine dispatch: `src/runner.ts`
- This repo's MCP surface: `src/mcpServer.ts`
- Web search result for the upstream repo overview: `https://github.com/smtg-ai/claude-squad`
