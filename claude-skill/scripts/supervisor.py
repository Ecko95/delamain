#!/usr/bin/env python3
"""codex-peers-autopilot supervisor.

One tick of the autopilot loop:
- Inspect the active codex-peer for the current slice
- Notify Telegram on state transitions (idempotent via notified_events)
- Auto-review on done+pushed (lint/typecheck/tests/build + forbidden-touch diff)
- Auto-PR + rebase-merge via gh; cleanup peer worktree
- Detect merge via direct ancestry, then patch-id cherry fallback
- Spawn next slice from handoffs.tsv

Usage:
  CODEX_PEERS_AUTOPILOT_DIR=/path/to/state-dir supervisor.py

Designed for cron */5 * * * *. Halt-on-failure: any error sets
state.halted = true with a halted_reason and exits 0.
"""
from __future__ import annotations

import csv
import datetime as dt
import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path

# State directory is required and resolved from env so the same script can
# drive multiple roadmaps from different state dirs.
DIR_ENV = "CODEX_PEERS_AUTOPILOT_DIR"
state_dir_str = os.environ.get(DIR_ENV)
if not state_dir_str:
    sys.stderr.write(f"{DIR_ENV} must be set to a state directory\n")
    sys.exit(2)

STATE_DIR = Path(state_dir_str).resolve()
CONFIG = STATE_DIR / "config.json"
STATE = STATE_DIR / "state.json"
HANDOFFS = STATE_DIR / "handoffs.tsv"
TEMPLATE = STATE_DIR / "peer-prompt.template"
NOTIFY = STATE_DIR / "notify.sh"
LOG_DIR = STATE_DIR / "logs"
LOCK = STATE_DIR / ".supervisor.lock"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    line = f"{now_iso()} [autopilot] {msg}\n"
    with (LOG_DIR / f"supervisor-{today}.log").open("a") as f:
        f.write(line)


def notify(text: str) -> None:
    if not NOTIFY.exists():
        log(f"notify.sh missing at {NOTIFY}; skipping notification")
        return
    try:
        subprocess.run(
            [str(NOTIFY)], input=text, text=True, check=True, timeout=20
        )
    except subprocess.SubprocessError as e:
        log(f"notify failed: {e}")


def load_config() -> dict:
    if not CONFIG.exists():
        sys.stderr.write(f"missing config.json at {CONFIG}\n")
        sys.exit(2)
    return json.loads(CONFIG.read_text())


def load_state() -> dict:
    return json.loads(STATE.read_text())


def save_state(state: dict) -> None:
    tmp = STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    tmp.replace(STATE)


def event_seen(state: dict, ev: str) -> bool:
    return ev in state.get("notified_events", [])


def event_mark(state: dict, ev: str) -> None:
    events = state.setdefault("notified_events", [])
    if ev not in events:
        events.append(ev)


def history_set_outcome(state: dict, peer_id: str, outcome: str) -> None:
    for entry in state.get("history", []):
        if entry.get("peer_id") == peer_id:
            entry["outcome"] = outcome


def history_append(state: dict, slice_id: str, peer_id: str, merge_branch: str) -> None:
    state.setdefault("history", []).append({
        "slice_id": slice_id,
        "peer_id": peer_id,
        "merge_branch": merge_branch,
        "spawned_at": now_iso(),
        "outcome": None,
    })


def read_handoffs() -> list[dict]:
    rows = []
    with HANDOFFS.open() as f:
        for row in csv.reader(f, delimiter="\t"):
            if not row or row[0].startswith("#"):
                continue
            rows.append({
                "slice_id": row[0],
                "title": row[1],
                "merge_branch": row[2],
                "model": row[3],
                "yolo": row[4] == "1",
            })
    return rows


def halt(state: dict, reason: str) -> None:
    state["halted"] = True
    state["halted_reason"] = reason
    save_state(state)


def run(cmd: list[str], cwd: str | None = None, timeout: int | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd, cwd=cwd, text=True, capture_output=True, timeout=timeout,
    )


def peer_status_json(peer_id: str) -> dict | None:
    proc = run(["codex-peers", "status", peer_id])
    if proc.returncode != 0:
        log(f"codex-peers status failed: {proc.stderr.strip()}")
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        log(f"codex-peers status returned non-JSON: {proc.stdout[:200]}")
        return None


def peer_log_tail(peer_id: str, lines: int = 30) -> str:
    proc = run(["codex-peers", "log", peer_id, str(lines)])
    return proc.stdout.strip() if proc.returncode == 0 else ""


def auto_review_and_merge(
    config: dict,
    state: dict,
    slice_id: str,
    peer_id: str,
    merge_branch: str,
    peer: dict,
) -> bool:
    """Mechanical review in the peer's worktree; merge PR if green.

    Returns True if PR was merged. Returns False if any gate failed (state
    is halted by this point).
    """
    repo_path = config["repo_path"]
    wt = peer.get("worktreePath")
    if not wt or not Path(wt).exists():
        halt(state, f"{slice_id}: peer worktree missing at {wt}")
        notify(
            f"<b>🛑 {slice_id} auto-review failed — worktree missing</b>\n"
            f"Peer: {peer_id}\nExpected: {wt}"
        )
        return False

    log(f"auto-review starting in {wt}")

    # --- Forbidden-touch diff check ------------------------------------------
    diff_proc = run(
        ["git", "diff", "--name-only", f"origin/{config.get('default_branch','main')}..HEAD"],
        cwd=wt,
    )
    if diff_proc.returncode != 0:
        halt(state, f"{slice_id}: diff failed: {diff_proc.stderr.strip()}")
        notify(f"<b>🛑 {slice_id} auto-review: git diff failed</b>")
        return False

    changed = [f for f in diff_proc.stdout.strip().splitlines() if f]
    forbidden_paths = config.get("forbidden_paths", [])
    exception_slices = config.get("forbidden_exception_slices", [])

    forbidden_hits = []
    if slice_id not in exception_slices:
        for f in changed:
            for p in forbidden_paths:
                if f == p or f.startswith(p):
                    forbidden_hits.append(f)
                    break

    if forbidden_hits:
        halt(state, f"{slice_id}: peer touched forbidden paths: {forbidden_hits}")
        notify(
            f"<b>🛑 {slice_id} auto-review: peer touched forbidden paths — chain halted</b>\n\n"
            + "\n".join(f"• {f}" for f in forbidden_hits[:10])
            + f"\n\nWorktree: {wt}"
        )
        return False

    # --- Verification suite --------------------------------------------------
    failures = []
    for entry in config.get("verification_commands", []):
        label = entry["label"]
        cmd = entry["cmd"]
        log(f"auto-review running: {label}")
        proc = run(cmd, cwd=wt, timeout=entry.get("timeout_seconds", 600))
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout)[-1500:]
            failures.append((label, tail))

    if failures:
        first_label, first_tail = failures[0]
        halt(state, f"{slice_id}: verification failed at {first_label}")
        body = (
            f"<b>🛑 {slice_id} auto-review: verification failed — chain halted</b>\n\n"
            + "\n".join(f"• {label}: FAIL" for label, _ in failures)
            + f"\n\nFirst failure tail ({first_label}):\n<pre>{first_tail[-1500:]}</pre>"
        )
        notify(body)
        return False

    log(f"auto-review green for {slice_id}")

    # --- Open + merge PR ------------------------------------------------------
    pr_title = f"{config.get('pr_title_prefix','chore')}({slice_id.lower()}): {slice_id}"
    pr_body = (
        f"## Summary\n\n"
        f"Auto-merge of **{slice_id}** by codex-peers-autopilot after green review.\n\n"
        f"- Peer: `{peer_id}`\n"
        f"- Branch: `{merge_branch}`\n"
        f"- Worktree: `{wt}`\n\n"
        f"## Verification\n\n"
        + "\n".join(f"- {entry['label']} — passed" for entry in config.get("verification_commands", []))
        + "\n\nForbidden-touch diff check: no edits outside slice scope.\n\n"
        + "🤖 Auto-reviewed and merged by codex-peers-autopilot"
    )

    create = run(
        ["gh", "pr", "create", "--base", config.get("default_branch", "main"),
         "--head", merge_branch, "--title", pr_title, "--body", pr_body],
        cwd=repo_path, timeout=60,
    )
    if create.returncode != 0:
        halt(state, f"{slice_id}: gh pr create failed")
        notify(
            f"<b>🛑 {slice_id} auto-merge: gh pr create failed — chain halted</b>\n"
            f"<pre>{(create.stderr or create.stdout)[-1500:]}</pre>"
        )
        return False
    pr_url = create.stdout.strip().splitlines()[-1]

    merge_strategy = config.get("merge_strategy", "rebase")
    merge_cmd = ["gh", "pr", "merge", pr_url, f"--{merge_strategy}"]
    if config.get("delete_branch_on_merge", True):
        merge_cmd.append("--delete-branch")
    merge = run(merge_cmd, cwd=repo_path, timeout=120)
    if merge.returncode != 0:
        halt(state, f"{slice_id}: gh pr merge failed")
        notify(
            f"<b>🛑 {slice_id} auto-merge: gh pr merge failed — chain halted</b>\n"
            f"PR: {pr_url}\n"
            f"<pre>{(merge.stderr or merge.stdout)[-1500:]}</pre>"
        )
        return False

    notify(
        f"<b>✅ {slice_id} auto-reviewed + merged</b>\n\n"
        f"Peer: {peer_id}\n"
        f"PR: {pr_url}\n\n"
        f"All checks green; {merge_strategy}-merged to "
        f"{config.get('default_branch','main')}, branch deleted.\n"
        f"Next slice will spawn on the following tick."
    )

    # Cleanup peer worktree (frees disk; harmless if it fails).
    cleanup = run(["codex-peers", "cleanup", peer_id], timeout=30)
    if cleanup.returncode != 0:
        log(f"cleanup non-fatal warn: {cleanup.stderr.strip()[:200]}")

    return True


def spawn_next(config: dict, state: dict, new_main_sha: str) -> None:
    """Advance to next slice and spawn a peer."""
    handoffs = read_handoffs()
    next_index = state["current_slice_index"] + 1

    if next_index >= len(handoffs):
        # Idempotent completion: notify once, halt the chain so cron stops
        # re-detecting the final merge on every subsequent tick.
        if "roadmap-complete" not in state.get("notified_events", []):
            notify(
                "<b>🏁 roadmap complete</b>\n\n"
                f"All {len(handoffs)} slices landed in "
                f"{config.get('default_branch','main')}. Chain finished."
            )
            event_mark(state, "roadmap-complete")
        state["last_origin_main_sha"] = new_main_sha
        state["halted"] = True
        state["halted_reason"] = "roadmap complete"
        save_state(state)
        log("chain complete; halted to stop further ticks")
        return

    nxt = handoffs[next_index]
    repo_path = config["repo_path"]
    default_branch = config.get("default_branch", "main")
    log(f"spawning next: {nxt['slice_id']} -> {nxt['merge_branch']}")

    # Pre-create or fast-forward feature branch on origin from origin/<default>.
    create_branch = run(
        ["git", "push", "origin",
         f"origin/{default_branch}:refs/heads/{nxt['merge_branch']}"],
        cwd=repo_path,
    )
    if create_branch.returncode != 0:
        ff = run(
            ["git", "push", "origin",
             f"+origin/{default_branch}:refs/heads/{nxt['merge_branch']}"],
            cwd=repo_path,
        )
        if ff.returncode != 0:
            halt(state, f"could not prepare {nxt['merge_branch']}")
            notify(
                f"<b>🛑 could not prepare {nxt['slice_id']} branch — chain halted</b>\n"
                f"<pre>{ff.stderr.strip()[-1000:]}</pre>"
            )
            return

    # Preflight.
    pre = run(
        ["codex-peers", "preflight", "--repo", repo_path,
         "--start-ref", f"origin/{default_branch}",
         "--merge-branch", nxt["merge_branch"]],
    )
    if pre.returncode != 0:
        halt(state, f"preflight failed for {nxt['slice_id']}")
        notify(
            f"<b>🛑 preflight failed for {nxt['slice_id']} — chain halted</b>\n"
            f"<pre>{pre.stderr.strip()[-1000:]}</pre>"
        )
        return

    # Build prompt from template.
    prompt = TEMPLATE.read_text()
    prompt = prompt.replace("{{SLICE_ID}}", nxt["slice_id"])
    prompt = prompt.replace("{{SLICE_TITLE}}", nxt["title"])
    prompt = prompt.replace("{{MERGE_BRANCH}}", nxt["merge_branch"])

    cmd = [
        "codex-peers", "spawn",
        "--repo", repo_path,
        "--start-ref", f"origin/{default_branch}",
        "--merge-branch", nxt["merge_branch"],
        "--model", nxt["model"],
        "--name", config.get("peer_name_prefix", "peer") + "-" + nxt["slice_id"].lower(),
        "--prompt", prompt,
    ]
    if nxt["yolo"]:
        cmd.append("--yolo")

    spawn_proc = run(cmd, timeout=120)
    if spawn_proc.returncode != 0:
        halt(state, f"spawn failed for {nxt['slice_id']}")
        notify(
            f"<b>🛑 spawn failed for {nxt['slice_id']} — chain halted</b>\n"
            f"<pre>{(spawn_proc.stderr or spawn_proc.stdout)[-1000:]}</pre>"
        )
        return

    try:
        spawn_data = json.loads(spawn_proc.stdout)
    except json.JSONDecodeError:
        halt(state, f"spawn returned non-JSON for {nxt['slice_id']}")
        notify(f"<b>🛑 spawn returned non-JSON for {nxt['slice_id']} — chain halted</b>")
        return

    next_peer_id = spawn_data["id"]

    state["current_slice_id"] = nxt["slice_id"]
    state["current_slice_index"] = next_index
    state["current_peer_id"] = next_peer_id
    state["current_merge_branch"] = nxt["merge_branch"]
    state["current_pushed_sha"] = ""
    state["last_origin_main_sha"] = new_main_sha
    history_append(state, nxt["slice_id"], next_peer_id, nxt["merge_branch"])
    event_mark(state, f"spawn:{next_peer_id}")
    save_state(state)

    notify(
        f"<b>🚀 spawned {nxt['slice_id']} — {nxt['title']}</b>\n\n"
        f"Peer: {next_peer_id}\n"
        f"Branch: origin/{nxt['merge_branch']}\n"
        f"Model: {nxt['model']}"
    )


def detect_merged(config: dict, state: dict, merge_branch: str) -> bool:
    """Has the current slice's branch landed in the default branch?

    Tries direct ancestry first; falls back to patch-id cherry which catches
    rebase + squash merges that rewrote the original SHA.
    """
    repo_path = config["repo_path"]
    default_branch = config.get("default_branch", "main")

    run(["git", "fetch", "--quiet", "origin", merge_branch], cwd=repo_path)
    direct = run(
        ["git", "merge-base", "--is-ancestor",
         f"origin/{merge_branch}", f"origin/{default_branch}"],
        cwd=repo_path,
    )
    if direct.returncode == 0:
        return True

    pushed_sha = state.get("current_pushed_sha", "")
    if not pushed_sha:
        return False

    anc = run(
        ["git", "merge-base", "--is-ancestor",
         pushed_sha, f"origin/{default_branch}"],
        cwd=repo_path,
    )
    if anc.returncode == 0:
        log(f"detected merge via pushed-SHA ancestry: {pushed_sha}")
        return True

    cherry = run(["git", "cherry", f"origin/{default_branch}", pushed_sha], cwd=repo_path)
    if cherry.returncode == 0 and cherry.stdout.strip().startswith("-"):
        log(f"detected merge via patch-id cherry: {cherry.stdout.strip().splitlines()[0]}")
        return True

    return False


def main() -> int:
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    # Single-instance lock.
    lock_fp = LOCK.open("w")
    try:
        fcntl.flock(lock_fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another supervisor tick is running; skipping")
        return 0

    config = load_config()

    # cron's PATH is minimal; restore configured paths.
    extra_paths = config.get("path_prefix", [])
    if extra_paths:
        os.environ["PATH"] = ":".join(extra_paths + [os.environ.get("PATH", "")])

    repo_path = config["repo_path"]
    default_branch = config.get("default_branch", "main")

    state = load_state()
    if state.get("halted"):
        log(f"halted ({state.get('halted_reason')}); exiting")
        return 0

    slice_id = state["current_slice_id"]
    peer_id = state["current_peer_id"]
    merge_branch = state["current_merge_branch"]
    last_main_sha = state["last_origin_main_sha"]

    log(f"tick: slice={slice_id} peer={peer_id} merge_branch={merge_branch}")

    fetch = run(["git", "fetch", "--quiet", "origin"], cwd=repo_path)
    if fetch.returncode != 0:
        log(f"git fetch failed (non-fatal): {fetch.stderr.strip()}")

    head = run(["git", "rev-parse", f"origin/{default_branch}"], cwd=repo_path)
    if head.returncode != 0:
        log("could not read default branch HEAD; bailing")
        return 0
    new_main_sha = head.stdout.strip()

    peer = peer_status_json(peer_id) if peer_id else None
    if peer is None:
        log("no peer info; will retry next tick")
        return 0

    pstatus = peer.get("status")
    pintegration = peer.get("integrationStatus")
    plast_event = peer.get("lastEvent")
    log(f"peer status={pstatus} integration={pintegration} lastEvent={plast_event}")

    if pstatus in ("starting", "working"):
        pass

    elif pstatus == "waiting":
        ev = f"waiting:{peer_id}:{plast_event}"
        if not event_seen(state, ev):
            tail = peer_log_tail(peer_id, 30)
            notify(
                f"<b>⚠️ {slice_id} peer is WAITING</b>\n\n"
                f"Peer: {peer_id}\n"
                f"Branch: {merge_branch}\n"
                f"Resume with: codex-peers resume {peer_id} --prompt '...'\n\n"
                f"Recent log:\n{tail[-3000:]}"
            )
            event_mark(state, ev)
            save_state(state)

    elif pstatus == "done":
        if pintegration == "pushed":
            ev = f"auto-merged:{peer_id}"
            if not event_seen(state, ev):
                history_set_outcome(state, peer_id, "pushed")
                wt_path = peer.get("worktreePath")
                if wt_path:
                    rs = run(["git", "-C", wt_path, "rev-parse", "HEAD"])
                    if rs.returncode == 0:
                        state["current_pushed_sha"] = rs.stdout.strip()
                save_state(state)

                notify(
                    f"<b>🔍 {slice_id} peer complete — running auto-review</b>\n\n"
                    f"Peer: {peer_id}\nBranch: origin/{merge_branch}"
                )

                if auto_review_and_merge(config, state, slice_id, peer_id, merge_branch, peer):
                    event_mark(state, ev)
                    save_state(state)
                else:
                    return 0
        elif pintegration == "failed":
            ev = f"merge-failed:{peer_id}"
            if not event_seen(state, ev):
                history_set_outcome(state, peer_id, "merge-failed")
                halt(state, f"{slice_id} peer {peer_id} merge-failed")
                notify(
                    f"<b>🛑 {slice_id} merge-failed — chain halted</b>\n\n"
                    f"Peer: {peer_id}\n"
                    f"Worktree: {peer.get('worktreePath')}"
                )
                event_mark(state, ev)
                save_state(state)
                return 0

    elif pstatus in ("failed", "frozen", "killed"):
        ev = f"{pstatus}:{peer_id}"
        if not event_seen(state, ev):
            history_set_outcome(state, peer_id, pstatus)
            halt(state, f"{slice_id} peer {peer_id} {pstatus}")
            tail = peer_log_tail(peer_id, 30)
            notify(
                f"<b>🛑 {slice_id} peer {pstatus.upper()} — chain halted</b>\n\n"
                f"Peer: {peer_id}\nBranch: {merge_branch}\n\n"
                f"Recent log:\n{tail[-3000:]}"
            )
            event_mark(state, ev)
            save_state(state)
        return 0

    else:
        log(f"unknown peer status: {pstatus}")

    # PR merge detection — advance chain.
    if new_main_sha != last_main_sha:
        log(f"origin/{default_branch} advanced: {last_main_sha} -> {new_main_sha}")
        if detect_merged(config, state, merge_branch):
            ev = f"merged:{peer_id}"
            if not event_seen(state, ev):
                history_set_outcome(state, peer_id, "merged")
                head_msg = run(
                    ["git", "log", "-1", "--pretty=format:%h %s",
                     f"origin/{default_branch}"],
                    cwd=repo_path,
                )
                notify(
                    f"<b>🎉 {slice_id} merged to {default_branch}</b>\n\n"
                    f"Branch: {merge_branch}\n"
                    f"{default_branch}: {head_msg.stdout.strip()}"
                )
                event_mark(state, ev)
                save_state(state)
            spawn_next(config, state, new_main_sha)
        else:
            log(f"main advanced but {merge_branch} not in main; treating as unrelated commit")
            state["last_origin_main_sha"] = new_main_sha
            save_state(state)

    log("tick complete")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"FATAL: {exc!r}")
        try:
            notify(f"<b>autopilot FATAL</b>\n{exc!r}")
        except Exception:
            pass
        raise
