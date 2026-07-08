import { randomUUID } from "node:crypto";
import { getPeer, updatePeer } from "./store.js";
import type { PeerRecord, PeerStatus } from "./types.js";

// ponytail: PROVISIONAL T1 SURFACE. T1 (src/peerInbox.ts) had not landed in this
// worktree when T3 was built, so this file implements the minimal slice T3
// consumes — the envelope type, enqueue, read, and status→notice derivation —
// faithful to the .planning/a2a-inbox-handoff.md contract. Reconcile with the
// real T1 module at merge: keep whichever is the superset, re-point the imports
// in mcpServer.ts / cli.ts. Drain/markDelivered/delivery-prompt formatter are
// T2's dependencies and intentionally omitted here.

export type PeerMessage = {
	id: string;
	fromPeerId: string;
	toPeerId: string;
	message: string;
	expectReply: boolean;
	responseId?: string;
	createdAt: string;
	deliveredAt?: string; // set by T2 on turn-boundary drain; absent = still queued
};

export type InboxNoticeReason =
	| "errored"
	| "receiver-cancelled"
	| "awaiting-input"
	| "turn-ended"
	| "quiet";

export type InboxNotice = {
	peerId: string;
	status: PeerStatus;
	reason: InboxNoticeReason;
};

// Decision 2 in the handoff: notices are derived on read from a peer's current
// status (delamain has no sweep daemon). Statuses not listed mean "still active,
// no notice".
const NOTICE_BY_STATUS: Partial<Record<PeerStatus, InboxNoticeReason>> = {
	failed: "errored",
	gsd_failed: "errored",
	killed: "receiver-cancelled",
	waiting: "awaiting-input",
	done: "turn-ended",
	idle: "turn-ended",
	gsd_completed: "turn-ended",
	frozen: "quiet",
};

export function noticeForStatus(status: PeerStatus): InboxNoticeReason | undefined {
	return NOTICE_BY_STATUS[status];
}

export type EnqueuePeerMessageInput = {
	fromPeerId: string;
	toPeerId: string;
	message: string;
	expectReply?: boolean;
	responseId?: string;
};

// Append a message to the receiver's inbox. Mints a responseId when the sender
// expects a reply and none was supplied; echoes the supplied responseId when
// continuing/closing a thread. Returns the stored envelope + effective responseId.
export function enqueuePeerMessage(input: EnqueuePeerMessageInput): { responseId?: string; message: PeerMessage } {
	const receiver = getPeer(input.toPeerId);
	if (!receiver) {
		throw new Error(`Unknown to_peer_id: ${input.toPeerId}`);
	}
	const responseId = input.responseId ?? (input.expectReply ? randomUUID() : undefined);
	const message: PeerMessage = {
		id: randomUUID(),
		fromPeerId: input.fromPeerId,
		toPeerId: receiver.id,
		message: input.message,
		expectReply: Boolean(input.expectReply),
		responseId,
		createdAt: new Date().toISOString(),
	};
	updatePeer(receiver.id, (peer) => ({ ...peer, inbox: [...(peer.inbox ?? []), message] }));
	return { responseId, message };
}

export type ReadPeerInboxResult = {
	peerId: string;
	messages: PeerMessage[];
	notices: InboxNotice[];
};

// Read a peer's inbox. Undelivered-only by default; includeDelivered returns the
// full history. Notices report the current liveness of each distinct sender so a
// reader learns when a correspondent it is waiting on has gone quiet/errored.
export function readPeerInbox(peerId: string, opts?: { includeDelivered?: boolean }): ReadPeerInboxResult {
	const receiver = getPeer(peerId);
	if (!receiver) {
		throw new Error(`Unknown peer_id: ${peerId}`);
	}
	const all = receiver.inbox ?? [];
	const messages = opts?.includeDelivered ? all : all.filter((m) => !m.deliveredAt);
	const notices: InboxNotice[] = [];
	const seen = new Set<string>();
	for (const m of messages) {
		if (seen.has(m.fromPeerId)) {
			continue;
		}
		seen.add(m.fromPeerId);
		const sender = getPeer(m.fromPeerId);
		if (!sender) {
			continue;
		}
		const reason = noticeForStatus(sender.status);
		if (reason) {
			notices.push({ peerId: sender.id, status: sender.status, reason });
		}
	}
	return { peerId: receiver.id, messages, notices };
}

export type { PeerRecord };
