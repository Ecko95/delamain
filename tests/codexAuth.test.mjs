import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCodexPeerAuth, codexAuthReloginMessage, isCodexAuthRefreshFailure } from "../dist/codexAuth.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-04T00:00:00.000Z");

function homeWithAuth(auth) {
  const home = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
  writeFileSync(join(home, "auth.json"), JSON.stringify(auth));
  return home;
}

test("preflight fails when auth.json is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-auth-missing-"));
  const result = checkCodexPeerAuth(home, NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing/);
  assert.match(result.error, new RegExp(`CODEX_HOME=${home} codex login`));
});

test("preflight fails when auth.json is not valid JSON", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-auth-bad-"));
  writeFileSync(join(home, "auth.json"), "{not json");
  const result = checkCodexPeerAuth(home, NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test("preflight fails when chatgpt mode has no access token", () => {
  const home = homeWithAuth({ auth_mode: "chatgpt", tokens: {} });
  const result = checkCodexPeerAuth(home, NOW);
  assert.equal(result.ok, false);
  assert.match(result.error, /no access token/);
});

test("preflight passes clean for a fresh chatgpt token", () => {
  const home = homeWithAuth({
    auth_mode: "chatgpt",
    tokens: { access_token: "tok", refresh_token: "r" },
    last_refresh: new Date(NOW - 2 * DAY).toISOString(),
  });
  const result = checkCodexPeerAuth(home, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined);
});

test("preflight warns (but passes) when last_refresh is older than 25 days", () => {
  const home = homeWithAuth({
    auth_mode: "chatgpt",
    tokens: { access_token: "tok", refresh_token: "r" },
    last_refresh: new Date(NOW - 40 * DAY).toISOString(),
  });
  const result = checkCodexPeerAuth(home, NOW);
  assert.equal(result.ok, true);
  assert.match(result.warning, /40d ago/);
  assert.match(result.warning, new RegExp(`CODEX_HOME=${home} codex login`));
});

test("preflight ignores staleness for api-key mode", () => {
  const home = homeWithAuth({
    auth_mode: "apikey",
    OPENAI_API_KEY: "sk-x",
    last_refresh: new Date(NOW - 400 * DAY).toISOString(),
  });
  const result = checkCodexPeerAuth(home, NOW);
  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined);
});

test("isCodexAuthRefreshFailure matches the real reuse error", () => {
  assert.equal(
    isCodexAuthRefreshFailure(
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
    ),
    true,
  );
  assert.equal(isCodexAuthRefreshFailure("error: refresh_token_reused"), true);
  assert.equal(isCodexAuthRefreshFailure("codex exited with a normal task result"), false);
});

test("codexAuthReloginMessage names the exact remedy", () => {
  const msg = codexAuthReloginMessage("/home/x/.delamain/peer-codex-home");
  assert.match(msg, /CODEX_HOME=\/home\/x\/\.delamain\/peer-codex-home codex login/);
});
