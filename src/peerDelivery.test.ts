import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverPending } from "./peerManager.js";
import { drainDeliverable, enqueuePeerMessage } from "./peerInbox.js";
import type { ResumePeerOptions } from "./types.js";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "delamain-delivery-"));
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

function peer(id: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		name: `Peer ${id}`,
		repo: process.cwd(),
		task: "delivery test",
		status,
		startedAt: "2026-07-08T00:00:00.000Z",
		updatedAt: "2026-07-08T00:00:00.000Z",
		logPath: join(root, `${id}.log`),
		...extra,
	};
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: `m-${Math.random().toString(36).slice(2)}`,
		fromPeerId: "p1",
		toPeerId: "p2",
		message: "hello there",
		expectReply: false,
		createdAt: "2026-07-08T00:00:00.000Z",
		...overrides,
	};
}

describe("turn-boundary delivery", () => {
	it("resumes exactly once with a prompt containing sender id, reply instruction, and responseId", async () => {
		await seed([
			peer("p1", "working"),
			peer("p2", "waiting", { threadId: "thread-2", inbox: [message({ expectReply: true, responseId: "resp-9" })] }),
		]);
		const calls: ResumePeerOptions[] = [];
		const outcome = deliverPending("p2", (opts) => {
			calls.push(opts);
			return {} as never;
		});

		expect(outcome).toEqual({ delivered: 1 });
		expect(calls).toHaveLength(1);
		expect(calls[0].peerId).toBe("p2");
		expect(calls[0].prompt).toContain("[delamain inbox] from p1");
		expect(calls[0].prompt).toContain("resp-9");
		expect(calls[0].prompt).toContain("delamain send --to p1 --response-id resp-9");
	});

	it("does not resume when the receiver is working", async () => {
		await seed([peer("p1", "idle"), peer("p2", "working", { threadId: "thread-2", inbox: [message()] })]);
		let called = false;
		const outcome = deliverPending("p2", () => {
			called = true;
			return {} as never;
		});

		expect(called).toBe(false);
		expect(outcome).toEqual({ delivered: 0, skipped: "status=working" });
	});

	it("is a no-op when the inbox is empty", async () => {
		await seed([peer("p2", "waiting", { threadId: "thread-2" })]);
		let called = false;
		const outcome = deliverPending("p2", () => {
			called = true;
			return {} as never;
		});

		expect(called).toBe(false);
		expect(outcome).toEqual({ delivered: 0, skipped: "empty" });
	});

	it("does not re-deliver already-drained messages on a second pass", async () => {
		await seed([peer("p1", "idle"), peer("p2", "waiting", { threadId: "thread-2", inbox: [message()] })]);
		let count = 0;
		const resume = () => {
			count += 1;
			return {} as never;
		};

		expect(deliverPending("p2", resume)).toEqual({ delivered: 1 });
		expect(deliverPending("p2", resume)).toEqual({ delivered: 0, skipped: "empty" });
		expect(count).toBe(1);
	});
});

describe("inbox store primitives", () => {
	it("drainDeliverable marks messages delivered so a second drain returns nothing", async () => {
		await seed([peer("p2", "waiting", { inbox: [message(), message({ id: "m-2", message: "second" })] })]);
		expect(drainDeliverable("p2")).toHaveLength(2);
		expect(drainDeliverable("p2")).toHaveLength(0);
	});

	it("echoing a responseId with expectReply=false does not mint a new id", async () => {
		await seed([peer("p1", "idle"), peer("p2", "idle")]);
		const { responseId } = enqueuePeerMessage({
			fromPeerId: "p2",
			toPeerId: "p1",
			message: "a!",
			expectReply: false,
			responseId: "resp-9",
		});
		expect(responseId).toBe("resp-9");
	});
});
