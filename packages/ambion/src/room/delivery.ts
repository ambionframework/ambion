/** The recipients a message reaches, derived from journal facts. */

import type { Message } from '../types.ts';
import type { LeaseHold } from './lease.ts';

export interface MessageDelivery {
	/** Seats the message explicitly wakes. */
	readonly wakes: readonly string[];
	/** Ordinary activations that the message steers. */
	readonly steers: readonly MessageSteer[];
}

interface MessageSteer {
	readonly seat: string;
	readonly activation: string;
}

/** Derive recipients from the journal state immediately before a message. */
export function messageDelivery(
	message: Message,
	leases: ReadonlyMap<string, LeaseHold>,
): MessageDelivery {
	const wakes = new Set(message.wakes ?? []);
	const steered = new Map<string, string>();
	for (const lease of leases.values()) {
		const { source, seat } = lease.activation;
		// A message steers an ordinary lease that was at work when it landed, and
		// never the author's seat or a seat it wakes. A returned say steers
		// only the seat that scheduled it, and a say to oneself steers no
		// seat. The first lease at a seat, in journal order, is the one it
		// steers.
		const steers =
			source === 'message' &&
			seat !== message.from &&
			(message.kind !== 'returned' || seat === message.to) &&
			!(message.kind === 'said' && message.after !== undefined) &&
			message.kind !== 'dismissed' &&
			!wakes.has(seat) &&
			atWork(lease, message.seq);
		if (steers && !steered.has(seat)) steered.set(seat, lease.id);
	}
	return {
		wakes: [...wakes],
		steers: [...steered].map(([seat, activation]) => ({ seat, activation })),
	};
}

/** The lease held a change before the message, and ended, if it ended, after it. */
function atWork(lease: LeaseHold, seq: number): boolean {
	return lease.openedSeq < seq && (lease.phase !== 'ended' || lease.until >= seq);
}
