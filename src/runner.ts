import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { checkCodexPeerAuth, codexAuthReloginMessage, isCodexAuthRefreshFailure } from "./codexAuth.js";
import { parseCodexJsonLine, trim } from "./codexEvents.js";
import { readPeerContext, contextTransitionNote, type CodexContextLevel } from "./codexContext.js";
import { runCursorPeer } from "./cursorRunner.js";
import { pushPeerBranch } from "./git.js";
import { deliverPending } from "./peerManager.js";
import { initialTerminalResponseState, updateTerminalResponseState } from "./lifecycle.js";
import { updatePeer } from "./store.js";

type RunnerArgs = {
  peerId: string;
  repo: string;
  promptFile: string;
  logPath: string;
  resumeThread?: string;
  mergeBranch?: string;
  model?: string;
  sandbox?: string;
  yolo?: boolean;
  engine?: "codex" | "cursor";
  cursorCloud?: boolean;
  cursorApproveMcps?: boolean;
  cursorForce?: boolean;
  reasoningEffort?: string;
  developerInstructions?: string;
  codexConfig?: string[];
  /** false (--no-integrate) skips the on-done branch push (workflow leaves). */
  integrate?: boolean;
};

export async function runPeer(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.engine === "cursor") {
    await runCursorPeer({
      peerId: args.peerId,
      repo: args.repo,
      promptFile: args.promptFile,
      logPath: args.logPath,
      resumeThread: args.resumeThread,
      mergeBranch: args.mergeBranch,
      model: args.model,
      cloud: args.cursorCloud,
      approveMcps: args.cursorApproveMcps,
      force: args.cursorForce,
    });
    return;
  }

  mkdirSync(dirname(args.logPath), { recursive: true });
  const log = createWriteStream(args.logPath, { flags: "a" });
  const prompt = wrapPrompt(readFileSync(args.promptFile, "utf8"), args.repo, args.mergeBranch, Boolean(args.resumeThread));
  const codexArgs = buildCodexArgs(args);

  append(log, `[delamain] starting: codex ${codexArgs.join(" ")}\n`);
  updatePeer(args.peerId, (peer) => ({
    ...peer,
    status: "working",
    runnerPid: process.pid,
    updatedAt: now(),
    lastHeartbeatAt: now(),
    lastEvent: "runner started",
  }));

  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".delamain", "peer-codex-home");

  const preflight = checkCodexPeerAuth(codexHome);
  if (!preflight.ok) {
    append(log, `[delamain] ${preflight.error}\n`);
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      status: "failed",
      error: preflight.error,
      finishedAt: now(),
      updatedAt: now(),
      lastEvent: "codex auth preflight failed",
    }));
    log.end();
    return;
  }
  if (preflight.warning) {
    append(log, `[delamain] WARNING ${preflight.warning}\n`);
  }

  const child = spawn("codex", codexArgs, {
    cwd: args.repo,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  updatePeer(args.peerId, (peer) => ({
    ...peer,
    codexPid: child.pid,
    updatedAt: now(),
    lastEvent: `codex started pid=${child.pid ?? "unknown"}`,
  }));

  child.stdin.write(prompt);
  child.stdin.end();

  // S2: context-window budget tracking. threadId (== session UUID) is captured
  // from stdout; once known we poll the session JSONL on each heartbeat.
  let latestThreadId: string | undefined = args.resumeThread;
  let lastContextLevel: CodexContextLevel | undefined;
  let compactionNoticed = false;

  const heartbeat = setInterval(() => {
    const ctx = readPeerContext(latestThreadId, { home: codexHome });
    const note = ctx ? contextTransitionNote(ctx, lastContextLevel, compactionNoticed) : undefined;
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      lastHeartbeatAt: now(),
      updatedAt: now(),
      contextPercent: ctx ? ctx.usedPercent : peer.contextPercent,
      contextLevel: ctx ? ctx.level : peer.contextLevel,
      compacted: ctx ? ctx.compacted : peer.compacted,
      lastEvent: note || peer.lastEvent,
    }));
    if (ctx) {
      lastContextLevel = ctx.level;
      if (ctx.compacted) {
        compactionNoticed = true;
      }
    }
  }, 5000);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let stderrText = "";
  let collectedText = "";
  let terminalResponse = initialTerminalResponseState();

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      handleStdoutLine(line);
      index = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    stderrText = trim(`${stderrText}${chunk}`, 20_000);
    let index = stderrBuffer.indexOf("\n");
    while (index !== -1) {
      const line = stderrBuffer.slice(0, index);
      stderrBuffer = stderrBuffer.slice(index + 1);
      append(log, `[stderr] ${line}\n`);
      updatePeer(args.peerId, (peer) => ({
        ...peer,
        updatedAt: now(),
        lastEvent: trim(line, 180),
      }));
      index = stderrBuffer.indexOf("\n");
    }
  });

  child.on("error", (error) => {
    append(log, `[delamain] failed to start codex: ${error.message}\n`);
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      status: "failed",
      error: error.message,
      finishedAt: now(),
      updatedAt: now(),
      lastEvent: "codex failed to start",
    }));
  });

  await new Promise<void>((resolve) => {
    child.on("close", (code, signal) => {
      clearInterval(heartbeat);
      if (stdoutBuffer.trim()) {
        handleStdoutLine(stdoutBuffer.trimEnd());
      }
      if (stderrBuffer.trim()) {
        append(log, `[stderr] ${stderrBuffer.trimEnd()}\n`);
      }

      const finalQuestion = terminalResponse.waitingQuestion;
      let status: "waiting" | "done" | "failed" = finalQuestion ? "waiting" : code === 0 ? "done" : "failed";
      let integrationStatus: "skipped" | "pushed" | "failed" | undefined;
      let integrationError: string | undefined;
      let integrationEvent: string | undefined;

      if (status === "done" && args.integrate === false) {
        integrationStatus = "skipped";
        integrationEvent = `codex exited code=${code}; branch push skipped (integrate:false)`;
        append(log, `[delamain] integrate:false — leaving peer branch local (no push)\n`);
      } else if (status === "done") {
        updatePeer(args.peerId, (peer) => ({
          ...peer,
          updatedAt: now(),
          lastHeartbeatAt: now(),
          lastEvent: `codex exited code=${code}; pushing peer branch`,
        }));
        append(log, `[delamain] pushing peer branch to origin (base origin/${args.mergeBranch || "main"})\n`);
        try {
          const pushed = pushPeerBranch(args.repo, args.peerId, args.mergeBranch || "main");
          integrationStatus = pushed.status;
          integrationEvent = pushed.message;
          append(log, `[delamain] ${pushed.message}\n`);
        } catch (error) {
          status = "failed";
          integrationStatus = "failed";
          integrationError = error instanceof Error ? error.message : String(error);
          integrationEvent = "branch push failed";
          append(log, `[delamain] branch push failed: ${integrationError}\n`);
        }
      }

      const authRemedy =
        status === "failed" && isCodexAuthRefreshFailure(`${stderrText}\n${collectedText}`)
          ? codexAuthReloginMessage(codexHome)
          : undefined;
      if (authRemedy) {
        append(log, `[delamain] ${authRemedy}\n`);
      }

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
        error: authRemedy || integrationError || peer.error,
        integrationStatus: integrationStatus || peer.integrationStatus,
        integrationError,
        lastEvent: authRemedy
          ? "codex auth refresh failed — re-login required"
          : status === "waiting"
            ? "waiting for orchestrator input"
            : integrationEvent || `codex exited code=${code}`,
      }));
      append(log, `[delamain] exited code=${code} signal=${signal ?? ""}\n`);

      // Turn-boundary inbox delivery: now that the final status is committed,
      // drain any queued peer→peer messages into the peer's next turn. No-op
      // unless status is a boundary (waiting/idle/done) with undelivered mail.
      // Best-effort — must never break the exit path.
      try {
        const delivery = deliverPending(args.peerId);
        if (delivery.delivered > 0) {
          append(log, `[delamain] delivered ${delivery.delivered} inbox message(s) via resume\n`);
        }
      } catch (error) {
        append(log, `[delamain] inbox delivery failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }

      log.end();
      resolve();
    });
  });

  function handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    append(log, `${line}\n`);
    const parsed = parseCodexJsonLine(line);
    if (parsed.threadId) {
      latestThreadId = parsed.threadId;
    }
    if (parsed.text) {
      collectedText = trim(`${collectedText}\n${parsed.text}`, 20_000);
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

/**
 * Shared `-c model_reasoning_effort=...` logic for both the long-running peer
 * runner (this file) and the one-shot GSD phase runner (gsdRunner.ts).
 * Explicit `effort` wins for any model; absent `effort` preserves the legacy
 * default (`high` unless model is gpt-5.5, which already reasons well at
 * its own default).
 */
export function reasoningEffortArgs(model: string | undefined, effort: string | undefined): string[] {
  if (effort) {
    return ["-c", `model_reasoning_effort="${effort}"`];
  }
  if (model && model !== "gpt-5.5") {
    return ["-c", 'model_reasoning_effort="high"'];
  }
  return [];
}

export function buildCodexArgs(args: RunnerArgs): string[] {
  const codexArgs = args.resumeThread
    ? ["exec", "resume", "--json", args.resumeThread, "-"]
    : ["exec", "--json", "-C", args.repo, "-"];

  if (args.model) {
    codexArgs.splice(2, 0, "--model", args.model);
  }
  if (!args.resumeThread && args.sandbox) {
    codexArgs.splice(2, 0, "--sandbox", args.sandbox);
  }
  if (args.yolo) {
    codexArgs.splice(2, 0, "--dangerously-bypass-approvals-and-sandbox");
  }

  const promptArgIndex = codexArgs.lastIndexOf("-");
  const configArgs = ["--disable", "hooks", ...reasoningEffortArgs(args.model, args.reasoningEffort)];
  if (args.developerInstructions) {
    // JSON.stringify produces a valid TOML basic string (same quoting/escaping rules).
    configArgs.push("-c", `developer_instructions=${JSON.stringify(args.developerInstructions)}`);
  }
  // ponytail: format-validated passthrough, no key allowlist — the MCP caller
  // is already a trusted supervisor that can pass --yolo. Upgrade to an
  // allowlist if an untrusted caller ever gets a path to this option.
  if (args.codexConfig) {
    for (const pair of args.codexConfig) {
      configArgs.push("-c", pair);
    }
  }
  codexArgs.splice(promptArgIndex, 0, ...configArgs);
  return codexArgs;
}

function wrapPrompt(prompt: string, repo: string, mergeBranch: string | undefined, isResume: boolean): string {
  const header = isResume ? "Continue the existing Codex peer task." : "You are a supervised Codex peer worker.";
  const branch = mergeBranch ? `origin/${mergeBranch}` : "the target branch";
  return `${header}

Repository: ${repo}

Operational contract:
- Work only on the requested task unless the orchestrator explicitly broadens scope.
- You are running in an isolated linked worktree. Do not push, merge ${branch}, or switch branches; the peer supervisor integrates successful work into ${branch}.
- When running verification or tests, prefer \`npx <tool>\` (e.g. \`npx tsc --noEmit\`, \`npx vitest run\`) over \`npm run <script>\`; \`npm run\` can silently resolve a wrong global binary when \`node_modules\` is absent or incomplete in a fresh worktree.
- Scope test runs to directories containing changed files (e.g. \`npx vitest run src/foo/\`) rather than running the full suite unless specifically required.
- If you need input from the orchestrator and cannot proceed, make your final answer start with:
  CODEX_PEERS_STATUS: WAITING
  QUESTION: <one concise question>
- Otherwise finish with a concise report of what you did, changed, and verified.

Task:
${prompt}
`;
}

export function parseArgs(argv: string[]): RunnerArgs {
  const values: Record<string, string | boolean> = {};
  const codexConfig: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    // developer-instructions/codex-config values are free-form and may
    // legitimately start with "--" (e.g. a bullet list); always consume the
    // next token as their value instead of treating it as a new flag.
    const alwaysConsumesNext = key === "developer-instructions" || key === "codex-config";
    if (!next || (!alwaysConsumesNext && next.startsWith("--"))) {
      values[key] = true;
    } else {
      if (key === "codex-config") {
        codexConfig.push(next);
      } else {
        values[key] = next;
      }
      i += 1;
    }
  }

  const peerId = stringValue(values, "peer-id");
  const repo = stringValue(values, "repo");
  const promptFile = stringValue(values, "prompt-file");
  const logPath = stringValue(values, "log-path");
  if (!peerId || !repo || !promptFile || !logPath) {
    throw new Error("run-peer requires --peer-id, --repo, --prompt-file, and --log-path");
  }
  const engineRaw = stringValue(values, "engine");
  const engine: "codex" | "cursor" | undefined =
    engineRaw === "cursor" ? "cursor" : engineRaw === "codex" ? "codex" : undefined;
  return {
    peerId,
    repo,
    promptFile,
    logPath,
    resumeThread: stringValue(values, "resume-thread"),
    mergeBranch: stringValue(values, "merge-branch") || stringValue(values, "target-branch"),
    model: stringValue(values, "model"),
    sandbox: stringValue(values, "sandbox"),
    yolo: Boolean(values.yolo),
    engine,
    cursorCloud: Boolean(values["cursor-cloud"]),
    cursorApproveMcps: Boolean(values["cursor-approve-mcps"]),
    cursorForce: Boolean(values["no-cursor-force"]) ? false : undefined,
    reasoningEffort: stringValue(values, "reasoning-effort"),
    developerInstructions: stringValue(values, "developer-instructions"),
    codexConfig: codexConfig.length > 0 ? codexConfig : undefined,
    integrate: values["no-integrate"] ? false : undefined,
  };
}

function stringValue(values: Record<string, string | boolean>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function append(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text);
}

function now(): string {
  return new Date().toISOString();
}
