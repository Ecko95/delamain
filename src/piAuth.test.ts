import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPiAuth, providerOf } from "./piAuth.js";

describe("providerOf", () => {
  it("extracts the provider prefix from a provider/model id", () => {
    expect(providerOf("openai-codex/gpt-5.4-mini")).toBe("openai-codex");
    expect(providerOf("anthropic/claude-opus-4-7")).toBe("anthropic");
    expect(providerOf("gpt-5.4")).toBeUndefined(); // bare id, no provider
    expect(providerOf(undefined)).toBeUndefined();
  });
});

describe("checkPiAuth", () => {
  const emptyDir = () => mkdtempSync(join(tmpdir(), "pi-auth-"));

  it("requires an explicit provider (from the model)", () => {
    const r = checkPiAuth(undefined, { agentDir: emptyDir(), env: {} });
    expect(r.ok).toBe(false);
  });

  it("passes when the provider env var is set", () => {
    expect(checkPiAuth("anthropic", { agentDir: emptyDir(), env: { ANTHROPIC_API_KEY: "sk-x" } }).ok).toBe(true);
    expect(checkPiAuth("anthropic", { agentDir: emptyDir(), env: { ANTHROPIC_OAUTH_TOKEN: "t" } }).ok).toBe(true);
    expect(checkPiAuth("openai", { agentDir: emptyDir(), env: { OPENAI_API_KEY: "sk-x" } }).ok).toBe(true);
    // google uses GEMINI_API_KEY, not GOOGLE_*
    expect(checkPiAuth("google", { agentDir: emptyDir(), env: { GEMINI_API_KEY: "x" } }).ok).toBe(true);
    expect(checkPiAuth("google", { agentDir: emptyDir(), env: { GOOGLE_API_KEY: "x" } }).ok).toBe(false);
  });

  it("passes when auth.json has an entry (OAuth-only providers like openai-codex)", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth" } }));
    expect(checkPiAuth("openai-codex", { agentDir: dir, env: {} }).ok).toBe(true);
  });

  it("fails loudly with an actionable remedy when neither env nor auth.json has the provider", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key" } }));
    const r = checkPiAuth("openai-codex", { agentDir: dir, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pi \/login/);
  });

  it("fails when there is no auth.json and no env var", () => {
    const r = checkPiAuth("anthropic", { agentDir: emptyDir(), env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ANTHROPIC_API_KEY|pi \/login/);
  });
});
