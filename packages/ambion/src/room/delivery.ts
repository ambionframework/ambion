/** The recipients a message reaches, derived from journal facts. */

import type { Seating } from '../journal/entries.ts';
import type { Message } from '../types.ts';
import type { LeaseHold } from './lease.ts';
import { hears, targetOf } from './routing.ts';

export interface MessageRecipients {
	/** Seats the message explicitly wakes. */
	readonly wakes: readonly string[];
	/** Respond activations that the message steers. */
	readonly steers: readonly MessageSteer[];
}

interface MessageSteer {
	readonly seat: string;
	readonly activation: string;
}

/**
 * Derive recipients from the journal state immediately before a message.
 * `roster` is the room's roster at that point.
 */
export function messageDelivery(
	message: Message,
	leases: ReadonlyMap<string, LeaseHold>,
	roster: readonly Readonly<Seating>[],
): MessageRecipients {
	const wakes = new Set(message.wakes ?? []);
	const steered = new Map<string, string>();
	for (const lease of leases.values()) {
		const { source, seat } = lease.activation;
		// A message steers a respond lease that was at work when it landed, and
		// never the author's seat or a seat it wakes. It steers a seat only when
		// the seat would hear it at rest: a seat it names, or a seat whose
		// attention is wide enough. A say to oneself steers no seat. The first
		// lease at a seat, in journal order, is the one it steers.
		const steers =
			source === 'message' &&
			seat !== message.from &&
			hearsWhileWorking(message, seat, roster) &&
			!(message.kind === 'said' && message.delaySeconds !== undefined) &&
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

/**
 * A say or a system message reaches a working seat as it reaches an idle one:
 * by name, or by the width of its attention. Every other message kind steers
 * a working seat. So does any message for a seat off the roster.
 */
function hearsWhileWorking(
	message: Message,
	seat: string,
	roster: readonly Readonly<Seating>[],
): boolean {
	if (message.kind !== 'said' && message.kind !== 'system') return true;
	const held = roster.find((candidate) => candidate.name === seat);
	return held === undefined || hears(held, targetOf(message), message);
}

/** The lease held a change before the message, and ended, if it ended, after it. */
function atWork(lease: LeaseHold, seq: number): boolean {
	return lease.openedSeq < seq && (lease.phase !== 'ended' || lease.until >= seq);
}
