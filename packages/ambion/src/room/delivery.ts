/** The recipients a message reaches, derived from journal facts. */

import { decodeActivationId } from '../activation-id.ts';
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
		const parsed = decodeActivationId(lease.id);
		if (parsed === undefined) continue;
		const { source, seat } = parsed;
		// A message steers an ordinary lease that was at work when it landed, and
		// never the author's seat or a seat it wakes. The first lease at a seat,
		// in journal order, is the one it steers.
		const steers =
			source === 'message' &&
			seat !== message.from &&
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
	return lease.since < seq && (lease.phase !== 'ended' || lease.until >= seq);
}
