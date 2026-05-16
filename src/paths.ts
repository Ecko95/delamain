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

export function runsDir(): string {
	return join(peersHome(), "runs");
}

export function promptsDir(): string {
	return join(peersHome(), "prompts");
}

export function worktreesDir(): string {
	return join(peersHome(), "worktrees");
}
