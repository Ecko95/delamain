import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { trim } from "./codexEvents.js";
import { parseCursorJsonLine } from "./cursorEvents.js";
import { integratePeerWorktree } from "./git.js";
import { initialTerminalResponseState, updateTerminalResponseState } from "./lifecycle.js";
import { updatePeer } from "./store.js";

export type CursorRunnerArgs = {
	peerId: string;
	repo: string;
	promptFile: string;
	logPath: string;
	resumeThread?: string;
	mergeBranch?: string;
	model?: string;
	cloud?: boolean;
	approveMcps?: boolean;
	force?: boolean;
};

export const DEFAULT_CURSOR_MODEL = "composer-2-fast";

// Aliases mirror freema/cursor-plugin-cc so the supervisor can pick a model
// by short name. Unknown ids pass through verbatim — `cursor-agent` rotates
// these over time and `cursor-agent ls-models` shows the live list.
export const CURSOR_MODEL_ALIASES: Record<string, string> = {
	composer: "composer-2-fast",
	"composer-fast": "composer-2-fast",
	fast: "composer-2-fast",
	"composer-2-fast": "composer-2-fast",
	"composer-2": "composer-2",
	"composer-full": "composer-2",
	"composer-1.5": "composer-1.5",
	auto: "auto",
	sonnet: "claude-4.6-sonnet-medium",
	"sonnet-4.6": "claude-4.6-sonnet-medium",
	"sonnet-4.6-thinking": "claude-4.6-sonnet-medium-thinking",
	"sonnet-4.5": "claude-4.5-sonnet",
	"sonnet-4.5-thinking": "claude-4.5-sonnet-thinking",
	"sonnet-4": "claude-4-sonnet",
	opus: "claude-opus-4-7-high",
	"opus-4.7": "claude-opus-4-7-high",
	"opus-4.7-max": "claude-opus-4-7-max",
	"opus-4.7-thinking": "claude-opus-4-7-thinking-high",
	"opus-4.6": "claude-4.6-opus-high",
	gpt: "gpt-5.3-codex",
	codex: "gpt-5.3-codex",
	"gpt-5.3-codex": "gpt-5.3-codex",
	"gpt-5.3-codex-fast": "gpt-5.3-codex-fast",
	"gpt-5.3-codex-high": "gpt-5.3-codex-high",
	"gpt-5.2-codex": "gpt-5.2-codex",
	"gpt-5.2": "gpt-5.2",
	grok: "grok-4-20",
	"grok-thinking": "grok-4-20-thinking",
	gemini: "gemini-3.1-pro",
	"gemini-pro": "gemini-3.1-pro",
	"gemini-flash": "gemini-3-flash",
};

export function resolveCursorModel(input: string | undefined): string {
	if (!input || input.trim() === "") return DEFAULT_CURSOR_MODEL;
	const key = input.trim().toLowerCase();
	return CURSOR_MODEL_ALIASES[key] ?? input.trim();
}

export function buildCursorArgs(args: CursorRunnerArgs, prompt: string): string[] {
	const cliArgs = ["-p", "--output-format", "stream-json", "--trust"];
	const model = resolveCursorModel(args.model);
	cliArgs.push("--model", model);
	if (args.force !== false) cliArgs.push("--force");
	if (args.approveMcps) cliArgs.push("--approve-mcps");
	if (args.cloud) cliArgs.push("--cloud");
	if (args.resumeThread) cliArgs.push(`--resume=${args.resumeThread}`);
	cliArgs.push(prompt);
	return cliArgs;
}

export async function runCursorPeer(args: CursorRunnerArgs): Promise<void> {
	mkdirSync(dirname(args.logPath), { recursive: true });
	const log = createWriteStream(args.logPath, { flags: "a" });
	const prompt = wrapCursorPrompt(
		readFileSync(args.promptFile, "utf8"),
		args.repo,
		args.mergeBranch,
		Boolean(args.resumeThread),
	);
	const bin = process.env.CURSOR_AGENT_BIN || "cursor-agent";
	const cliArgs = buildCursorArgs(args, prompt);

	append(log, `[codex-peers][cursor] starting: ${bin} ${redactArgs(cliArgs).join(" ")}\n`);
	updatePeer(args.peerId, (peer) => ({
		...peer,
		engine: "cursor",
		status: "working",
		runnerPid: process.pid,
		updatedAt: now(),
		lastHeartbeatAt: now(),
		lastEvent: "cursor runner started",
	}));

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
		lastEvent: `cursor-agent started pid=${child.pid ?? "unknown"}`,
	}));

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
		append(log, `[codex-peers][cursor] failed to start cursor-agent: ${error.message}\n`);
		updatePeer(args.peerId, (peer) => ({
			...peer,
			status: "failed",
			error: error.message,
			finishedAt: now(),
			updatedAt: now(),
			lastEvent: "cursor-agent failed to start",
		}));
	});

	await new Promise<void>((resolve) => {
		child.on("close", (code, signal) => {
			clearInterval(heartbeat);
			if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer.trimEnd());
			if (stderrBuffer.trim()) append(log, `[stderr] ${stderrBuffer.trimEnd()}\n`);

			const finalQuestion = terminalResponse.waitingQuestion;
			let status: "waiting" | "done" | "failed" = finalQuestion
				? "waiting"
				: code === 0
					? "done"
					: "failed";
			let integrationStatus: "skipped" | "pushed" | "failed" | undefined;
			let integrationError: string | undefined;
			let integrationEvent: string | undefined;

			if (status === "done") {
				updatePeer(args.peerId, (peer) => ({
					...peer,
					updatedAt: now(),
					lastHeartbeatAt: now(),
					lastEvent: `cursor-agent exited code=${code}; integrating peer worktree`,
				}));
				append(
					log,
					`[codex-peers][cursor] integrating peer worktree with origin/${args.mergeBranch || "main"}\n`,
				);
				try {
					const integrated = integratePeerWorktree(args.repo, args.peerId, args.mergeBranch || "main");
					integrationStatus = integrated.status;
					integrationEvent = integrated.message;
					append(log, `[codex-peers][cursor] ${integrated.message}\n`);
				} catch (error) {
					status = "failed";
					integrationStatus = "failed";
					integrationError = error instanceof Error ? error.message : String(error);
					integrationEvent = "integration failed";
					append(log, `[codex-peers][cursor] integration failed: ${integrationError}\n`);
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
				lastEvent:
					status === "waiting"
						? "waiting for orchestrator input"
						: integrationEvent || `cursor-agent exited code=${code}`,
			}));
			append(log, `[codex-peers][cursor] exited code=${code} signal=${signal ?? ""}\n`);
			log.end();
			resolve();
		});
	});

	function handleStdoutLine(line: string): void {
		if (!line.trim()) return;
		append(log, `${line}\n`);
		const parsed = parseCursorJsonLine(line);
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

function wrapCursorPrompt(
	prompt: string,
	repo: string,
	mergeBranch: string | undefined,
	isResume: boolean,
): string {
	const header = isResume ? "Continue the existing Cursor peer task." : "You are a supervised Cursor peer worker.";
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
	// The prompt is the last positional and can be arbitrarily long; truncate
	// it in the log preamble so the start-of-run line stays scannable.
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
