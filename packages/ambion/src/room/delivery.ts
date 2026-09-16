/** The recipients a message reaches, derived from journal facts. */

import { decodeActivationId } from '../activation-id.ts';
import type { Message, Seq } from '../types.ts';
import type { LeaseHold } from './lease.ts';
import { atWork as atWorkRule } from './rules.verified.ts';

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
	const steers = new Map<string, string>();
	for (const lease of leases.values()) {
		const parsed = decodeActivationId(lease.id);
		if (
			parsed?.source === 'message' &&
			parsed.seat !== message.from &&
			!wakes.has(parsed.seat) &&
			atWork(lease, message.seq)
		)
			if (!steers.has(parsed.seat)) steers.set(parsed.seat, lease.id);
	}
	return {
		wakes: [...wakes],
		steers: [...steers].map(([seat, activation]) => ({ seat, activation })),
	};
}

/** The lease interval covered the message position. */
function atWork(lease: LeaseHold, seq: Seq): boolean {
	return lease.phase === 'ended'
		? atWorkRule(lease.since, true, lease.until, seq)
		: atWorkRule(lease.since, false, 0, seq);
}
