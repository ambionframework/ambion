/** The recipients a message reaches, derived from journal facts. */

import { decodeActivationId } from '../activation-id.ts';
import type { Message } from '../types.ts';
import type { LeaseHold } from './lease.ts';
import { steers } from './rules.verified.ts';

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
		// The first lease at a seat, in journal order, is the one the message steers.
		if (
			steers(source, seat, message.from, wakes.has(seat), lease, message.seq) &&
			!steered.has(seat)
		)
			steered.set(seat, lease.id);
	}
	return {
		wakes: [...wakes],
		steers: [...steered].map(([seat, activation]) => ({ seat, activation })),
	};
}
