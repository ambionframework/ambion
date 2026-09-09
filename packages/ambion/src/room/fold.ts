/**
 * Every fact about the room, as a fold over the log.
 *
 * The log is the truth, and the room holds no fact beside it: the roster,
 * the reserve, the people, the open exchange, the closes, the leases, the
 * wakes still pending and the summaries still owed are each one function
 * over the entries. A room that replays the log folds the same state the
 * room that wrote it held, which is what lets a room resume where it
 * stopped.
 */

import type { LogEntry } from '../log/log.ts';
import { type Attention, type Exchange, isSummary, type Message, type Seq } from '../types.ts';
import type {
	CheckpointRow,
	CloseRow,
	CompositionRow,
	EndReason,
	LeaseRow,
	SeatRow,
	Without,
} from '../wire.ts';
import { openExchange } from './exchange.ts';
import {
	foldLeases,
	isLive,
	type LeaseState,
	type PendingWake,
	parseId,
	pendingWakes,
	type WakeOptions,
} from './lease.ts';
import { foldPeople, type PersonState } from './presence.ts';

/** One agent on the roster: its name, what wakes it, and whether it is the assistant. */
interface RosterSeat {
	name: string;
	attention: Attention;
	assistant: boolean;
}

/** A summary one person is owed, and how the room has tried to write it. */
export interface Owed {
	person: string;
	/** The earliest question the message must reach back to. */
	from: Seq;
	/** The latest close it stands for. The draft id names this. */
	through: Seq;
	/** Every close the message stands for, by `through`. */
	closes: Seq[];
	/** How many drafts over these closes failed, expired, or were refused. */
	attempts: number;
	/** When the next draft may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

export interface RoomState {
	readonly composition: CompositionRow | undefined;
	readonly roster: RosterSeat[];
	readonly reserve: SeatRow[];
	readonly people: Map<string, PersonState>;
	readonly exchange: Exchange | undefined;
	readonly closes: CloseRow[];
	readonly leases: Map<string, LeaseState>;
	readonly pending: PendingWake[];
	readonly owed: Owed[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
	/** No wake on a message before this seq is pending: the latest checkpoint said so. */
	readonly floor: Seq;
}

/** The retry policy, for wakes and drafts alike: how many attempts, and the wait between them. */
export type FoldOptions = WakeOptions;

/**
 * The entries, sorted by kind. A checkpoint carries the composition, the
 * closes and the leases in place of every row before it, and the floor
 * below which no wake is pending; the messages are kept whatever it says.
 */
function sorted(entries: readonly LogEntry[]) {
	const messages: Message[] = [];
	let closes: CloseRow[] = [];
	let leaseRows: LeaseRow[] = [];
	let composition: CompositionRow | undefined;
	let floor: Seq = 0;
	for (const entry of entries) {
		if (entry.type === 'message') messages.push(entry.message);
		else if (entry.type === 'close') closes.push(entry.close);
		else if (entry.type === 'lease') leaseRows.push(entry.lease);
		else if (entry.type === 'composition') composition = entry.composition;
		else {
			closes = [...entry.checkpoint.closes];
			leaseRows = [...entry.checkpoint.leases];
			composition = entry.checkpoint.composition;
			floor = entry.checkpoint.floor;
		}
	}
	return { messages, closes, leaseRows, composition, floor };
}

export function foldRoom(entries: readonly LogEntry[], options: FoldOptions): RoomState {
	const { messages, closes, leaseRows, composition, floor } = sorted(entries);
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const leases = foldLeases(leaseRows);
	const assistant = composition?.assistant ?? '';
	const isPerson = (name: string) => people.has(name);
	const above = messages.filter((message) => message.seq >= floor);
	return {
		composition,
		roster,
		reserve:
			composition?.available.filter((seat) => !roster.some((s) => s.name === seat.name)) ?? [],
		people,
		exchange: openExchange(messages, closes, isPerson),
		closes,
		leases,
		pending: pendingWakes(above, leases, new Set(roster.map((s) => s.name)), options),
		owed: foldOwed(closes, messages, leases, { assistant, ...options }),
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
		floor,
	};
}

/**
 * The checkpoint that stands for this state: the composition, every close
 * and every lease a later fold still reads, behind the floor. The floor is
 * the earliest seq anything unfinished reaches back to: the open exchange,
 * a wake pending, a draft owed, a lease live. Below it every wake was
 * answered and every close was covered or stood down, so the rows about
 * them can go. The last close stays, whatever the floor: the next exchange
 * opens after it.
 */
export function checkpointOf(
	state: RoomState,
	now: number,
): Without<CheckpointRow, 'after'> | undefined {
	if (state.composition === undefined) return undefined;
	const floor = floorOf(state, now);
	const last = state.closes.at(-1);
	return {
		v: 1,
		floor,
		composition: state.composition,
		closes: state.closes.filter((close) => close.through >= floor || close === last),
		leases: [...state.leases.values()]
			.filter((lease) => reads(lease, floor, now))
			.map((lease) => leaseRow(lease, state.lastSeq)),
		at: new Date(now).toISOString(),
	};
}

/** The earliest seq anything unfinished reaches back to, or past the record when nothing is. */
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

/** A lease a fold above the floor still reads: live, or about a message or a close at the floor or past it. */
function reads(lease: LeaseState, floor: Seq, now: number): boolean {
	return isLive(lease, now) || lease.heard >= floor || named(lease.id) >= floor;
}

/** The seq a lease's id names: the message that woke it, or the close it drafts over. */
function named(id: string): Seq {
	const parsed = parseId(id);
	if (parsed === undefined) return 0;
	return parsed.kind === 'wake' ? parsed.seq : parsed.through;
}

/** The folded lease as one row, carrying when it was first claimed. */
function leaseRow(lease: LeaseState, after: Seq): LeaseRow {
	const shared = { id: lease.id, after, heard: lease.heard, since: lease.since, at: lease.at };
	return lease.phase === 'running'
		? { ...shared, phase: 'running', expiry: lease.expiry ?? 0 }
		: { ...shared, phase: 'ended', reason: lease.reason ?? 'released' };
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(
	composition: CompositionRow | undefined,
	messages: readonly Message[],
): RosterSeat[] {
	if (composition === undefined) return [];
	const roster: RosterSeat[] = [
		...composition.agents.map((seat) => ({ ...seat, assistant: false })),
		{ name: composition.assistant, attention: 'none' as const, assistant: true },
	];
	for (const message of messages) {
		if (message.seq > composition.after) reseat(roster, message);
	}
	return roster;
}

/** One seating or unseating applied to the roster. Any other message changes nothing. */
function reseat(roster: RosterSeat[], message: Message): void {
	if (message.kind !== 'seated' && message.kind !== 'unseated') return;
	const at = roster.findIndex((seat) => seat.name === message.from);
	if (at >= 0) roster.splice(at, 1);
	if (message.kind === 'seated') {
		roster.push({
			name: message.from,
			attention: message.attention ?? 'broadcast',
			assistant: false,
		});
	}
}

interface OwedContext extends WakeOptions {
	assistant: string;
}

const ATTEMPT_REASONS: ReadonlySet<EndReason> = new Set(['failed', 'expired', 'refused']);

/**
 * A draft that ended this way stood down: the assistant judged the room,
 * the host wrote the draft off, or the room gave up at the cap.
 */
const STOOD_DOWN: ReadonlySet<EndReason> = new Set(['released', 'revoked', 'abandoned']);

/**
 * The summaries still owed, one per person. A close owes one when it names
 * the assistant, no summary covers it, and no draft over it or over a later
 * close of the same person stood down. Every later close of the same person
 * joins the draft: the closes fold in log order, so the latest close names
 * the draft, and one message reaches back to the earliest question still
 * owed. The fold reports every draft still owed with its attempts; the
 * room decides the cap, and writes it.
 */
function foldOwed(
	closes: readonly CloseRow[],
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseState>,
	context: OwedContext,
): Owed[] {
	const summaries = messages.filter(isSummary);
	const owing = closes.filter((close) => close.wakes?.includes(context.assistant));
	const open = owing.filter(
		(close) => !summaries.some((s) => covers(s, close)) && !judged(leases, close, owing),
	);
	const byPerson = new Map<string, Owed>();
	for (const close of open) {
		const known = byPerson.get(close.owner);
		byPerson.set(close.owner, {
			person: close.owner,
			from: Math.min(known?.from ?? close.from, close.from),
			through: close.through,
			closes: [...(known?.closes ?? []), close.through],
			attempts: 0,
			notBefore: undefined,
		});
	}
	return [...byPerson.values()].map((owed) => withAttempts(owed, leases, context.backoff));
}

const covers = (summary: Message & { kind: 'summary' }, close: CloseRow): boolean =>
	summary.to === close.owner &&
	summary.covers.from <= close.from &&
	summary.covers.through >= close.through;

/**
 * A draft over this close, or over a later close of the same person, stood
 * down without writing: released, so the assistant judged the room and the
 * judgment stands for everything it read; revoked, so the host wrote the
 * draft off the way `abort()` writes off every wake still pending; or
 * abandoned, so the room gave up at the cap.
 */
function judged(
	leases: ReadonlyMap<string, LeaseState>,
	close: CloseRow,
	closes: readonly CloseRow[],
): boolean {
	const later = new Set(
		closes
			.filter((c) => c.owner === close.owner && c.through >= close.through)
			.map((c) => c.through),
	);
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.kind !== 'draft' || !later.has(parsed.through)) continue;
		if (lease.phase === 'ended' && lease.reason !== undefined && STOOD_DOWN.has(lease.reason)) {
			return true;
		}
	}
	return false;
}

/** How many drafts over these closes came to nothing, and when the next may start. */
function withAttempts(
	owed: Owed,
	leases: ReadonlyMap<string, LeaseState>,
	backoff: (attempt: number) => number,
): Owed {
	const failed = [...leases.values()].filter((lease) => cameToNothing(lease, owed.closes));
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)));
	const attempts = failed.length;
	return { ...owed, attempts, notBefore: attempts === 0 ? undefined : last + backoff(attempts) };
}

/** A draft over one of these closes that ended failed, expired, or refused. */
function cameToNothing(lease: LeaseState, closes: readonly Seq[]): boolean {
	const parsed = parseId(lease.id);
	if (parsed?.kind !== 'draft' || !closes.includes(parsed.through)) return false;
	return lease.phase === 'ended' && lease.reason !== undefined && ATTEMPT_REASONS.has(lease.reason);
}
