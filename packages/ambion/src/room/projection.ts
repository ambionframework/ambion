/**
 * The room's derived facts as a projection that one entry updates.
 *
 * `foldRoom` replays the whole journal and stays the reference. This file
 * holds the same facts as values. `advance` takes the projection before an
 * entry and returns the projection after it. It builds a new value for each
 * field the entry changes and shares the rest, so a `RoomState` that a caller
 * holds never changes under it. Each derived collection is an index that the
 * entry touches: the people, the roster, the messages after the last close,
 * the wakes still open and the summaries still owed. The rules are the ones
 * the fold runs. This file changes how often they run.
 *
 * The projection is a cache. Nothing writes it to the journal, and a room
 * that resumes rebuilds it by `replay`.
 */

import { decodeActivationId } from '../activation-id.ts';
import type { Close, Composition, Seating } from '../journal/events.ts';
import { type Entry, placed } from '../journal/journal.ts';
import type { ExchangeRef, Message, Seq } from '../types.ts';
import { messageDelivery } from './delivery.ts';
import { exchangeAfter } from './exchange.ts';
import {
	applyEvent,
	type BaseFacts,
	type FoldOptions,
	older,
	type RoomState,
	reseat,
	reserveOf,
} from './fold.ts';
import { applyLease, type LeaseHold } from './lease.ts';
import { judgeOwed, type OwedEntry, type OwedFacts, rejudgeOwed } from './owed.ts';
import { advancePeople, type PersonState } from './presence.ts';
import {
	afterCancellation,
	changesScheduled,
	type ScheduledSay,
	scheduleStep,
} from './scheduled.ts';
import { candidatesOf, dropSeat, pendingOf, rejudgeSeat, type WakeCandidate } from './wakes.ts';

/** Leases of one kind of activation, grouped by a key, then by activation id. */
type LeaseIndex<K> = Map<K, Map<string, LeaseHold>>;

export interface RoomProjection {
	readonly base: BaseFacts;
	readonly people: Map<string, PersonState>;
	readonly roster: Seating[];
	readonly exchange: ExchangeRef | undefined;
	/** The `through` of the last close. */
	readonly boundary: Seq;
	/** The spoken messages and returned says after the boundary: all that can open an exchange. */
	readonly tail: Message[];
	/** The summary and unseated messages, which the summary rules read. */
	readonly record: Message[];
	/** The leases at work. A message steers only these. */
	readonly running: Map<string, LeaseHold>;
	/** The leases a wake claims, by seat. */
	readonly seatLeases: LeaseIndex<string>;
	/** The leases of closing activations, by the position they name. */
	readonly closedLeases: LeaseIndex<Seq>;
	readonly wakes: WakeCandidate[];
	readonly owed: OwedEntry[];
	readonly scheduled: ScheduledSay[];
	readonly lastSeq: Seq;
}

/** How one step runs: the retry policy, and whether the caller alone holds the projection. */
interface Step {
	options: FoldOptions;
	/** True while `replay` builds the projection, so a step may change a container in place. */
	own: boolean;
}

export function emptyProjection(): RoomProjection {
	return {
		base: older(),
		people: new Map(),
		roster: [],
		exchange: undefined,
		boundary: 0,
		tail: [],
		record: [],
		running: new Map(),
		seatLeases: new Map(),
		closedLeases: new Map(),
		wakes: [],
		owed: [],
		scheduled: [],
		lastSeq: 0,
	};
}

/** The projection after every entry, built in place because no one else holds it. */
export function replay(entries: readonly Entry[], options: FoldOptions): RoomProjection {
	let projection = emptyProjection();
	for (const entry of entries) projection = advance(projection, entry, options, true);
	return projection;
}

/** The public state, assembled from a projection. */
export function projectState(projection: RoomProjection): RoomState {
	const { base } = projection;
	const seated = new Set(projection.roster.map((seat) => seat.name));
	const pending = pendingOf(projection.wakes, seated, base.cancelledAt);
	const owed = projection.owed.map((entry) => entry.owed);
	return {
		composition: base.composition,
		roster: projection.roster,
		reserve: reserveOf(base.composition, projection.roster),
		people: projection.people,
		exchange: projection.exchange,
		closes: base.closes,
		cancelledAt: base.cancelledAt,
		cancelClosed: base.cancelClosed,
		leases: base.leases,
		deliveries: base.deliveries,
		pending,
		owed,
		due: [...pending, ...owed],
		scheduled: projection.scheduled,
		messages: base.messages,
		lastSeq: projection.lastSeq,
	};
}

/** One committed entry applied to a projection. */
export function advance(
	projection: RoomProjection,
	entry: Entry,
	options: FoldOptions,
	own = false,
): RoomProjection {
	const step: Step = { options, own };
	switch (entry.kind) {
		case 'message':
			return onMessage(projection, placed(entry), step);
		case 'lease':
			return onLease(projection, entry, step);
		case 'close':
			return onClose(projection, entry.body, step);
		case 'cancel':
			return onCancel(projection, entry, step);
		case 'composition':
			return onComposition(projection, entry);
		default:
			return projection;
	}
}

/** Add one item to a list. The caller that owns the list changes it in place. */
function pushed<T>(items: T[], item: T, own: boolean): T[] {
	if (!own) return [...items, item];
	items.push(item);
	return items;
}

const factsOf = (projection: RoomProjection): OwedFacts => ({
	record: projection.record,
	closedLeases: projection.closedLeases,
	cancelledAt: projection.base.cancelledAt,
});

// -- messages ---------------------------------------------------------------

function onMessage(prev: RoomProjection, message: Message, step: Step): RoomProjection {
	const delivery = messageDelivery(message, prev.running);
	const deliveries = step.own ? prev.base.deliveries : new Map(prev.base.deliveries);
	deliveries.set(message.seq, delivery);
	const base = {
		...prev.base,
		messages: pushed(prev.base.messages, message, step.own),
		deliveries,
	};
	const people = advancePeople(prev.people, message, step.own);
	const noted = notedBy(prev, message, step);
	const projection = { ...prev, ...noted, base, people, roster: rosterAfter(prev, message) };
	return {
		...projection,
		exchange: exchangeOf(projection, prev.exchange, message),
		wakes: [
			...(message.kind === 'unseated' ? dropSeat(prev.wakes, message.subject) : prev.wakes),
			...candidatesOf(message, delivery, prev.seatLeases, step.options),
		],
		owed: owedAfter(projection, message, step),
		scheduled: changesScheduled(message) ? scheduleStep(prev.scheduled, message) : prev.scheduled,
		lastSeq: message.seq,
	};
}

/** The open exchange after a message: only a question, a returned say, or a new person can change it. */
function exchangeOf(
	projection: RoomProjection,
	known: ExchangeRef | undefined,
	message: Message,
): ExchangeRef | undefined {
	const changes =
		message.kind === 'said' || message.kind === 'returned' || message.kind === 'arrived';
	if (!changes) return known;
	return exchangeAfter(projection.tail, [...projection.people.keys()], projection.boundary);
}

/** The tail and the record after a message. */
function notedBy(
	prev: RoomProjection,
	message: Message,
	step: Step,
): { tail: Message[]; record: Message[] } {
	const opens = message.kind === 'said' || message.kind === 'returned';
	const speaks = opens && message.seq > prev.boundary;
	const keeps = message.kind === 'summary' || message.kind === 'unseated';
	return {
		tail: speaks ? pushed(prev.tail, message, step.own) : prev.tail,
		record: keeps ? pushed(prev.record, message, step.own) : prev.record,
	};
}

/** The roster after a message: one seating or unseating splices one seat. */
function rosterAfter(prev: RoomProjection, message: Message): Seating[] {
	const changes = message.kind === 'seated' || message.kind === 'unseated';
	if (!changes || prev.base.composition === undefined) return prev.roster;
	const roster = [...prev.roster];
	reseat(roster, message);
	return roster;
}

/** The owed summaries after a message: a summary or a removal changes the closes it names. */
function owedAfter(projection: RoomProjection, message: Message, step: Step): OwedEntry[] {
	const { owed } = projection;
	if (message.kind === 'summary')
		return rejudgeOwed(owed, () => true, factsOf(projection), step.options);
	if (message.kind !== 'unseated') return owed;
	const removed = (close: Close) => close.summary === message.subject;
	return rejudgeOwed(owed, removed, factsOf(projection), step.options);
}

// -- leases -----------------------------------------------------------------

/** One lease placed in an index. The caller that owns the index changes it in place. */
function leased<K>(index: LeaseIndex<K>, key: K, hold: LeaseHold, own: boolean): LeaseIndex<K> {
	const next = own ? index : new Map(index);
	const inner = own ? (index.get(key) ?? new Map()) : new Map(index.get(key));
	inner.set(hold.id, hold);
	next.set(key, inner);
	return next;
}

function onLease(
	prev: RoomProjection,
	entry: Extract<Entry, { kind: 'lease' }>,
	step: Step,
): RoomProjection {
	const leases = step.own ? prev.base.leases : new Map(prev.base.leases);
	applyLease(leases, entry);
	const hold = leases.get(entry.body.id);
	const base = { ...prev.base, leases };
	const parsed = decodeActivationId(entry.body.id);
	if (hold === undefined || parsed === undefined) return { ...prev, base };
	const running = step.own ? prev.running : new Map(prev.running);
	if (hold.phase === 'running') running.set(hold.id, hold);
	else running.delete(hold.id);
	if (parsed.source === 'closed') {
		const closedLeases = leased(prev.closedLeases, parsed.position, hold, step.own);
		const next = { ...prev, base, running, closedLeases };
		const owed = rejudgeOwed(
			prev.owed,
			(close) => close.through === parsed.position,
			factsOf(next),
			step.options,
		);
		return { ...next, owed };
	}
	const seatLeases = leased(prev.seatLeases, parsed.seat, hold, step.own);
	const wakes = rejudgeSeat(prev.wakes, parsed.seat, seatLeases.get(parsed.seat), step.options);
	return { ...prev, base, running, seatLeases, wakes };
}

/** The lease indexes read again from the leases, after a cancellation changed many at once. */
function indexLeases(
	leases: ReadonlyMap<string, LeaseHold>,
): Pick<RoomProjection, 'running' | 'seatLeases' | 'closedLeases'> {
	const running = new Map<string, LeaseHold>();
	let seatLeases: LeaseIndex<string> = new Map();
	let closedLeases: LeaseIndex<Seq> = new Map();
	for (const hold of leases.values()) {
		if (hold.phase === 'running') running.set(hold.id, hold);
		const parsed = decodeActivationId(hold.id);
		if (parsed === undefined) continue;
		if (parsed.source === 'closed')
			closedLeases = leased(closedLeases, parsed.position, hold, true);
		else seatLeases = leased(seatLeases, parsed.seat, hold, true);
	}
	return { running, seatLeases, closedLeases };
}

// -- closes, cancellations, compositions ------------------------------------

/** A close moves the boundary, drops the messages it covers, and may owe a summary. */
function onClose(prev: RoomProjection, close: Close, step: Step): RoomProjection {
	const closes = pushed(prev.base.closes, close, step.own);
	return closedAt({ ...prev, base: { ...prev.base, closes } }, close, step);
}

function closedAt(projection: RoomProjection, close: Close, step: Step): RoomProjection {
	const tail = projection.tail.filter((message) => message.seq > close.through);
	const judged = judgeOwed(close, factsOf(projection), step.options);
	return {
		...projection,
		boundary: close.through,
		tail,
		exchange: exchangeAfter(tail, [...projection.people.keys()], close.through),
		owed: judged === undefined ? projection.owed : [...projection.owed, judged],
	};
}

type CancelEntry = Extract<Entry, { kind: 'cancel' }>;

/** A cancellation cuts every wake before it and ends the running leases before it. */
function onCancel(prev: RoomProjection, entry: CancelEntry, step: Step): RoomProjection {
	const base: BaseFacts = {
		...prev.base,
		leases: new Map(prev.base.leases),
		closes: [...prev.base.closes],
		cancelClosed: [...prev.base.cancelClosed],
	};
	applyEvent(base, entry);
	const marked = {
		...prev,
		base,
		wakes: [],
		scheduled: afterCancellation(prev.scheduled, entry.seq),
		...indexLeases(base.leases),
	};
	const projection = {
		...marked,
		owed: rejudgeOwed(prev.owed, () => true, factsOf(marked), step.options),
	};
	const { close } = entry.body;
	return close === undefined ? projection : closedAt(projection, close, step);
}

function onComposition(
	prev: RoomProjection,
	entry: Extract<Entry, { kind: 'composition' }>,
): RoomProjection {
	const composition: Composition = { ...entry.body, seq: entry.seq };
	return {
		...prev,
		base: { ...prev.base, composition },
		roster: composition.agents.map((seat) => ({ ...seat })),
	};
}
