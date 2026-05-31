import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at an isolated home before importing it.
const home = mkdtempSync(join(tmpdir(), "delamain-archive-"));
process.env.DELAMAIN_HOME = home;

const store = await import("../dist/store.js");
const peerManager = await import("../dist/peerManager.js");

function peer(id, status) {
	const now = new Date().toISOString();
	return {
		id,
		repo: "/tmp/repo",
		task: `task ${id}`,
		status,
		engine: status === "done" ? "cursor" : "codex",
		startedAt: now,
		updatedAt: now,
		logPath: join(home, "runs", `${id}.log`),
	};
}

function seed(peers) {
	store.writeState({ version: 1, updatedAt: new Date().toISOString(), peers });
	store.writeArchive({ version: 1, updatedAt: new Date().toISOString(), peers: [] });
}

test("archivePeers({allFinished}) moves only non-live peers", () => {
	seed([peer("aaaa1111", "working"), peer("bbbb2222", "done"), peer("cccc3333", "failed"), peer("dddd4444", "waiting")]);

	const result = peerManager.archivePeers({ allFinished: true });

	assert.deepEqual(result.archived.sort(), ["bbbb2222", "cccc3333"]);
	const live = store.readState().peers.map((p) => p.id).sort();
	assert.deepEqual(live, ["aaaa1111", "dddd4444"], "working + waiting stay live");
	const archived = store.readArchivedPeers().map((p) => p.id).sort();
	assert.deepEqual(archived, ["bbbb2222", "cccc3333"]);
	assert.ok(store.readArchivedPeers().every((p) => p.archived === true && p.archivedAt));
	assert.ok(existsSync(join(home, "state.archive.json")));
});

test("archiving by explicit id refuses a live peer", () => {
	seed([peer("aaaa1111", "working"), peer("bbbb2222", "done")]);

	const result = peerManager.archivePeers({ ids: ["aaaa", "bbbb"] });

	assert.deepEqual(result.archived, ["bbbb2222"]);
	assert.deepEqual(result.skippedActive, ["aaaa1111"]);
});

test("unarchivePeers restores and clears archive flags", () => {
	seed([peer("aaaa1111", "working"), peer("bbbb2222", "done")]);
	peerManager.archivePeers({ allFinished: true });

	const restored = peerManager.unarchivePeers(["bbbb"]);

	assert.deepEqual(restored.restored, ["bbbb2222"]);
	const live = store.readState().peers.find((p) => p.id === "bbbb2222");
	assert.ok(live, "peer is back in live state");
	assert.equal(live.archived, undefined, "archived flag cleared");
	assert.equal(live.archivedAt, undefined, "archivedAt cleared");
	assert.equal(store.readArchivedPeers().length, 0, "archive emptied");
});

test("live state.json never contains archived peers after bulk archive", () => {
	seed([peer("aaaa1111", "working"), peer("bbbb2222", "done"), peer("cccc3333", "killed")]);
	peerManager.archivePeers({ allFinished: true });

	const liveRaw = JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
	assert.equal(liveRaw.peers.length, 1);
	assert.equal(liveRaw.peers[0].id, "aaaa1111");
});
