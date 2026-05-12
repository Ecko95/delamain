# Architecture

The autopilot is **one Python script driven by cron** plus a **per-roadmap state directory**. There is no daemon, no event bus, no service manager. Everything is filesystem-based and recoverable from the state file alone.

## Components

```
<state-dir>/
├── config.json          # Roadmap-level config (repo path, forbidden paths, verification commands)
├── handoffs.tsv         # Ordered list of slices: slice_id, title, merge_branch, model, yolo
├── peer-prompt.template # Substituted with {{SLICE_ID}}, {{SLICE_TITLE}}, {{MERGE_BRANCH}}
├── state.json           # Live chain state — current slice, current peer, halt status, history
├── notify.sh            # Telegram sendMessage wrapper
├── secrets/
│   └── telegram.env     # TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (chmod 600)
├── logs/
│   ├── supervisor-YYYY-MM-DD.log  # One file per UTC date
│   └── cron.log                    # cron stdout/stderr capture
└── .supervisor.lock     # flock file; held during a tick
```

The `supervisor.py` script lives **once** in the skill (`scripts/supervisor.py`); each roadmap state dir has only its data and a copy of `notify.sh` plus the prompt template.

## Tick flow

Every cron firing (`*/5 * * * *`) does this:

```
1. flock(.supervisor.lock, NB)        # skip if another tick is running
2. load config.json + state.json
3. if state.halted: log + exit 0
4. git fetch origin
5. read origin/<default_branch> HEAD SHA → new_main_sha
6. codex-peers status <current_peer_id> → peer JSON
7. dispatch on peer.status:
     starting/working    → no-op
     waiting             → notify(blocker), mark event
     done + pushed       → auto_review_and_merge(); if False, halt
     done + failed       → notify(merge-failed), halt
     failed/frozen/killed → notify, halt
8. if new_main_sha != last_main_sha:
     if detect_merged():               # ancestry, then patch-id cherry
       notify(merged), event_mark
       spawn_next()                     # advance current_slice_index, spawn peer
     else:
       advance last_main_sha (unrelated commit)
9. release lock, exit 0
```

The single tick runs in 1–3 minutes when an auto-review fires, ~1 second otherwise.

## Why cron, not a daemon

- **Survives reboot, session end, process kill.** Cron will keep firing.
- **Bounded blast radius.** Each tick is a fresh process; nothing accumulates in memory.
- **Trivially observable.** `tail -f logs/supervisor-*.log` is the dashboard.
- **No supervision.** No "what supervises the supervisor" question.

## Why halt-on-failure

The chain runs autonomously across hours/days and pushes to `origin`. If any gate fails — verification, forbidden touch, gh, preflight — the safest action is **stop and notify**. The user inspects, fixes (often by checking out the peer worktree), and clears halt by hand. Resume = `state.halted = false`. The supervisor never auto-recovers.

## Why patch-id cherry for merge detection

`gh pr merge --rebase` and `--squash` rewrite the peer's pushed SHA into a new commit on the default branch. Direct ancestry checks fail. `git cherry origin/<default> <pushed_sha>` uses patch-id (a hash of the diff) and reports `-` for commits that are equivalent to something already in the default branch. This catches all three merge strategies (`merge`, `rebase`, `squash`) and tolerates `--delete-branch`.

## Idempotency

Every Telegram notification is keyed by an event ID, e.g. `merged:<peer_id>`. Before sending, the supervisor checks `state.notified_events`; after sending, it appends. A crash mid-tick means the next tick will re-evaluate the same state and either resume from where it was, or skip already-notified events. State writes are atomic via `tmp + replace`.

## Single-instance lock

`flock` on `.supervisor.lock` ensures two cron ticks never overlap. If a 3-minute auto-review is in flight when the next 5-minute tick fires, the new tick logs "another tick is running; skipping" and exits.
