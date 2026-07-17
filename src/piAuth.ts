// src/piAuth.ts
//
// SP2 — cheap, non-interactive auth preflight for a pi peer, modeled on
// codexAuth.ts. Pi resolves credentials from EITHER a provider env var OR an
// entry in `<agentDir>/auth.json` (written by `pi /login`, OAuth or API key).
// There is no CODEX_HOME-style secret per invocation, but the agent dir is
// relocatable via PI_CODING_AGENT_DIR (pi's CODEX_HOME analog).
//
// Env-var map verified against @mariozechner/pi-ai@…/dist/env-api-keys.js
// (installed with pi 0.73.1). Providers not listed here (openai-codex, and
// Claude Pro/Max) are OAuth-only — auth.json is the only source.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PiAuthPreflight = { ok: true; warning?: string } | { ok: false; error: string };

/** Provider id → env var(s), in precedence order. OAuth-only providers absent. */
const PROVIDER_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "azure-openai-responses": ["AZURE_OPENAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
  zai: ["ZAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
};

/** The agent dir pi reads (auth.json/sessions/settings). PI_CODING_AGENT_DIR wins. */
export function defaultPiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * The provider id embedded in a `provider/model` id (pi's --model format).
 * Bare model ids (no slash) have no provider prefix → returns undefined.
 */
export function providerOf(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/**
 * Non-interactive check that pi has usable credentials for `provider`. Never
 * networks — reads the env vars and auth.json only, so a missing key surfaces
 * as an actionable message rather than an opaque `pi` exit 1.
 */
export function checkPiAuth(
  provider: string | undefined,
  opts: { agentDir?: string; env?: NodeJS.ProcessEnv } = {},
): PiAuthPreflight {
  const env = opts.env ?? process.env;
  const agentDir = opts.agentDir ?? defaultPiAgentDir(env);
  if (!provider) {
    return {
      ok: false,
      error:
        "pi peer requires an explicit --model <provider/id> (e.g. openai-codex/gpt-5.4-mini). The runtime default is nondeterministic.",
    };
  }

  // 1) provider env var present?
  for (const name of PROVIDER_ENV[provider] ?? []) {
    if (env[name]) return { ok: true };
  }

  // 2) auth.json entry for the provider?
  const authPath = join(agentDir, "auth.json");
  let raw: string;
  try {
    raw = readFileSync(authPath, "utf8");
  } catch {
    return { ok: false, error: authError(provider, agentDir, `no auth file at ${authPath}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: authError(provider, agentDir, `auth file ${authPath} is not valid JSON`) };
  }
  const entry = (parsed as Record<string, unknown> | null)?.[provider];
  if (entry && typeof entry === "object") {
    return { ok: true };
  }
  return { ok: false, error: authError(provider, agentDir, `no auth.json entry for provider "${provider}"`) };
}

function authError(provider: string, agentDir: string, why: string): string {
  const envHint = (PROVIDER_ENV[provider] ?? [])[0];
  const remedy = envHint
    ? `Fix: run \`pi /login\` (writes ${agentDir}/auth.json) or \`export ${envHint}=…\`.`
    : `Fix: run \`pi /login\` and select "${provider}" (OAuth-only; no env var). Writes ${agentDir}/auth.json.`;
  return `pi peer auth missing for provider "${provider}": ${why}. ${remedy}`;
}

/**
 * pi's auth-failure signatures — the no-key stderr string AND the
 * expired/invalidated-OAuth errorMessage that arrives inside the JSON stream
 * (stopReason:error). Both mean the operator must re-authenticate.
 */
export function isPiAuthFailure(output: string): boolean {
  return (
    /no api key found for/i.test(output) ||
    /run \/login/i.test(output) ||
    /invalidated oauth token/i.test(output) ||
    /(oauth|access|refresh)\s*token.*(expired|invalid)/i.test(output)
  );
}
