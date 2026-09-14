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

import { type Entry, placed } from '../journal/journal.ts';
import {
	type Attention,
	type Exchange,
	type ExchangeEvent,
	isSummary,
	type Message,
	type Seq,
} from '../types.ts';
import type {
	Checkpoint,
	Close,
	Composition,
	EndReason,
	LeaseHold,
	Role,
	Seating,
} from '../wire.ts';
import { openExchange } from './exchange.ts';
import {
	applyLease,
	type CauseOf,
	cameToNothing,
	type Due,
	dueFrom,
	isLive,
	type PendingWake,
	parseId,
	pendingWakes,
} from './lease.ts';
import { foldPeople, type PersonState } from './presence.ts';

/** One agent on the roster: its name, how the room knows it, what wakes it, and its role. */
export interface RosterSeat {
	name: string;
	identity: string;
	attention: Attention;
	role?: Role;
}

/**
 * The seat whose role answers this event, or nothing when no seat on the
 * roster answers it. A room with no such seat answers the event with
 * nothing: it closes an exchange and writes no summary, and it opens one
 * and composes no room.
 *
 * The first seat that answers takes it. Two seats in one role is a roster
 * the room does not need yet, and `planning/backlog.md` holds the question.
 */
export const answering = (
	roster: readonly RosterSeat[],
	event: ExchangeEvent,
): RosterSeat | undefined => roster.find((seat) => seat.role?.answers[event] !== undefined);

/** A summary one person is owed, and how the room has tried to write it. */
interface Owed extends Due {
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
	readonly roster: RosterSeat[];
	readonly reserve: Seating[];
	readonly people: Map<string, PersonState>;
	readonly exchange: Exchange | undefined;
	readonly closes: Close[];
	readonly leases: Map<string, LeaseHold>;
	readonly pending: PendingWake[];
	readonly owed: Owed[];
	/** Every activation the room owes, whatever caused it: the wakes and the drafts as one list. */
	readonly due: Due[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
	/** No wake on a message before this seq is pending: the latest checkpoint said so. */
	readonly floor: Seq;
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
	leases: Map<string, LeaseHold>;
	composition: Composition | undefined;
	floor: Seq;
}

/** The private base facts held by a projection for incremental evolution. */
export const baseOf = (state: RoomState): BaseFacts => ({
	messages: [...state.messages],
	closes: [...state.closes],
	leases: new Map(state.leases),
	composition: state.composition,
	floor: state.floor,
});

/** The empty room facts before the first committed event. */
const older = (): BaseFacts => ({
	messages: [],
	closes: [],
	leases: new Map(),
	composition: undefined,
	floor: 0,
});

/** Applies one committed event to the room facts. */
export function applyEvent(read: BaseFacts, entry: Entry): void {
	if (entry.kind === 'message') {
		read.messages.push(placed(entry));
		return;
	}
	if (entry.kind === 'close') {
		read.closes.push(entry.body);
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
	if (entry.kind === 'checkpoint') {
		read.closes.splice(0, read.closes.length, ...entry.body.closes);
		read.leases.clear();
		for (const lease of entry.body.leases) read.leases.set(lease.id, { ...lease });
		read.composition = entry.body.composition;
		read.floor = entry.body.floor;
	}
}

export function foldRoom(entries: readonly Entry[], options: FoldOptions): RoomState {
	const read = older();
	for (const entry of entries) applyEvent(read, entry);
	return project(read, options);
}

/** Derives all room views from the base facts. */
export function project(read: BaseFacts, options: FoldOptions): RoomState {
	const { messages, closes, leases, composition, floor } = read;
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const isPerson = (name: string) => people.has(name);
	const exchange = openExchange(messages, closes, isPerson);
	// Every wake on a message below the floor was answered when the
	// checkpoint was written, so nothing below it is read for one again.
	const pending = pendingWakes(
		messages.filter((message) => message.seq >= floor),
		leases,
		new Set(roster.map((s) => s.name)),
		options,
		causeOf(answering(roster, 'opened')?.name, opensOf(exchange, closes)),
	);
	const owed = foldOwed(closes, messages, leases, options);
	const state: RoomState = {
		composition,
		roster,
		reserve:
			composition?.available.filter((seat) => !roster.some((s) => s.name === seat.name)) ?? [],
		people,
		exchange,
		closes,
		leases,
		pending,
		owed,
		due: [...pending, ...owed],
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
		floor,
	};
	return state;
}

/** Every question that opened an exchange: the one still open, and every one a close ended. */
const opensOf = (exchange: Exchange | undefined, closes: readonly Close[]): ReadonlySet<Seq> =>
	new Set([...(exchange === undefined ? [] : [exchange.from]), ...closes.map((c) => c.from)]);

/**
 * Why a seat's wake on this message exists. The question that opened an
 * exchange causes the activation of the seat whose role answers `opened`,
 * and every other wake a message causes. The fold decides it once, and the
 * id carries the answer.
 */
const causeOf =
	(composer: string | undefined, opens: ReadonlySet<Seq>): CauseOf =>
	(seat, seq) =>
		seat === composer && opens.has(seq) ? 'opened' : 'message';

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(
	composition: Composition | undefined,
	messages: readonly Message[],
): RosterSeat[] {
	if (composition === undefined) return [];
	const roster: RosterSeat[] = composition.agents.map((seat) => ({ ...seat }));
	for (const message of messages) {
		if (message.seq > composition.seq) reseat(roster, message);
	}
	return roster;
}

/**
 * One seating or unseating applied to the roster. Any other message changes
 * nothing. A seat the room seats while it runs takes no role: a role is a
 * choice the host makes at the composition.
 */
function reseat(roster: RosterSeat[], message: Message): void {
	if (message.kind !== 'seated' && message.kind !== 'unseated') return;
	const at = roster.findIndex((seat) => seat.name === message.subject);
	if (at >= 0) roster.splice(at, 1);
	if (message.kind === 'seated') {
		roster.push({
			name: message.subject,
			identity: message.identity ?? '',
			attention: message.attention ?? 'broadcast',
		});
	}
}

type OwedContext = FoldOptions;

/** The seat a close owes its summary to, or nothing when it owes none. */
const owes = (close: Close): string | undefined => close.wakes?.[0];

/** A draft that ended this way stood down: the assistant judged the room, the host wrote the draft off, or the room gave up. */
const STOOD_DOWN: ReadonlySet<EndReason> = new Set(['released', 'revoked', 'abandoned']);

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
	context: OwedContext,
): Owed[] {
	const summaries = messages.filter(isSummary);
	return closes
		.filter((close) => owes(close) !== undefined)
		.filter(
			(close) => !summaries.some((summary) => covers(summary, close)) && !judged(leases, close),
		)
		.map((close) =>
			withAttempts(
				{
					person: close.owner,
					writer: owes(close) ?? '',
					from: close.from,
					through: close.through,
				},
				leases,
				context,
			),
		);
}

const covers = (summary: Message & { kind: 'summary' }, close: Close): boolean =>
	summary.to === close.owner &&
	summary.covers.from <= close.from &&
	summary.covers.through >= close.through;

/**
 * A draft over this close stood down without writing: released, so the
 * assistant judged this exchange; or revoked, so the host wrote the draft
 * off the way `abort()` writes off every wake still pending.
 */
function judged(leases: ReadonlyMap<string, LeaseHold>, close: Close): boolean {
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.cause !== 'closed' || parsed.position !== close.through) continue;
		if (lease.phase === 'ended' && lease.reason !== undefined && STOOD_DOWN.has(lease.reason)) {
			return true;
		}
	}
	return false;
}

/**
 * What a person is owed, as an activation: how many drafts over these
 * closes came to nothing, when the next may start, and the id it claims.
 */
function withAttempts(
	owed: Omit<Owed, keyof Due>,
	leases: ReadonlyMap<string, LeaseHold>,
	context: OwedContext,
): Owed {
	const failed = [...leases.values()].filter((lease) => draftedOver(lease, owed.through));
	return {
		...owed,
		...dueFrom('closed', owed.through, owed.writer, failed, context),
	};
}

/** A draft over this close that came to nothing. */
function draftedOver(lease: LeaseHold, through: Seq): boolean {
	const parsed = parseId(lease.id);
	if (parsed?.cause !== 'closed' || parsed.position !== through) return false;
	return cameToNothing(lease);
}

/**
 * The checkpoint that stands for this state: the composition, every close
 * and every lease a later fold still reads, behind the floor. The floor is
 * the earliest seq anything unfinished reaches back to: the open exchange,
 * a wake pending, a draft owed, a lease live. Below it every wake was
 * answered and every close was covered or stood down, so the entries about
 * them can go. The last close stays, whatever the floor: the next exchange
 * opens after it. A room with no composition writes no checkpoint, because
 * a fold that reads one reads no roster.
 */
export function checkpointOf(state: RoomState, now: number): Checkpoint | undefined {
	if (state.composition === undefined) return undefined;
	const floor = floorOf(state, now);
	const last = state.closes.at(-1);
	const closes = state.closes.filter((close) => close.through >= floor || close === last);
	const kept = new Set(closes.map((close) => close.through));
	return {
		v: 1,
		floor,
		composition: state.composition,
		closes,
		leases: [...state.leases.values()].filter((lease) => reads(lease, floor, now, kept)),
		at: new Date(now).toISOString(),
	};
}

/** The earliest seq anything the room still owes reaches back to. */
function floorOf(state: RoomState, now: number): Seq {
	const seqs = [
		state.lastSeq + 1,
		...(state.exchange === undefined ? [] : [state.exchange.from]),
		...state.pending.map((wake) => wake.seq),
		...state.owed.map((owed) => owed.from),
		...[...state.leases.values()]
			.filter((lease) => isLive(lease, now))
			.map((lease) => named(lease.id)),
	];
	return Math.min(...seqs);
}

/**
 * Whether a later fold still reads this lease. A lease that holds, or that
 * answers a message above the floor, is read for a wake. A draft is read
 * for a close the checkpoint carries: it says the close stood down, and
 * without it the room would draft over that close again.
 */
function reads(lease: LeaseHold, floor: Seq, now: number, kept: ReadonlySet<Seq>): boolean {
	if (isLive(lease, now) || lease.heardThrough >= floor) return true;
	const parsed = parseId(lease.id);
	if (parsed === undefined) return false;
	return parsed.cause === 'closed' ? kept.has(parsed.position) : parsed.position >= floor;
}

/** The seq an activation's id names: the message that woke it, or the close it answers. */
function named(id: string): Seq {
	const parsed = parseId(id);
	return parsed?.position ?? 0;
}
