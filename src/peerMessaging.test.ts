import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callTool, TOOLS } from "./mcpServer.js";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "delamain-msg-"));
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

async function seed(peers: Array<Record<string, unknown>>): Promise<void> {
	await writeFile(
		join(root, "state.json"),
		JSON.stringify({ version: 1, updatedAt: "2026-07-08T00:00:00.000Z", peers }, null, 2),
		"utf8",
	);
}

function peer(id: string, status: string): Record<string, unknown> {
	return {
		id,
		name: `Peer ${id}`,
		repo: process.cwd(),
		task: "msg test",
		status,
		startedAt: "2026-07-08T00:00:00.000Z",
		updatedAt: "2026-07-08T00:00:00.000Z",
		logPath: join(root, `${id}.log`),
	};
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
	const result = (await callTool(name, args)) as { content: Array<{ text: string }> };
	return JSON.parse(result.content[0].text);
}

describe("peer messaging tool dispatch", () => {
	it("tool list includes both new tools", () => {
		const names = TOOLS.map((t) => t.name);
		expect(names).toContain("send_peer_message");
		expect(names).toContain("read_peer_inbox");
	});

	it("enqueue → read roundtrip", async () => {
		await seed([peer("p1", "working"), peer("p2", "idle")]);
		const sent = await call("send_peer_message", { from_peer_id: "p1", to_peer_id: "p2", message: "hello" });
		expect(sent.response_id).toBeNull();

		const inbox = await call("read_peer_inbox", { peer_id: "p2" });
		expect(inbox.messages).toHaveLength(1);
		expect(inbox.messages[0]).toMatchObject({ fromPeerId: "p1", toPeerId: "p2", message: "hello", expectReply: false });
	});

	it("expect_reply mints a response_id the sender can echo to close the thread", async () => {
		await seed([peer("p1", "working"), peer("p2", "idle")]);
		const opened = await call("send_peer_message", { from_peer_id: "p1", to_peer_id: "p2", message: "q?", expect_reply: true });
		expect(typeof opened.response_id).toBe("string");

		// receiver echoes the same response_id, expect_reply false → thread closed
		const closed = await call("send_peer_message", {
			from_peer_id: "p2",
			to_peer_id: "p1",
			message: "a!",
			response_id: opened.response_id,
		});
		expect(closed.response_id).toBe(opened.response_id);

		const p1inbox = await call("read_peer_inbox", { peer_id: "p1" });
		expect(p1inbox.messages[0]).toMatchObject({ responseId: opened.response_id, expectReply: false });
	});

	it("derives a sender-liveness notice from status", async () => {
		await seed([peer("p1", "waiting"), peer("p2", "idle")]);
		await call("send_peer_message", { from_peer_id: "p1", to_peer_id: "p2", message: "ping" });

		const inbox = await call("read_peer_inbox", { peer_id: "p2" });
		expect(inbox.notices).toEqual([{ peerId: "p1", status: "waiting", reason: "awaiting-input" }]);
	});

	it("rejects an unknown recipient", async () => {
		await seed([peer("p1", "working")]);
		await expect(call("send_peer_message", { from_peer_id: "p1", to_peer_id: "ghost", message: "x" })).rejects.toThrow(/to_peer_id/);
	});
});
