/**
 * The oracle: every fact about the room, as a fold over the whole journal.
 *
 * The room derives its state one entry at a time in `room/projection.ts`.
 * This file derives the same facts from the whole journal at once, with no
 * index and no cache: the roster, the people, the open exchange, the wakes
 * still pending, the summaries still owed and the scheduled says are each one
 * function over the entries. `projection-equivalence.test.ts` holds the
 * projection equal to it after every entry of a seeded walk.
 */
import { type ActivationId, decodeActivationId } from '../../src/activation-id.ts';
import type { Close, Composition, Seating } from '../../src/journal/events.ts';
import type { Entry } from '../../src/journal/journal.ts';
import type { MessageDelivery } from '../../src/room/delivery.ts';
import { exchangeAfter, summaryCompletion } from '../../src/room/exchange.ts';
import {
	applyEvent,
	type BaseFacts,
	type FoldOptions,
	older,
	type RoomState,
	reseat,
	reserveOf,
} from '../../src/room/fold.ts';
import {
	type LeaseHold,
	type PendingActivation,
	type PendingWake,
	removedAfter,
	statusOf,
} from '../../src/room/lease.ts';
import { type Owed, withAttempts } from '../../src/room/owed.ts';
import { advancePeople, type PersonState } from '../../src/room/presence.ts';
import { projectState, replay } from '../../src/room/projection.ts';
import { coversAttempt } from '../../src/room/rules.verified.ts';
import { changesScheduled, type ScheduledSay, scheduleStep } from '../../src/room/scheduled.ts';
import type { ExchangeRef, Message, Seq } from '../../src/types.ts';

/** The fields an id encodes, as the fold decodes them for a lease that a test writes by hand. */
export function activationOf(id: string): ActivationId {
	const activation = decodeActivationId(id);
	if (activation === undefined) throw new Error(`Malformed activation id '${id}'.`);
	return activation;
}

/** The state after every entry, folded over the whole journal. */
export function foldRoom(entries: readonly Entry[], options: FoldOptions): RoomState {
	const read = older();
	for (const entry of entries)
		applyEvent(read, entry, entry.kind === 'cancel' ? open(read) : undefined);
	return project(read, options);
}

/** The exchange open over the base facts, read from the whole record. */
const open = (read: BaseFacts): ExchangeRef | undefined =>
	openExchange(read.messages, read.closes, [...foldPeople(read.messages).keys()]);

/** Every derived fact, read again from the base facts. */
export function project(read: BaseFacts, options: FoldOptions): RoomState {
	const { messages, closes, leases, composition, deliveries, cancelledAt } = read;
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const pending = pendingWakes(
		messages,
		deliveries,
		leases,
		new Set(roster.map((s) => s.name)),
		options,
		cancelledAt,
	);
	const owed = foldOwed(closes, messages, leases, options, cancelledAt);
	return {
		composition,
		roster,
		reserve: reserveOf(composition, roster),
		people,
		exchange: openExchange(messages, closes, [...people.keys()]),
		closes,
		cancelledAt,
		leases,
		deliveries,
		due: [...pending, ...owed],
		scheduled: foldScheduled(messages, cancelledAt),
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
	};
}

/** The wakes the room owes, from a state's `due`. */
export const pendingOf = (state: Pick<RoomState, 'due'>): PendingActivation[] =>
	state.due.filter((due) => due.source === 'message');

/** The summary drafts the room owes, from a state's `due`. */
export const owedOf = (state: Pick<RoomState, 'due'>): PendingActivation[] =>
	state.due.filter((due) => due.source === 'closed');

/** Every person the record knows, in the order the record met them. */
function foldPeople(messages: readonly Message[]): Map<string, PersonState> {
	let people = new Map<string, PersonState>();
	for (const message of messages) people = advancePeople(people, message, true);
	return people;
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(composition: Composition | undefined, messages: readonly Message[]): Seating[] {
	if (composition === undefined) return [];
	const roster: Seating[] = composition.agents.map((seat) => ({ ...seat }));
	for (const message of messages) {
		if (message.seq > composition.seq) reseat(roster, message);
	}
	return roster;
}

/** The first question a person asked after the last close's `through`, or nothing. */
function openExchange(
	messages: readonly Message[],
	closes: readonly Close[],
	people: readonly string[],
): ExchangeRef | undefined {
	return exchangeAfter(messages, people, closes.at(-1)?.through ?? 0);
}

/** The says that wait to return, folded over the record after the last cancellation. */
function foldScheduled(messages: readonly Message[], cancelledAt: Seq | undefined): ScheduledSay[] {
	let list: ScheduledSay[] = [];
	for (const message of after(messages, cancelledAt)) {
		if (changesScheduled(message)) list = scheduleStep(list, message);
	}
	return list;
}

/** The messages after the last cancellation. A cancellation drops the wakes and the says before it. */
const after = (messages: readonly Message[], cancelledAt: Seq | undefined): Message[] =>
	messages.filter((message) => message.seq > (cancelledAt ?? 0));

/**
 * Every wake a message after the last cancellation decided that no lease
 * has answered, for a seat still on the roster. A seat that left the roster
 * answers no wake.
 */
export function pendingWakes(
	messages: readonly Message[],
	deliveries: ReadonlyMap<Seq, MessageDelivery>,
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
	options: FoldOptions,
	cancelledAt?: Seq,
): PendingWake[] {
	const bySeat = leasesBySeat(leases, roster);
	const pending: PendingWake[] = [];
	for (const message of after(messages, cancelledAt)) {
		const delivery = deliveries.get(message.seq);
		if (delivery === undefined) continue;
		for (const seat of reached(delivery, roster)) {
			if (removedAfter(messages, seat, message.seq)) continue;
			const taken = (bySeat.get(seat) ?? []).filter((lease) => coversAttempt(lease, message.seq));
			const wake = statusOf(message, seat, taken, options);
			if (wake !== undefined) pending.push(wake);
		}
	}
	return pending;
}

/** Every lease a wake claimed, by seat, for the seats on the roster. A close causes no wake. */
function leasesBySeat(
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
): Map<string, LeaseHold[]> {
	const bySeat = new Map<string, LeaseHold[]>();
	for (const lease of leases.values()) {
		const parsed = decodeActivationId(lease.id);
		if (parsed === undefined || parsed.source === 'closed') continue;
		if (!roster.has(parsed.seat)) continue;
		bySeat.set(parsed.seat, [...(bySeat.get(parsed.seat) ?? []), lease]);
	}
	return bySeat;
}

/** The recorded recipients of a message that are on the roster. */
function reached(delivery: MessageDelivery, roster: ReadonlySet<string>): Set<string> {
	return new Set(
		[...delivery.wakes, ...delivery.steers.map((steer) => steer.seat)].filter((seat) =>
			roster.has(seat),
		),
	);
}

/** The summaries still owed, one per close whose verdict names a writer. */
function foldOwed(
	closes: readonly Close[],
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	options: FoldOptions,
	cancelledAt: Seq | undefined,
): Owed[] {
	return closes.flatMap((close) => {
		const completion = summaryCompletion(close, messages, leases, cancelledAt);
		if (completion.status !== 'pending' || completion.writer === undefined) return [];
		return [withAttempts(close, completion.writer, leases, options)];
	});
}

/** The state the room derives: the projection after every entry. */
export const replayState = (entries: readonly Entry[], options: FoldOptions): RoomState =>
	projectState(replay(entries, options));
