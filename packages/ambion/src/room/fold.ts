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

import type { Entry } from '../journal/journal.ts';
import { type Attention, type Exchange, isSummary, type Message, type Seq } from '../types.ts';
import type {
	Checkpoint,
	Close,
	Composition,
	EndReason,
	LeaseChange,
	LeaseHold,
	Seating,
	Without,
} from '../wire.ts';
import { openExchange } from './exchange.ts';
import {
	cameToNothing,
	type Due,
	dueFrom,
	foldLeases,
	isLive,
	type PendingWake,
	parseId,
	pendingWakes,
} from './lease.ts';
import { foldPeople, type PersonState } from './presence.ts';

/** One agent on the roster: its name, how the room knows it, what wakes it, and whether it is the assistant. */
interface RosterSeat {
	name: string;
	identity: string;
	attention: Attention;
	assistant: boolean;
}

/** A summary one person is owed, and how the room has tried to write it. */
interface Owed extends Due {
	person: string;
	/** The seat the close named to write it. */
	writer: string;
	/** The earliest question the message must reach back to. */
	from: Seq;
	/** The latest close it stands for. The draft id names this. */
	through: Seq;
	/** Every close the message stands for, by `through`. */
	covering: Seq[];
}

/** What one person is owed, before the room counts the drafts it has tried. */
type Grouped = Omit<Owed, keyof Due>;

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

/**
 * The entries, sorted by kind. The latest composition stands. A checkpoint
 * carries the composition, the closes and the leases in place of every entry
 * before it, and the floor below which no wake is pending; the messages
 * are kept whatever it says.
 */
function sorted(entries: readonly Entry[]) {
	const messages: Message[] = [];
	let read = older();
	for (const entry of entries) {
		if (entry.kind === 'message') messages.push(entry.body);
		else read = folded(read, entry);
	}
	return { messages, ...read };
}

/** One entry onto what the fold has read. A checkpoint replaces all of it; a run says nothing here. */
function folded(read: Read, entry: Entry): Read {
	if (entry.kind === 'checkpoint') return carried(entry.body);
	if (entry.kind === 'close') read.closes.push(entry.body);
	else if (entry.kind === 'lease') read.changes.push(entry.body);
	else if (entry.kind === 'composition') read.composition = entry.body;
	return read;
}

/** What the entries beside the messages fold to, before the messages join them. */
type Read = ReturnType<typeof older>;

/** What a fold has read so far, before any of it landed. */
const older = () => ({
	closes: [] as Close[],
	changes: [] as LeaseChange[],
	held: [] as LeaseHold[],
	composition: undefined as Composition | undefined,
	floor: 0 as Seq,
});

/** What a checkpoint carries, in place of everything before it. */
const carried = (checkpoint: Checkpoint): Read => ({
	closes: [...checkpoint.closes],
	changes: [],
	held: [...checkpoint.leases],
	composition: checkpoint.composition,
	floor: checkpoint.floor,
});

export function foldRoom(entries: readonly Entry[], options: FoldOptions): RoomState {
	const { messages, closes, changes, held, composition, floor } = sorted(entries);
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const leases = foldLeases(changes, held);
	const assistant = composition?.assistant.name ?? '';
	const isPerson = (name: string) => people.has(name);
	// Every wake on a message below the floor was answered when the
	// checkpoint was written, so nothing below it is read for one again.
	const pending = pendingWakes(
		messages.filter((message) => message.seq >= floor),
		leases,
		new Set(roster.map((s) => s.name)),
		options,
		assistant,
	);
	const owed = foldOwed(closes, messages, leases, options);
	return {
		composition,
		roster,
		reserve:
			composition?.available.filter((seat) => !roster.some((s) => s.name === seat.name)) ?? [],
		people,
		exchange: openExchange(messages, closes, isPerson),
		closes,
		leases,
		pending,
		owed,
		due: [...pending, ...owed],
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
		floor,
	};
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(
	composition: Composition | undefined,
	messages: readonly Message[],
): RosterSeat[] {
	if (composition === undefined) return [];
	const roster: RosterSeat[] = [
		...composition.agents.map((seat) => ({ ...seat, assistant: false })),
		{ ...composition.assistant, assistant: true },
	];
	for (const message of messages) {
		if (message.seq > composition.seq) reseat(roster, message);
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
			identity: message.identity ?? '',
			attention: message.attention ?? 'broadcast',
			assistant: false,
		});
	}
}

type OwedContext = FoldOptions;

/** The seat a close owes its summary to, or nothing when it owes none. */
const owes = (close: Close): string | undefined => close.wakes?.[0];

/** A draft that ended this way stood down: the assistant judged the room, the host wrote the draft off, or the room gave up. */
const STOOD_DOWN: ReadonlySet<EndReason> = new Set(['released', 'revoked', 'abandoned']);

/**
 * The summaries still owed, one per person. A close owes one when it names
 * a seat, no summary covers it, and no draft over it or over a later
 * close of the same person stood down. The close carries the name, so the
 * fold reads who is owed off the record and never off the room. Every later close of the same person
 * joins the draft: the closes fold in journal order, so the latest close names
 * the draft, and one message reaches back to the earliest question still
 * owed. A draft at the cap is still owed here, and carries the attempts
 * that reached it: the room decides what it does about a draft it gave up
 * on, and an entry it writes answers the close.
 */
function foldOwed(
	closes: readonly Close[],
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	context: OwedContext,
): Owed[] {
	const summaries = messages.filter(isSummary);
	const owing = closes.filter((close) => owes(close) !== undefined);
	const open = owing.filter(
		(close) => !summaries.some((s) => covers(s, close)) && !judged(leases, close, owing),
	);
	const byPerson = new Map<string, Grouped>();
	for (const close of open) {
		const known = byPerson.get(close.owner);
		byPerson.set(close.owner, {
			person: close.owner,
			// The latest close names the seat, as it names the draft.
			writer: owes(close) ?? '',
			from: Math.min(known?.from ?? close.from, close.from),
			through: close.through,
			covering: [...(known?.covering ?? []), close.through],
		});
	}
	return [...byPerson.values()].map((grouped) => withAttempts(grouped, leases, context));
}

const covers = (summary: Message & { kind: 'summary' }, close: Close): boolean =>
	summary.to === close.owner &&
	summary.covers.from <= close.from &&
	summary.covers.through >= close.through;

/**
 * A draft over this close, or over a later close of the same person, stood
 * down without writing: released, so the assistant judged the room and the
 * judgment stands for everything it read; or revoked, so the host wrote the
 * draft off the way `abort()` writes off every wake still pending.
 */
function judged(
	leases: ReadonlyMap<string, LeaseHold>,
	close: Close,
	closes: readonly Close[],
): boolean {
	const later = new Set(
		closes
			.filter((c) => c.owner === close.owner && c.through >= close.through)
			.map((c) => c.through),
	);
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.cause !== 'close' || !later.has(parsed.position)) continue;
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
	grouped: Grouped,
	leases: ReadonlyMap<string, LeaseHold>,
	context: OwedContext,
): Owed {
	const failed = [...leases.values()].filter((lease) => draftedOver(lease, grouped.covering));
	return {
		...grouped,
		...dueFrom('close', grouped.through, grouped.writer, failed, context),
	};
}

/** A draft over one of these closes that came to nothing. */
function draftedOver(lease: LeaseHold, covering: readonly Seq[]): boolean {
	const parsed = parseId(lease.id);
	if (parsed?.cause !== 'close' || !covering.includes(parsed.position)) return false;
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
export function checkpointOf(
	state: RoomState,
	now: number,
): Without<Checkpoint, 'seq'> | undefined {
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
	return parsed.cause === 'close' ? kept.has(parsed.position) : parsed.position >= floor;
}

/** The seq an activation's id names: the message that woke it, or the close it answers. */
function named(id: string): Seq {
	const parsed = parseId(id);
	return parsed?.position ?? 0;
}
