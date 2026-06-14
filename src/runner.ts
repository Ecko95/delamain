import { createWriteStream, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseCodexJsonLine, trim } from "./codexEvents.js";
import { runCursorPeer } from "./cursorRunner.js";
import { pushPeerBranch } from "./git.js";
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
  confine?: boolean;
  egress?: string;
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

  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".delamain", "peer-codex-home");
  const confineBin = args.confine ? (process.env.GITS_CONFINE_BIN ?? "gits-confine.sh") : "";
  const toolchain = confineBin ? resolveCodexToolchain() : { rootDir: "", binDir: "" };
  const { command, args: spawnArgv } = buildConfinedCommand({
    confineBin,
    worktree: args.repo,
    codexHome,
    egress: args.egress ?? "host",
    label: args.peerId,
    toolchainRootDir: toolchain.rootDir,
    toolchainBinDir: toolchain.binDir,
    engineCmd: "codex",
    engineArgs: codexArgs,
  });

  append(log, `[delamain] starting: ${command} ${spawnArgv.join(" ")}\n`);
  updatePeer(args.peerId, (peer) => ({
    ...peer,
    status: "working",
    runnerPid: process.pid,
    updatedAt: now(),
    lastHeartbeatAt: now(),
    lastEvent: "runner started",
  }));

  const child = spawn(command, spawnArgv, {
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

  const heartbeat = setInterval(() => {
    updatePeer(args.peerId, (peer) => ({
      ...peer,
      lastHeartbeatAt: now(),
      updatedAt: now(),
    }));
  }, 5000);

  let stdoutBuffer = "";
  let stderrBuffer = "";
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

      if (status === "done") {
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
        error: integrationError || peer.error,
        integrationStatus: integrationStatus || peer.integrationStatus,
        integrationError,
        lastEvent: status === "waiting" ? "waiting for orchestrator input" : integrationEvent || `codex exited code=${code}`,
      }));
      append(log, `[delamain] exited code=${code} signal=${signal ?? ""}\n`);
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

export interface ConfinedSpawnInput {
  readonly confineBin: string; // GITS_CONFINE_BIN, or "" to run unconfined
  readonly worktree: string;
  readonly codexHome: string;
  readonly egress: string; // "host" | "off"
  readonly label: string;
  readonly toolchainRootDir: string; // node version root to --ro bind (contains node + codex)
  readonly toolchainBinDir: string; // node version bin dir to put first on PATH
  readonly engineCmd: string; // "codex"
  readonly engineArgs: ReadonlyArray<string>;
}

/**
 * Pure builder for the confined spawn argv. When `confineBin` is empty, returns the
 * raw engine command (unconfined passthrough). Otherwise wraps it in
 * `gits-confine.sh --profile peer … -- <engine> …` per the validated H0b recipe:
 * worktree-only jail, single provider credential, codex's own node toolchain bound
 * read-only and put first on PATH.
 */
export function buildConfinedCommand(input: ConfinedSpawnInput): { command: string; args: string[] } {
  if (!input.confineBin) {
    return { command: input.engineCmd, args: [...input.engineArgs] };
  }
  const pre = [
    "--worktree", input.worktree,
    "--profile", "peer",
    "--label", input.label,
    "--egress", input.egress,
    "--ro", input.toolchainRootDir,
    "--cred", `${input.codexHome}/auth.json`,
    "--cred", `${input.codexHome}/config.toml`,
    "--setenv", `CODEX_HOME=${input.codexHome}`,
    "--setenv", `PATH=${input.toolchainBinDir}:/usr/local/bin:/usr/bin:/bin`,
  ];
  return { command: input.confineBin, args: [...pre, "--", input.engineCmd, ...input.engineArgs] };
}

/**
 * Resolve the node version root + bin dir that own the `codex` executable, so the jail can
 * bind them. codex is usually ~/.local/bin/codex -> ~/.nvm/versions/node/v<V>/bin/codex.
 * Uses `bash -lc` so the LOGIN PATH (which has codex) is consulted, matching how delamain
 * finds `codex` at runtime.
 */
export function resolveCodexToolchain(): { rootDir: string; binDir: string } {
  let p = execFileSync("bash", ["-lc", "command -v codex"], { encoding: "utf8" }).trim();
  // follow a single symlink hop if present (the ~/.local/bin shim → the real nvm bin/codex)
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      p = resolve(dirname(p), readlinkSync(p));
    }
  } catch {
    /* ignore */
  }
  const binDir = dirname(p); // .../v<V>/bin  (holds both node and codex)
  const rootDir = dirname(binDir); // .../v<V>      (the version root to --ro bind)
  return { rootDir, binDir };
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
  codexArgs.splice(promptArgIndex, 0, "-c", "features.codex_hooks=false");
  if (args.model && args.model !== "gpt-5.5") {
    codexArgs.splice(promptArgIndex + 2, 0, "-c", 'model_reasoning_effort="high"');
  }
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

function parseArgs(argv: string[]): RunnerArgs {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      values[key] = true;
    } else {
      values[key] = next;
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
    confine: Boolean(values.confine),
    egress: stringValue(values, "egress"),
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
