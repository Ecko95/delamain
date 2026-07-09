// Test-only writer fixture for src/stateLock.test.ts. Spawned as a real OS
// subprocess (node --import tsx) so the cross-process state.json write race is
// actually exercised. Each run appends M unique-marker messages to one peer's
// inbox via the real updatePeer critical section.
import { updatePeer } from "./store.js";
import type { PeerMessage } from "./peerInbox.js";

const peerId = process.argv[2];
const count = Number(process.argv[3]);
const prefix = process.argv[4];

for (let i = 0; i < count; i++) {
	const marker = `${prefix}-${i}`;
	const msg: PeerMessage = {
		id: marker,
		fromPeerId: "writer",
		toPeerId: peerId,
		message: marker,
		expectReply: false,
		createdAt: new Date().toISOString(),
	};
	updatePeer(peerId, (peer) => ({ ...peer, inbox: [...(peer.inbox ?? []), msg] }));
}
