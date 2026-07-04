import { readFileSync } from "node:fs";
import { join } from "node:path";

// ChatGPT-mode OAuth refresh tokens rotate on use and the refresh window is
// ~30 days. Warn before the cliff so the operator can re-login proactively
// instead of discovering it mid-batch as an opaque runner crash.
const STALE_REFRESH_DAYS = 25;
const STALE_REFRESH_MS = STALE_REFRESH_DAYS * 24 * 60 * 60 * 1000;

export type CodexAuthPreflight =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

/**
 * Cheap, non-interactive validation of a peer's Codex `auth.json` before we
 * spawn `codex exec`. Never runs anything interactive or networked — it only
 * reads/parses the file and inspects `last_refresh` staleness so a stale
 * ChatGPT-mode token surfaces as an actionable message, not a crash.
 *
 * Returns ok:false only for hard problems the operator must fix (missing or
 * unparseable auth, or a chatgpt session with no token). Staleness is a soft
 * warning — the token may still refresh — so it rides along on ok:true.
 */
export function checkCodexPeerAuth(codexHome: string, nowMs = Date.now()): CodexAuthPreflight {
  const authPath = join(codexHome, "auth.json");
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    return { ok: false, error: `Codex auth missing at ${authPath}. ${relogin(codexHome)}` };
  }

  let auth: unknown;
  try {
    auth = JSON.parse(raw);
  } catch {
    return { ok: false, error: `Codex auth at ${authPath} is not valid JSON. ${relogin(codexHome)}` };
  }

  const record = (auth ?? {}) as {
    auth_mode?: unknown;
    OPENAI_API_KEY?: unknown;
    tokens?: { access_token?: unknown; refresh_token?: unknown } | null;
    last_refresh?: unknown;
  };

  // API-key mode (OPENAI_API_KEY present, no OAuth refresh) doesn't rotate —
  // nothing to stale-check. Only chatgpt/OAuth mode has the reuse hazard.
  if (record.auth_mode !== "chatgpt") {
    return { ok: true };
  }

  const tokens = record.tokens ?? undefined;
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) {
    return { ok: false, error: `Codex auth at ${authPath} has auth_mode "chatgpt" but no access token. ${relogin(codexHome)}` };
  }

  const lastRefreshMs = typeof record.last_refresh === "string" ? Date.parse(record.last_refresh) : NaN;
  if (Number.isFinite(lastRefreshMs) && nowMs - lastRefreshMs > STALE_REFRESH_MS) {
    const ageDays = Math.floor((nowMs - lastRefreshMs) / (24 * 60 * 60 * 1000));
    return {
      ok: true,
      warning: `Codex peer auth last refreshed ${ageDays}d ago (>${STALE_REFRESH_DAYS}d) at ${authPath}; the ChatGPT refresh token may be stale. If peers fail to start, run: ${reloginCommand(codexHome)}`,
    };
  }

  return { ok: true };
}

/**
 * Codex's OAuth refresh failure ("refresh token already used" / expired token)
 * surfaces on the child's stdout/stderr and otherwise dies as an opaque
 * `codex exited code=1`. Detect that signature so the runner can replace the
 * opaque exit with the exact re-login remedy.
 */
export function isCodexAuthRefreshFailure(output: string): boolean {
  const text = output.toLowerCase();
  return (
    text.includes("refresh_token_reused") ||
    text.includes("refresh token was already used") ||
    text.includes("access token could not be refreshed") ||
    text.includes("please log out and sign in again") ||
    (text.includes("refresh") && text.includes("token") && text.includes("expired"))
  );
}

/** Actionable message naming the exact remedy for a stale/reused peer token. */
export function codexAuthReloginMessage(codexHome: string): string {
  return `Codex peer auth failed: the ChatGPT OAuth token in ${codexHome} is stale or was already used (single-use refresh token). Fix: ${reloginCommand(codexHome)}`;
}

function reloginCommand(codexHome: string): string {
  return `CODEX_HOME=${codexHome} codex login`;
}

function relogin(codexHome: string): string {
  return `Fix: ${reloginCommand(codexHome)}`;
}
