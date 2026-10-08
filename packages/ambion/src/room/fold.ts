/**
 * The room's facts, and the one step that applies an entry to them.
 *
 * The journal is the truth, and the room holds no fact beside it. The base
 * facts are what each entry adds or changes: the messages, the closes, the
 * leases, the composition, and the deliveries. `projection.ts` applies each
 * entry with `applyEntry` or its own step, and derives the rest: the roster,
 * the reserve, the people, the open exchange, and the activations the room
 * owes. A room that replays the journal derives the same state as the room
 * that wrote it, which is what lets a room resume where it stopped.
 */

import type { Close, Composition, Seating } from '../journal/entries.ts';
import { placed, type RoomEntry } from '../journal/journal.ts';
import type { ScheduledSay } from '../scheduling.ts';
import type { ExchangeRef, Message, MessageSnapshot, Seq } from '../types.ts';
import { type MessageRecipients, messageDelivery } from './delivery.ts';
import { applyLease, type DueActivation, type LeaseHold } from './lease.ts';
import type { PersonState } from './presence.ts';
import { cancelHold } from './rules.verified.ts';

/** A composition shared with a room snapshot. */
export type RoomComposition = Readonly<Omit<Composition, 'seated' | 'reserve'>> & {
	readonly seated: readonly Readonly<Seating>[];
	readonly reserve: readonly Readonly<Seating>[];
};

/** Shared room facts. Builders own mutable containers before they expose this view. */
export interface RoomState {
	readonly composition: RoomComposition | undefined;
	readonly roster: readonly Readonly<Seating>[];
	readonly reserve: readonly Readonly<Seating>[];
	readonly people: ReadonlyMap<string, Readonly<PersonState>>;
	readonly exchange: ExchangeRef | undefined;
	readonly closes: readonly Readonly<Close>[];
	/** The latest cancellation marker, whose journal position bounds old work. */
	readonly cancelledAt?: Seq;
	readonly leases: ReadonlyMap<string, Readonly<LeaseHold>>;
	readonly deliveries: ReadonlyMap<Seq, MessageRecipients>;
	/** Every activation the room owes, whatever caused it: the message activations and the summary activations as one list. */
	readonly due: readonly Readonly<DueActivation>[];
	/** The scheduled says that wait to return, in the order they landed. None of them is live work. */
	readonly scheduled: readonly ScheduledSay[];
	readonly messages: readonly MessageSnapshot[];
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
	leases: Map<string, LeaseHold>;
	composition: Composition | undefined;
	deliveries: Map<Seq, MessageRecipients>;
}

/** The empty room facts before the first committed entry. */
export const noFacts = (): BaseFacts => ({
	messages: [],
	closes: [],
	cancelledAt: undefined,
	leases: new Map(),
	composition: undefined,
	deliveries: new Map(),
});

/**
 * Applies one committed entry to the room facts. `open` is the exchange
 * open before the entry, and `roster` the roster before it. The base facts
 * hold neither. A cancellation reads the exchange: it closes it. A message
 * reads the roster: its attention decides who the message steers.
 */
export function applyEntry(
	read: BaseFacts,
	entry: RoomEntry,
	open: ExchangeRef | undefined,
	roster: readonly Readonly<Seating>[],
): void {
	if (entry.kind === 'message') {
		const message = placed(entry);
		read.deliveries.set(message.seq, messageDelivery(message, read.leases, roster));
		read.messages.push(message);
		return;
	}
	if (entry.kind === 'close') {
		read.closes.push(entry.body);
		return;
	}
	if (entry.kind === 'cancel') {
		const close = cancelledClose(open, read.messages.at(-1)?.seq ?? 0, entry.body.at);
		if (close !== undefined) read.closes.push(close);
		read.cancelledAt = entry.seq;
		cancelLeases(read.leases, entry.seq, entry.body.at);
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

/**
 * The close that a cancellation derives for the open exchange, or nothing
 * when no exchange is open. It ends at the last message before the
 * cancellation, and it owes no summary.
 */
function cancelledClose(
	open: ExchangeRef | undefined,
	through: Seq,
	at: string,
): Close | undefined {
	if (open === undefined) return undefined;
	return {
		...(open.person === undefined ? {} : { person: open.person }),
		from: open.from,
		through,
		at,
		cancelled: true,
	};
}

/** A cancellation ends old leases while retaining their reads. */
function cancelLeases(leases: Map<string, LeaseHold>, cancelledAt: Seq, at: string): void {
	for (const [id, lease] of leases) leases.set(id, cancelHold(lease, cancelledAt, at));
}

export function reserveOf(
	composition: Composition | undefined,
	roster: readonly Seating[],
): Seating[] {
	if (composition === undefined) return [];
	const seated = new Set(roster.map((seat) => seat.name));
	const definitions = new Map(
		[...composition.seated, ...composition.reserve].map((seat) => [seat.name, seat]),
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
export const isFixed = (
	seat: Readonly<Seating>,
	composition: RoomComposition | undefined,
): boolean => seat.fixed ?? seat.name === composition?.summaryWriter;
