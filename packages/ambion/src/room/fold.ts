/**
 * Every fact about the room, as a fold over the journal.
 *
 * The journal is the truth, and the room holds no fact beside it: the roster,
 * the reserve, the people, the open exchange, the closes, the leases, the
 * wakes still pending and the summaries still owed are each one function
 * over the entries. A room that replays the journal folds the same state the
 * room that wrote it held, which is what lets a room resume where it
 * stopped.
 */

import { decodeActivationId } from '../activation-id.ts';
import type { Close, Composition, Seating } from '../journal/events.ts';
import { type Entry, placed } from '../journal/journal.ts';
import type { ExchangeRef, Message, Seq } from '../types.ts';
import { type MessageDelivery, messageDelivery } from './delivery.ts';
import { openExchange, summaryCompletion } from './exchange.ts';
import {
	applyLease,
	cameToNothing,
	type LeaseHold,
	type PendingActivation,
	type PendingWake,
	pendingActivation,
	pendingWakes,
} from './lease.ts';
import { foldPeople, type PersonState } from './presence.ts';
import {
	cancelHold,
	foldRoster as foldRosterRule,
	lastOf,
	type Membership,
	reserveOf as reserveRule,
	survivesCancellation,
} from './rules.verified.ts';

/** A summary one person is owed, and how the room has tried to write it. */
interface Owed extends PendingActivation {
	person: string;
	/** The seat the close named to write it. */
	writer: string;
	/** The opening question that identifies the closed exchange. */
	from: Seq;
	/** The close boundary that the summary must retain. */
	through: Seq;
}

export interface RoomState {
	readonly composition: Composition | undefined;
	readonly roster: Seating[];
	readonly reserve: Seating[];
	readonly people: Map<string, PersonState>;
	readonly exchange: ExchangeRef | undefined;
	readonly closes: Close[];
	/** The latest cancellation marker, whose journal position bounds old work. */
	readonly cancelledAt?: Seq;
	readonly leases: Map<string, LeaseHold>;
	readonly deliveries: Map<Seq, MessageDelivery>;
	readonly pending: PendingWake[];
	readonly owed: Owed[];
	/** Every activation the room owes, whatever caused it: the wakes and the drafts as one list. */
	readonly due: PendingActivation[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
}

/**
 * What the fold needs of the retry policy: how long the room waits after
 * `attempt` failed ones. The cap belongs to the decision, not the fold.
 */
export interface FoldOptions {
	backoff(attempt: number): number;
}

/** The facts beside the derived projection. It contains no journal history. */
interface BaseFacts {
	messages: Message[];
	closes: Close[];
	cancelledAt: Seq | undefined;
	leases: Map<string, LeaseHold>;
	composition: Composition | undefined;
	deliveries: Map<Seq, MessageDelivery>;
}

/** The private base facts held by a projection for incremental evolution. */
export const baseOf = (state: RoomState): BaseFacts => ({
	messages: [...state.messages],
	closes: [...state.closes],
	cancelledAt: state.cancelledAt,
	leases: new Map(state.leases),
	composition: state.composition,
	deliveries: new Map(state.deliveries),
});

/** The empty room facts before the first committed event. */
const older = (): BaseFacts => ({
	messages: [],
	closes: [],
	cancelledAt: undefined,
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
		if (entry.body.close !== undefined) read.closes.push(entry.body.close);
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

export function foldRoom(entries: readonly Entry[], options: FoldOptions): RoomState {
	const read = older();
	for (const entry of entries) applyEvent(read, entry);
	return project(read, options);
}

/** Derives all room views from the base facts. */
export function project(read: BaseFacts, options: FoldOptions): RoomState {
	const { messages, closes, leases, composition, deliveries, cancelledAt } = read;
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const exchange = openExchange(messages, closes, [...people.keys()]);
	const pending = pendingWakes(
		messages,
		deliveries,
		leases,
		new Set(roster.map((s) => s.name)),
		options,
	).filter((wake) => survivesCancellation(wake.position, cancelledAt));
	const owed = foldOwed(closes, messages, leases, options, cancelledAt);
	const state: RoomState = {
		composition,
		roster,
		reserve: reserveOf(composition, roster),
		people,
		exchange,
		closes,
		cancelledAt,
		leases,
		deliveries,
		pending,
		owed,
		due: [...pending, ...owed],
		messages,
		lastSeq: lastOf(messages.map((message) => message.seq)),
	};
	return state;
}

/** A cancellation ends old leases while retaining their reads. */
function cancelLeases(leases: Map<string, LeaseHold>, cancelledAt: Seq, at: string): void {
	for (const [id, lease] of leases) {
		const parsed = decodeActivationId(id);
		if (parsed !== undefined) leases.set(id, cancelHold(lease, parsed.position, cancelledAt, at));
	}
}

function reserveOf(composition: Composition | undefined, roster: readonly Seating[]): Seating[] {
	if (composition === undefined) return [];
	const catalog = new Map(
		[...composition.agents, ...composition.available].map((seat) => [seat.name, seat]),
	);
	return reserveRule([...catalog.values()], roster);
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(composition: Composition | undefined, messages: readonly Message[]): Seating[] {
	if (composition === undefined) return [];
	return foldRosterRule(
		composition.agents.map((seat) => ({ ...seat })),
		messages.map((message) => ({ seq: message.seq, membership: membershipOf(message) })),
		composition.seq,
	);
}

/** What one message does to the roster: a seating, an unseating, or nothing. */
function membershipOf(message: Message): Membership {
	if (message.kind === 'seated')
		return {
			kind: 'seated',
			name: message.subject,
			identity: message.identity ?? '',
			attention: message.attention ?? 'broadcast',
		};
	if (message.kind === 'unseated') return { kind: 'unseated', name: message.subject };
	return { kind: 'other' };
}

/**
 * The summaries still owed, one per close. A close owes one when it names a
 * seat, no summary covers it, and its own draft did not stand down. The close
 * carries the name, so the fold reads who is owed off the record and never
 * off the room. A draft at the cap is still owed here, and carries the
 * attempts that reached it: the room decides what it does about a draft it
 * gave up on, and an entry it writes answers that close.
 */
function foldOwed(
	closes: readonly Close[],
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	context: FoldOptions,
	cancelledAt: Seq | undefined,
): Owed[] {
	return closes.flatMap((close) => {
		const completion = summaryCompletion(close, messages, leases, cancelledAt);
		if (completion.status !== 'pending' || completion.writer === undefined) return [];
		return [
			withAttempts(
				{
					person: close.owner,
					writer: completion.writer,
					from: close.from,
					through: close.through,
				},
				leases,
				context,
			),
		];
	});
}

/**
 * What a person is owed, as an activation: how many drafts over these
 * closes came to nothing, when the next may start, and the id it claims.
 */
function withAttempts(
	owed: Omit<Owed, keyof PendingActivation>,
	leases: ReadonlyMap<string, LeaseHold>,
	context: FoldOptions,
): Owed {
	const failed = [...leases.values()].filter((lease) => draftedOver(lease, owed.through));
	return {
		...owed,
		...pendingActivation('closed', owed.through, owed.writer, failed, context),
	};
}

/** A draft over this close that came to nothing. */
function draftedOver(lease: LeaseHold, through: Seq): boolean {
	const parsed = decodeActivationId(lease.id);
	if (parsed?.source !== 'closed' || parsed.position !== through) return false;
	return cameToNothing(lease);
}
