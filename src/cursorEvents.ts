import { parseWaitingQuestion, trim } from "./codexEvents.js";
import type { ParsedCodexEvent } from "./codexEvents.js";

const CHAT_ID_KEYS = new Set(["chat_id", "chatid", "session_id", "sessionid"]);

const TEXT_KEYS = new Set(["text", "content", "message", "result", "output", "summary", "delta"]);

const WRITE_TOOL_HINTS = ["write", "edit", "str_replace", "create_file", "patch", "apply_patch", "file_write"];

export function parseCursorJsonLine(line: string): ParsedCodexEvent {
	const trimmed = line.trim();
	if (!trimmed) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return parseFallbackText(trimmed);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}

	const record = parsed as Record<string, unknown>;
	const type = stringField(record, "type");
	const subtype = stringField(record, "subtype");
	const isError = record.is_error === true || record.error != null;

	const threadId = findThreadId(record);
	const text = collectText(record);
	const itemType = nestedItemType(record);
	const isAgentMessage = isAgentLike(type, itemType, subtype);
	const waitingQuestion = isAgentMessage && text ? parseWaitingQuestion(text) : undefined;
	const label = buildLabel(type, subtype, text, isError);

	return {
		type,
		itemType,
		isAgentMessage,
		threadId,
		text: text || undefined,
		label,
		waitingQuestion,
	};
}

function parseFallbackText(text: string): ParsedCodexEvent {
	return {
		text,
		label: trim(text, 180),
		isAgentMessage: true,
		waitingQuestion: parseWaitingQuestion(text),
	};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function nestedItemType(record: Record<string, unknown>): string | undefined {
	const item = record.item;
	if (!item || typeof item !== "object" || Array.isArray(item)) {
		return undefined;
	}
	const type = (item as Record<string, unknown>).type;
	return typeof type === "string" ? type : undefined;
}

function isAgentLike(type?: string, itemType?: string, subtype?: string): boolean {
	if (type === "assistant" || type === "message" || type === "agent_message") {
		return true;
	}
	if (itemType === "agent_message" || itemType === "assistant_message") {
		return true;
	}
	if (type === "result" && (subtype === "success" || subtype === undefined)) {
		return true;
	}
	return false;
}

function buildLabel(type?: string, subtype?: string, text?: string, isError?: boolean): string {
	const parts: string[] = [];
	if (type) {
		parts.push(subtype ? `${type}:${subtype}` : type);
	}
	if (isError) {
		parts.push("error");
	}
	if (text) {
		parts.push(trim(text, 140));
	}
	return parts.join(" ").trim();
}

function findThreadId(value: unknown, depth = 0): string | undefined {
	if (depth > 8 || value === null || typeof value !== "object") {
		return undefined;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findThreadId(item, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	for (const [key, child] of Object.entries(value)) {
		if (CHAT_ID_KEYS.has(key.toLowerCase()) && typeof child === "string" && child.length > 0) {
			return child;
		}
		const found = findThreadId(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

function collectText(value: unknown, depth = 0): string {
	const parts: string[] = [];
	walkText(value, depth, parts);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

function walkText(value: unknown, depth: number, out: string[]): void {
	if (depth > 7 || value === null || value === undefined) {
		return;
	}
	if (typeof value === "string") {
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			walkText(item, depth + 1, out);
		}
		return;
	}
	if (typeof value !== "object") {
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		if (TEXT_KEYS.has(key.toLowerCase()) && typeof child === "string") {
			const trimmed = child.trim();
			if (trimmed) {
				out.push(trimmed);
			}
		} else {
			walkText(child, depth + 1, out);
		}
	}
}

export type CursorToolUse = {
	name: string;
	input: unknown;
};

export function* walkToolUses(node: unknown): IterableIterator<CursorToolUse> {
	if (node === null || typeof node !== "object") {
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			yield* walkToolUses(item);
		}
		return;
	}
	const record = node as Record<string, unknown>;
	const type = record.type;
	const name = typeof record.name === "string" ? record.name : undefined;
	if ((type === "tool_use" || type === "tool_call") && name) {
		yield {
			name,
			input: record.input ?? record.arguments ?? record.params ?? record.tool_input,
		};
	}
	for (const value of Object.values(record)) {
		yield* walkToolUses(value);
	}
}

export function looksLikeFileWrite(name: string | undefined): boolean {
	if (!name) return false;
	const lower = name.toLowerCase();
	return WRITE_TOOL_HINTS.some((hint) => lower.includes(hint));
}
