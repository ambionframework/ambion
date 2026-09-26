/**
 * The room's facts, and the one step that applies an entry to them.
 *
 * The journal is the truth, and the room holds no fact beside it. The base
 * facts are what each entry adds or changes: the messages, the closes, the
 * leases, the composition, and the deliveries. `projection.ts` applies each
 * entry with `applyEvent` or its own step, and derives the rest: the roster,
 * the reserve, the people, the open exchange, and the activations the room
 * owes. A room that replays the journal derives the same state as the room
 * that wrote it, which is what lets a room resume where it stopped.
 */

import { decodeActivationId } from '../activation-id.ts';
import type { Close, Composition, Seating } from '../journal/events.ts';
import { type Entry, placed } from '../journal/journal.ts';
import type { ExchangeRef, Message, Seq } from '../types.ts';
import { type MessageDelivery, messageDelivery } from './delivery.ts';
import { applyLease, type LeaseHold, type PendingActivation } from './lease.ts';
import type { PersonState } from './presence.ts';
import { cancelHold } from './rules.verified.ts';
import type { ScheduledSay } from './scheduled.ts';

export interface RoomState {
	readonly composition: Composition | undefined;
	readonly roster: Seating[];
	readonly reserve: Seating[];
	readonly people: Map<string, PersonState>;
	readonly exchange: ExchangeRef | undefined;
	readonly closes: Close[];
	/** The latest cancellation marker, whose journal position bounds old work. */
	readonly cancelledAt?: Seq;
	/** The `through` of each close that a cancellation wrote. */
	readonly cancelClosed: readonly Seq[];
	readonly leases: Map<string, LeaseHold>;
	readonly deliveries: Map<Seq, MessageDelivery>;
	/** Every activation the room owes, whatever caused it: the wakes and the drafts as one list. */
	readonly due: PendingActivation[];
	/** The scheduled says that wait to return, in the order they landed. None of them is live work. */
	readonly scheduled: readonly ScheduledSay[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
}

/**
 * What the projection needs of the retry policy: how long the room waits
 * after `attempt` failed ones. The cap belongs to the decision.
 */
export interface FoldOptions {
	backoff(attempt: number): number;
}

/** The facts beside the derived projection. It contains no journal history. */
export interface BaseFacts {
	messages: Message[];
	closes: Close[];
	cancelledAt: Seq | undefined;
	cancelClosed: Seq[];
	leases: Map<string, LeaseHold>;
	composition: Composition | undefined;
	deliveries: Map<Seq, MessageDelivery>;
}

/** The empty room facts before the first committed event. */
export const older = (): BaseFacts => ({
	messages: [],
	closes: [],
	cancelledAt: undefined,
	cancelClosed: [],
	leases: new Map(),
	composition: undefined,
	deliveries: new Map(),
});

/** Applies one committed event to the room facts. */
export function applyEvent(read: BaseFacts, entry: Entry): void {
	if (entry.kind === 'message') {
		const message = placed(entry);
		read.deliveries.set(message.seq, messageDelivery(message, read.leases));
		read.messages.push(message);
		return;
	}
	if (entry.kind === 'close') {
		read.closes.push(entry.body);
		return;
	}
	if (entry.kind === 'cancel') {
		read.cancelledAt = entry.seq;
		cancelLeases(read.leases, entry.seq, entry.body.at);
		if (entry.body.close !== undefined) {
			read.closes.push(entry.body.close);
			read.cancelClosed.push(entry.body.close.through);
		}
		return;
	}
	if (entry.kind === 'lease') {
		applyLease(read.leases, entry);
		return;
	}
	if (entry.kind === 'composition') {
		read.composition = { ...entry.body, seq: entry.seq };
		return;
	}
}

/** A cancellation ends old leases while retaining their reads. */
function cancelLeases(leases: Map<string, LeaseHold>, cancelledAt: Seq, at: string): void {
	for (const [id, lease] of leases) {
		const parsed = decodeActivationId(id);
		if (parsed !== undefined) leases.set(id, cancelHold(lease, parsed.position, cancelledAt, at));
	}
}

export function reserveOf(
	composition: Composition | undefined,
	roster: readonly Seating[],
): Seating[] {
	if (composition === undefined) return [];
	const seated = new Set(roster.map((seat) => seat.name));
	const definitions = new Map(
		[...composition.agents, ...composition.available].map((seat) => [seat.name, seat]),
	);
	return [...definitions.values()]
		.filter((seat) => !seated.has(seat.name))
		.map((seat) => ({
			name: seat.name,
			identity: seat.identity,
			attention: 'broadcast',
			...(seat.fixed === undefined ? {} : { fixed: seat.fixed }),
		}));
}

/**
 * One seating or unseating applied to the roster. Any other message changes
 * nothing.
 */
export function reseat(roster: Seating[], message: Message): void {
	if (message.kind !== 'seated' && message.kind !== 'unseated') return;
	const at = roster.findIndex((seat) => seat.name === message.subject);
	if (at >= 0) roster.splice(at, 1);
	if (message.kind === 'seated') {
		roster.push({
			name: message.subject,
			identity: message.identity ?? '',
			attention: message.attention ?? 'broadcast',
			...(message.fixed === undefined ? {} : { fixed: message.fixed }),
		});
	}
}

/** A seat an agent cannot unseat. The summary writer's is fixed unless its seating said `fixed: false`. */
export const isFixed = (seat: Seating, composition: Composition | undefined): boolean =>
	seat.fixed ?? seat.name === composition?.summary;
