import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Cross-process regression test for the state.json write race. Within one Node
// process the synchronous fs calls in updatePeer are already atomic, so the race
// only reproduces across REAL OS subprocesses — hence the fixture is spawned N
// times, each appending M unique markers to the same peer's inbox concurrently.

const FIXTURE = fileURLToPath(new URL("./stateLock.fixture.ts", import.meta.url));
const N = 6;
const M = 20;

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "delamain-lock-"));
	previousHome = process.env.DELAMAIN_HOME;
	process.env.DELAMAIN_HOME = root;
});

afterEach(async () => {
	if (previousHome === undefined) {
		delete process.env.DELAMAIN_HOME;
	} else {
		process.env.DELAMAIN_HOME = previousHome;
	}
	await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<void> {
	await writeFile(
		join(root, "state.json"),
		JSON.stringify(
			{
				version: 1,
				updatedAt: "2026-07-09T00:00:00.000Z",
				peers: [
					{
						id: "target",
						name: "Peer target",
						repo: process.cwd(),
						task: "lock test",
						status: "working",
						startedAt: "2026-07-09T00:00:00.000Z",
						updatedAt: "2026-07-09T00:00:00.000Z",
						logPath: join(root, "target.log"),
						inbox: [],
					},
				],
			},
			null,
			2,
		),
		"utf8",
	);
}

function runWriter(prefix: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", FIXTURE, "target", String(M), prefix], {
			env: { ...process.env, DELAMAIN_HOME: root },
			stdio: ["ignore", "ignore", "inherit"],
		});
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 0));
	});
}

describe("state.json cross-process write lock", () => {
	it("N concurrent writer processes never clobber each other's inbox appends", async () => {
		await seed();

		const codes = await Promise.all(Array.from({ length: N }, (_, i) => runWriter(`w${i}`)));
		expect(codes.every((c) => c === 0)).toBe(true);

		const raw = await readFile(join(root, "state.json"), "utf8");
		const state = JSON.parse(raw) as { peers: Array<{ id: string; inbox: Array<{ id: string }> }> };
		const target = state.peers.find((p) => p.id === "target");
		expect(target).toBeDefined();

		const markers = new Set((target?.inbox ?? []).map((m) => m.id));
		// Every unique marker from every writer must survive: no lost update.
		const expected = new Set<string>();
		for (let i = 0; i < N; i++) {
			for (let j = 0; j < M; j++) {
				expected.add(`w${i}-${j}`);
			}
		}
		expect(target?.inbox).toHaveLength(N * M);
		expect(markers.size).toBe(N * M);
		for (const e of expected) {
			expect(markers.has(e)).toBe(true);
		}
	}, 30000);
});
