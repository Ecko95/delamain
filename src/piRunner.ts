// src/piRunner.ts
//
// SP2 — pi engine adapter, mirroring cursorRunner.ts. Drives
// `pi --print --mode json` as a leaf peer, line-buffers the NDJSON event
// stream through parsePiJsonLine, and applies delamain's peer lifecycle
// (status transitions, waiting/resume protocol, integrate:false, branch push).
//
// pi specifics (see docs/superpowers/specs/2026-07-17-sp2-pi-ndjson-step0.md):
//  - prompt is a POSITIONAL arg (print mode reads the initial message);
//  - session/thread id is captured from the first NDJSON `session` line and
//    stored as threadId; resume is `--session <id>` with a stable per-peer
//    --session-dir (never --resume/--continue);
//  - JSON mode exits 0 even on MODEL failure, so a final assistant message with
//    stopReason error/aborted is treated as failed regardless of exit code;
//  - auth is a provider env var OR ~/.pi/agent/auth.json (pi /login) — checked
//    up front by checkPiAuth (NOT codex's CODEX_HOME preflight).

import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { trim } from "./codexEvents.js";
import { parsePiJsonLine } from "./piEvents.js";
import { checkPiAuth, isPiAuthFailure, providerOf } from "./piAuth.js";
import { pushPeerBranch } from "./git.js";
import { initialTerminalResponseState, updateTerminalResponseState } from "./lifecycle.js";
import { peersHome } from "./paths.js";
import { updatePeer } from "./store.js";
import type { PiRunOptions } from "./types.js";

export type PiRunnerArgs = {
  peerId: string;
  repo: string;
  promptFile: string;
  logPath: string;
  resumeThread?: string;
  mergeBranch?: string;
  model?: string;
  integrate?: boolean;
  piOptions?: PiRunOptions;
};

/** Stable per-peer session dir so `--session <id>` resolves on resume. */
export function piSessionDir(peerId: string): string {
  return join(peersHome(), "pi-sessions", peerId);
}

export function buildPiArgs(args: PiRunnerArgs, prompt: string, sessionDir: string): string[] {
  const cliArgs = ["--print", "--mode", "json"];
  if (args.model) cliArgs.push("--model", args.model);
  if (args.piOptions?.tools?.length) cliArgs.push("--tools", args.piOptions.tools.join(","));
  if (args.piOptions?.thinking) cliArgs.push("--thinking", args.piOptions.thinking);
  cliArgs.push("--session-dir", sessionDir);
  if (args.resumeThread) cliArgs.push("--session", args.resumeThread);
  cliArgs.push(prompt); // MUST be last (print mode reads the positional message)
  return cliArgs;
}

export async function runPiPeer(args: PiRunnerArgs): Promise<void> {
  mkdirSync(dirname(args.logPath), { recursive: true });
  const log = createWriteStream(args.logPath, { flags: "a" });
  const prompt = wrapPiPrompt(readFileSync(args.promptFile, "utf8"), args.repo, args.mergeBranch, Boolean(args.resumeThread));
  const bin = process.env.PI_BIN || "pi";
  const sessionDir = piSessionDir(args.peerId);
  mkdirSync(sessionDir, { recursive: true });
  const cliArgs = buildPiArgs(args, prompt, sessionDir);

  append(log, `[delamain][pi] starting: ${bin} ${redactArgs(cliArgs).join(" ")}\n`);
  updatePeer(args.peerId, (peer) => ({
    ...peer,
    engine: "pi",
    status: "working",
    runnerPid: process.pid,
    updatedAt: now(),
    lastHeartbeatAt: now(),
    lastEvent: "pi runner started",
  }));

  // Auth preflight: fail loud with an actionable remedy instead of an opaque
  // `pi` exit 1. Provider comes from the `provider/id` model.
  const provider = providerOf(args.model);
  const preflight = checkPiAuth(provider);
  if (!preflight.ok) {
    append(log, `[delamain][pi] ${preflight.error}\n`);
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      status: "failed",
      error: preflight.error,
      finishedAt: now(),
      updatedAt: now(),
      lastEvent: "pi auth preflight failed",
    }));
    log.end();
    return;
  }

  const child = spawn(bin, cliArgs, {
    cwd: args.repo,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  updatePeer(args.peerId, (peer) => ({
    ...peer,
    enginePid: child.pid,
    updatedAt: now(),
    lastEvent: `pi started pid=${child.pid ?? "unknown"}`,
  }));

  const heartbeat = setInterval(() => {
    updatePeer(args.peerId, (peer) => ({ ...peer, lastHeartbeatAt: now(), updatedAt: now() }));
  }, 5000);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stderrText = "";
  let collectedText = "";
  let modelFailed = false;
  let modelErrorMessage = "";
  let terminalResponse = initialTerminalResponseState();

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      handleStdoutLine(line);
      index = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    stderrText = trim(`${stderrText}${chunk}`, 20_000);
    let index = stderrBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stderrBuffer.slice(0, index);
      stderrBuffer = stderrBuffer.slice(index + 1);
      append(log, `[stderr] ${line}\n`);
      updatePeer(args.peerId, (peer) => ({ ...peer, updatedAt: now(), lastEvent: trim(line, 180) }));
      index = stderrBuffer.indexOf("\n");
    }
  });

  child.on("error", (error) => {
    append(log, `[delamain][pi] failed to start pi: ${error.message}\n`);
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      status: "failed",
      error: error.message,
      finishedAt: now(),
      updatedAt: now(),
      lastEvent: "pi failed to start",
    }));
  });

  await new Promise<void>((resolve) => {
    child.on("close", (code, signal) => {
      clearInterval(heartbeat);
      if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer.trimEnd());
      if (stderrBuffer.trim()) append(log, `[stderr] ${stderrBuffer.trimEnd()}\n`);

      const finalQuestion = terminalResponse.waitingQuestion;
      // JSON mode exits 0 even on model failure, so also fail on modelFailed.
      let status: "waiting" | "done" | "failed" = finalQuestion
        ? "waiting"
        : code === 0 && !modelFailed
          ? "done"
          : "failed";
      let integrationStatus: "skipped" | "pushed" | "failed" | undefined;
      let integrationError: string | undefined;
      let integrationEvent: string | undefined;

      if (status === "done" && args.integrate === false) {
        integrationStatus = "skipped";
        integrationEvent = `pi exited code=${code}; branch push skipped (integrate:false)`;
        append(log, `[delamain][pi] integrate:false — leaving peer branch local (no push)\n`);
      } else if (status === "done") {
        updatePeer(args.peerId, (peer) => ({
          ...peer,
          updatedAt: now(),
          lastHeartbeatAt: now(),
          lastEvent: `pi exited code=${code}; pushing peer branch`,
        }));
        append(log, `[delamain][pi] pushing peer branch to origin (base origin/${args.mergeBranch || "main"})\n`);
        try {
          const pushed = pushPeerBranch(args.repo, args.peerId, args.mergeBranch || "main");
          integrationStatus = pushed.status;
          integrationEvent = pushed.message;
          append(log, `[delamain][pi] ${pushed.message}\n`);
        } catch (error) {
          status = "failed";
          integrationStatus = "failed";
          integrationError = error instanceof Error ? error.message : String(error);
          integrationEvent = "branch push failed";
          append(log, `[delamain][pi] branch push failed: ${integrationError}\n`);
        }
      }

      // pi surfaces auth failures either on stderr ("No API key found") or,
      // for an expired/invalidated OAuth token, inside the JSON stream's
      // errorMessage (stopReason:error). Turn both into a re-login remedy.
      const authSignal = `${stderrText}\n${modelErrorMessage}`;
      const authRemedy =
        status === "failed" && isPiAuthFailure(authSignal)
          ? `pi peer auth failed (provider ${provider ?? "?"}): ${trim(modelErrorMessage || stderrText, 200)} — run \`pi /login\`.`
          : undefined;
      const modelErr = status === "failed" && !authRemedy && modelErrorMessage ? trim(modelErrorMessage, 300) : undefined;
      if (authRemedy) append(log, `[delamain][pi] ${authRemedy}\n`);

      updatePeer(args.peerId, (peer) => ({
        ...peer,
        status: peer.status === "killed" ? "killed" : status,
        exitCode: code,
        signal,
        question: finalQuestion,
        finalResult: trim(collectedText, 6000),
        finishedAt: now(),
        lastHeartbeatAt: now(),
        updatedAt: now(),
        error: authRemedy || modelErr || integrationError || peer.error,
        integrationStatus: integrationStatus || peer.integrationStatus,
        integrationError,
        lastEvent:
          status === "waiting"
            ? "waiting for orchestrator input"
            : authRemedy
              ? "pi auth failed — re-login required"
              : integrationEvent || `pi exited code=${code}${modelFailed ? " (model error)" : ""}`,
      }));
      append(log, `[delamain][pi] exited code=${code} signal=${signal ?? ""}\n`);
      log.end();
      resolve();
    });
  });

  function handleStdoutLine(line: string): void {
    if (!line.trim()) return;
    append(log, `${line}\n`);
    const parsed = parsePiJsonLine(line);
    if (parsed.text) {
      collectedText = trim(`${collectedText}${collectedText ? "\n" : ""}${parsed.text}`, 20_000);
    }
    // Detect model failure (JSON mode exits 0 regardless) on the final message,
    // and capture pi's errorMessage so the peer's error is actionable instead
    // of an opaque "code=0 (model error)".
    if (parsed.type === "message_end") {
      try {
        const raw = JSON.parse(line) as { message?: { stopReason?: string; errorMessage?: string } };
        if (raw.message?.stopReason === "error" || raw.message?.stopReason === "aborted") {
          modelFailed = true;
          if (typeof raw.message.errorMessage === "string" && raw.message.errorMessage) {
            modelErrorMessage = raw.message.errorMessage;
          }
        }
      } catch {
        /* ignore */
      }
    }
    terminalResponse = updateTerminalResponseState(terminalResponse, parsed);
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      threadId: parsed.threadId || peer.threadId,
      status:
        peer.status === "killed"
          ? "killed"
          : parsed.waitingQuestion
            ? "waiting"
            : parsed.isAgentMessage && peer.status === "waiting"
              ? "working"
              : peer.status === "starting"
                ? "working"
                : peer.status,
      question: parsed.isAgentMessage ? parsed.waitingQuestion : peer.question,
      updatedAt: now(),
      lastHeartbeatAt: now(),
      lastEvent: parsed.label ? trim(parsed.label, 180) : peer.lastEvent,
    }));
  }
}

function wrapPiPrompt(prompt: string, repo: string, mergeBranch: string | undefined, isResume: boolean): string {
  const header = isResume ? "Continue the existing Pi peer task." : "You are a supervised Pi peer worker.";
  const branch = mergeBranch ? `origin/${mergeBranch}` : "the target branch";
  return `${header}

Repository: ${repo}

Operational contract:
- Work only on the requested task unless the orchestrator explicitly broadens scope.
- You are running in an isolated linked git worktree. Do not push, merge ${branch}, or switch branches; the peer supervisor integrates successful work into ${branch}.
- When running verification or tests, prefer \`npx <tool>\` (e.g. \`npx tsc --noEmit\`, \`npx vitest run\`) over \`npm run <script>\`.
- Scope test runs to directories containing changed files rather than running the full suite unless required.
- If you need input from the orchestrator and cannot proceed, make your final answer start with:
  CODEX_PEERS_STATUS: WAITING
  QUESTION: <one concise question>
- Otherwise finish with a concise report of what you did, changed, and verified.

Task:
${prompt}
`;
}

function redactArgs(args: string[]): string[] {
  if (args.length === 0) return args;
  const head = args.slice(0, -1);
  const tail = args[args.length - 1];
  return [...head, trim(tail, 200)];
}

function append(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text);
}

function now(): string {
  return new Date().toISOString();
}
