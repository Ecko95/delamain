#!/usr/bin/env python3
"""codex-peers-autopilot Telegram responder.

Polls the bot's getUpdates endpoint with a persistent offset, dispatches
recognized commands, replies via sendMessage. Designed to run from cron at
*/1 * * * * (one tick per minute).

Recognized commands (chat_id must match TELEGRAM_CHAT_ID):
  /help                  — list commands
  /status                — current slice, peer state, halt state, history summary
  /halt [reason]         — halt the chain
  /resume                — clear halt
  /log [N]               — last N supervisor log lines (default 30)
  /peers                 — codex-peers list filtered to this roadmap's repo
  /kill <peer-id>        — codex-peers kill <peer-id>
  /cleanup <peer-id>     — codex-peers cleanup <peer-id>

Reads creds from $CODEX_PEERS_AUTOPILOT_DIR/secrets/telegram.env.
Writes offset to <state-dir>/.responder-offset.
Logs to <state-dir>/logs/responder-YYYY-MM-DD.log.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DIR_ENV = "CODEX_PEERS_AUTOPILOT_DIR"
state_dir_str = os.environ.get(DIR_ENV)
if not state_dir_str:
    sys.stderr.write(f"{DIR_ENV} must be set to a state directory\n")
    sys.exit(2)

STATE_DIR = Path(state_dir_str).resolve()
CONFIG = STATE_DIR / "config.json"
STATE = STATE_DIR / "state.json"
SECRETS_PRIMARY = STATE_DIR / "secrets" / "telegram.env"
SECRETS_FALLBACK = Path.home() / ".codex-peers" / "secrets" / "telegram.env"
OFFSET_FILE = STATE_DIR / ".responder-offset"
LOG_DIR = STATE_DIR / "logs"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()
    with (LOG_DIR / f"responder-{today}.log").open("a") as f:
        f.write(f"{now_iso()} [responder] {msg}\n")


def load_creds() -> tuple[str, str]:
    """Read TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from telegram.env."""
    secrets_path = SECRETS_PRIMARY if SECRETS_PRIMARY.exists() else SECRETS_FALLBACK
    if not secrets_path.exists():
        sys.stderr.write(f"missing telegram.env (tried {SECRETS_PRIMARY} and {SECRETS_FALLBACK})\n")
        sys.exit(2)
    creds = {}
    for line in secrets_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        creds[k.strip()] = v.strip()
    token = creds.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = creds.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        sys.stderr.write("missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID\n")
        sys.exit(2)
    return token, chat_id


def telegram_api(token: str, method: str, params: dict) -> dict:
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log(f"telegram_api error {method}: {e}")
        return {"ok": False, "error": str(e)}


def send(token: str, chat_id: str, text: str) -> None:
    text = text[:4000]
    res = telegram_api(token, "sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    })
    if not res.get("ok"):
        log(f"send failed: {res}")


def read_offset() -> int:
    if OFFSET_FILE.exists():
        try:
            return int(OFFSET_FILE.read_text().strip())
        except ValueError:
            return 0
    return 0


def write_offset(offset: int) -> None:
    OFFSET_FILE.write_text(str(offset))


def load_state() -> dict:
    return json.loads(STATE.read_text())


def save_state(state: dict) -> None:
    tmp = STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2) + "\n")
    tmp.replace(STATE)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    kw.setdefault("text", True)
    kw.setdefault("capture_output", True)
    kw.setdefault("timeout", 30)
    return subprocess.run(cmd, **kw)


# ---- Command handlers --------------------------------------------------------

HELP_TEXT = """<b>codex-peers-autopilot commands</b>

/status            — current slice, peer state, halt, history summary
/halt [reason]     — halt the chain
/resume            — clear halt
/log [N]           — last N supervisor log lines (default 30, max 200)
/peers             — list active codex-peers for this repo
/kill &lt;peer-id&gt;    — terminate a peer
/cleanup &lt;peer-id&gt; — remove a finished peer's worktree
/help              — this message"""


def cmd_help() -> str:
    return HELP_TEXT


def cmd_status(config: dict) -> str:
    s = load_state()
    handoffs_path = STATE_DIR / "handoffs.tsv"
    total_slices = sum(
        1 for line in handoffs_path.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ) if handoffs_path.exists() else 0

    outcomes = {}
    for h in s.get("history", []):
        o = h.get("outcome") or "in-flight"
        outcomes[o] = outcomes.get(o, 0) + 1
    outcome_str = ", ".join(f"{k}={v}" for k, v in sorted(outcomes.items())) or "(none yet)"

    halted_line = ""
    if s.get("halted"):
        halted_line = f"\n🛑 <b>HALTED</b>: {s.get('halted_reason')}"

    peer_state = "(unknown)"
    pid = s.get("current_peer_id")
    if pid:
        proc = run(["codex-peers", "status", pid])
        if proc.returncode == 0:
            try:
                p = json.loads(proc.stdout)
                peer_state = f"{p.get('status')}/{p.get('integrationStatus')} — {p.get('lastEvent','')[:80]}"
            except json.JSONDecodeError:
                pass

    return (
        f"<b>📊 autopilot status</b>{halted_line}\n\n"
        f"slice: {s.get('current_slice_id')} ({s.get('current_slice_index',0)+1}/{total_slices})\n"
        f"peer: <code>{pid or '-'}</code>\n"
        f"peer state: {peer_state}\n"
        f"branch: <code>{s.get('current_merge_branch')}</code>\n"
        f"history: {outcome_str}\n"
        f"main sha: <code>{s.get('last_origin_main_sha','')[:10]}</code>"
    )


def cmd_halt(reason: str) -> str:
    s = load_state()
    if s.get("halted"):
        return f"already halted ({s.get('halted_reason')})"
    s["halted"] = True
    s["halted_reason"] = reason or "user via Telegram"
    save_state(s)
    return f"🛑 chain halted: {s['halted_reason']}"


def cmd_resume() -> str:
    s = load_state()
    if not s.get("halted"):
        return "chain is already running (not halted)"
    prev_reason = s.get("halted_reason") or ""
    s["halted"] = False
    s["halted_reason"] = None
    save_state(s)
    return f"🔁 chain resumed (was: {prev_reason})"


def cmd_log(n: int = 30) -> str:
    n = max(1, min(n, 200))
    today = dt.date.today().isoformat()
    log_file = LOG_DIR / f"supervisor-{today}.log"
    if not log_file.exists():
        return f"(no supervisor log for {today})"
    lines = log_file.read_text().splitlines()[-n:]
    body = "\n".join(lines)
    return f"<pre>{body[-3500:]}</pre>"


def cmd_peers(config: dict) -> str:
    proc = run(["codex-peers", "list"])
    if proc.returncode != 0:
        return f"codex-peers list failed: {proc.stderr.strip()[:200]}"
    try:
        peers = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return "codex-peers list returned non-JSON"
    repo_path = config["repo_path"]
    relevant = [p for p in peers if p.get("sourceRepo") == repo_path]
    if not relevant:
        return f"(no peers for {repo_path})"
    lines = [
        f"<code>{p['id']}</code> {p.get('status','')}/{p.get('integrationStatus','')} {p.get('mergeBranch','')}"
        for p in relevant[:20]
    ]
    return "<b>peers</b>\n" + "\n".join(lines)


def cmd_kill(peer_id: str) -> str:
    if not peer_id:
        return "usage: /kill <peer-id>"
    proc = run(["codex-peers", "kill", peer_id])
    if proc.returncode == 0:
        return f"killed {peer_id}"
    return f"kill failed: {proc.stderr.strip()[:300]}"


def cmd_cleanup(peer_id: str) -> str:
    if not peer_id:
        return "usage: /cleanup <peer-id>"
    proc = run(["codex-peers", "cleanup", peer_id])
    if proc.returncode == 0:
        return f"cleaned up {peer_id}"
    return f"cleanup failed: {proc.stderr.strip()[:300]}"


# ---- Dispatch ----------------------------------------------------------------

def dispatch(text: str, config: dict) -> str | None:
    text = (text or "").strip()
    if not text.startswith("/"):
        return None  # ignore non-command messages

    parts = text.split(maxsplit=1)
    cmd = parts[0].lower().split("@")[0]  # strip @botname suffix if present
    arg = parts[1] if len(parts) > 1 else ""

    if cmd == "/help" or cmd == "/start":
        return cmd_help()
    if cmd == "/status":
        return cmd_status(config)
    if cmd == "/halt":
        return cmd_halt(arg)
    if cmd == "/resume":
        return cmd_resume()
    if cmd == "/log":
        try:
            n = int(arg) if arg else 30
        except ValueError:
            n = 30
        return cmd_log(n)
    if cmd == "/peers":
        return cmd_peers(config)
    if cmd == "/kill":
        return cmd_kill(arg.strip())
    if cmd == "/cleanup":
        return cmd_cleanup(arg.strip())

    return f"unknown command: {cmd}\ntry /help"


# ---- Main loop ---------------------------------------------------------------

def main() -> int:
    if not CONFIG.exists() or not STATE.exists():
        sys.stderr.write(f"missing config.json or state.json in {STATE_DIR}\n")
        return 2

    extra_paths = json.loads(CONFIG.read_text()).get("path_prefix", [])
    if extra_paths:
        os.environ["PATH"] = ":".join(extra_paths + [os.environ.get("PATH", "")])

    config = json.loads(CONFIG.read_text())
    token, chat_id = load_creds()
    offset = read_offset()

    # Long-poll up to 10s for new messages, so the responder can return quickly
    # when there's traffic and not waste a full minute when there isn't.
    res = telegram_api(token, "getUpdates", {
        "offset": offset,
        "timeout": "10",
        "allowed_updates": json.dumps(["message"]),
    })
    if not res.get("ok"):
        log(f"getUpdates failed: {res}")
        return 0

    for upd in res.get("result", []):
        offset = max(offset, upd["update_id"] + 1)
        msg = upd.get("message")
        if not msg:
            continue
        msg_chat_id = str(msg.get("chat", {}).get("id", ""))
        text = msg.get("text", "")
        if msg_chat_id != str(chat_id):
            log(f"ignoring message from foreign chat_id {msg_chat_id}")
            continue
        if not text:
            continue
        log(f"received: {text[:80]}")
        try:
            reply = dispatch(text, config)
        except Exception as e:
            log(f"dispatch error: {e!r}")
            reply = f"⚠️ command error: {e!r}"
        if reply is not None:
            send(token, chat_id, reply)
            log(f"replied to {text[:40]} ({len(reply)} chars)")

    write_offset(offset)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        log(f"FATAL: {exc!r}")
        raise
