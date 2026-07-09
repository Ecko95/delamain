import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updatePeer, getPeer } from "./store.js";
import type { PeerRecord } from "./types.js";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "delamain-integ-inbox-"));
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

function seed(peers: Array<Record<string, unknown>>): Promise<void> {
	return writeFile(
		join(root, "state.json"),
		JSON.stringify({ version: 1, updatedAt: "2026-07-09T00:00:00.000Z", peers }, null, 2),
		"utf8",
	);
}

describe("integrate persist preserves concurrently-arrived inbox mail", () => {
	it("whole-record update keeps the fresh inbox while updating other fields", async () => {
		// Peer as it exists NOW: mail m1 arrived during the integration await.
		const m1 = { id: "m1", fromPeerId: "p2", toPeerId: "p1", message: "hi", expectReply: false, responseId: null, createdAt: "2026-07-09T00:01:00.000Z" };
		await seed([
			{
				id: "p1",
				name: "Peer p1",
				repo: process.cwd(),
				task: "integ test",
				status: "done",
				startedAt: "2026-07-09T00:00:00.000Z",
				updatedAt: "2026-07-09T00:00:00.000Z",
				logPath: join(root, "p1.log"),
				inbox: [m1],
			},
		]);

		// result.peer is the STALE pre-await snapshot: inbox empty, but a field changed.
		const updatedRecord = {
			...(getPeer("p1") as PeerRecord),
			inbox: [],
			integrationStatus: "pushed",
			integrationPrNumber: 42,
		} as PeerRecord;

		// The R#2 merge: keep cur.inbox (fresh), take everything else from result.peer.
		const merged = updatePeer(updatedRecord.id, (cur) => ({ ...updatedRecord, inbox: cur.inbox }));

		expect(merged).toBeDefined();
		expect(merged?.inbox).toHaveLength(1);
		expect(merged?.inbox?.[0]).toMatchObject({ id: "m1" });
		expect(merged?.integrationStatus).toBe("pushed");
		expect(merged?.integrationPrNumber).toBe(42);

		// And it persisted.
		const persisted = getPeer("p1");
		expect(persisted?.inbox).toHaveLength(1);
		expect(persisted?.integrationStatus).toBe("pushed");
	});
});
