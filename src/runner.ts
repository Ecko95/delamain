import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { parseCodexJsonLine, trim } from "./codexEvents.js";
import { integratePeerWorktree } from "./git.js";
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
};

export async function runPeer(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  mkdirSync(dirname(args.logPath), { recursive: true });
  const log = createWriteStream(args.logPath, { flags: "a" });
  const prompt = wrapPrompt(readFileSync(args.promptFile, "utf8"), args.repo, args.mergeBranch, Boolean(args.resumeThread));
  const codexArgs = buildCodexArgs(args);

  append(log, `[codex-peers] starting: codex ${codexArgs.join(" ")}\n`);
  updatePeer(args.peerId, (peer) => ({
    ...peer,
    status: "working",
    runnerPid: process.pid,
    updatedAt: now(),
    lastHeartbeatAt: now(),
    lastEvent: "runner started",
  }));

  const child = spawn("codex", codexArgs, {
    cwd: args.repo,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
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
    append(log, `[codex-peers] failed to start codex: ${error.message}\n`);
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
          lastEvent: `codex exited code=${code}; integrating peer worktree`,
        }));
        append(log, `[codex-peers] integrating peer worktree with origin/${args.mergeBranch || "main"}\n`);
        try {
          const integrated = integratePeerWorktree(args.repo, args.peerId, args.mergeBranch || "main");
          integrationStatus = integrated.status;
          integrationEvent = integrated.message;
          append(log, `[codex-peers] ${integrated.message}\n`);
        } catch (error) {
          status = "failed";
          integrationStatus = "failed";
          integrationError = error instanceof Error ? error.message : String(error);
          integrationEvent = "integration failed";
          append(log, `[codex-peers] integration failed: ${integrationError}\n`);
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
      append(log, `[codex-peers] exited code=${code} signal=${signal ?? ""}\n`);
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

function buildCodexArgs(args: RunnerArgs): string[] {
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
