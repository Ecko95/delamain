import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_DIR_NAME = ".codex-peers";
const CANONICAL_DIR_NAME = ".delamain";

let migrationChecked = false;

function migrateLegacyHomeOnce(): void {
	if (migrationChecked) return;
	migrationChecked = true;
	if (process.env.DELAMAIN_HOME || process.env.CODEX_PEERS_HOME) return;
	const legacy = join(homedir(), LEGACY_DIR_NAME);
	const canonical = join(homedir(), CANONICAL_DIR_NAME);
	if (existsSync(legacy) && !existsSync(canonical)) {
		try {
			renameSync(legacy, canonical);
			console.error(`[delamain] migrated state directory ${legacy} → ${canonical}`);
		} catch (error) {
			console.error(
				`[delamain] could not migrate ${legacy} → ${canonical}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

export function peersHome(): string {
	migrateLegacyHomeOnce();
	const override = process.env.DELAMAIN_HOME || process.env.CODEX_PEERS_HOME;
	if (override) return override;
	const canonical = join(homedir(), CANONICAL_DIR_NAME);
	if (existsSync(canonical)) return canonical;
	const legacy = join(homedir(), LEGACY_DIR_NAME);
	if (existsSync(legacy)) return legacy;
	return canonical;
}

export function statePath(): string {
	return join(peersHome(), "state.json");
}

// SP1 wave 3: SQLite state DB (replaces the whole-file state.json RMW).
export function stateDbPath(): string {
	return join(peersHome(), "state.db");
}

export function archivePath(): string {
	return join(peersHome(), "state.archive.json");
}

export function runsDir(): string {
	return join(peersHome(), "runs");
}

export function promptsDir(): string {
	return join(peersHome(), "prompts");
}

export function worktreesDir(): string {
	return join(peersHome(), "worktrees");
}

export function workflowsDir(): string {
	return join(peersHome(), "workflows");
}

// SP1 wave 4: tailable append-only event log for external subscribers
// (SP3 T3 bridge, SP4 Pi extension). The durable/queryable copy is the SQLite
// `events` table; this jsonl is the line-delimited fallback transport.
export function eventsJsonlPath(): string {
	return join(peersHome(), "events.jsonl");
}
