/**
 * Every fact about the room, as a fold over the log.
 *
 * The log is the truth, and the room holds no fact beside it: the roster,
 * the reserve, the people, the open exchange, the closed ones, the leases and
 * the activations still due are each one function over the entries. A room
 * that replays the log folds the same state the room that wrote it held,
 * which is what lets a room resume where it stopped.
 */

import type { LogEntry, Row } from '../log/log.ts';
import {
	type Attention,
	type ClosedMessage,
	type Exchange,
	isClosed,
	type Message,
	type Seq,
} from '../types.ts';
import type {
	CheckpointRow,
	CompositionRow,
	LeaseHold,
	LeaseRow,
	SeatRow,
	Without,
} from '../wire.ts';
import { openExchange } from './exchange.ts';
import { type Due, dueActivations, foldLeases, isLive, type LeaseState, parseId } from './lease.ts';
import { foldPeople, type PersonState } from './presence.ts';

/** One agent on the roster: its name, how the room knows it, what wakes it, and whether it is the assistant. */
interface RosterSeat {
	name: string;
	identity: string;
	attention: Attention;
	assistant: boolean;
}

export interface RoomState {
	readonly composition: CompositionRow | undefined;
	readonly roster: RosterSeat[];
	readonly reserve: SeatRow[];
	readonly people: Map<string, PersonState>;
	readonly exchange: Exchange | undefined;
	/** Every exchange the room has closed, in record order. */
	readonly closes: ClosedMessage[];
	readonly leases: Map<string, LeaseState>;
	/** Every activation the room owes, whatever message caused it. */
	readonly due: Due[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
	/** No activation on a message before this seq is due: the latest checkpoint said so. */
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
 * carries the composition and the leases in place of every row before it,
 * and the floor below which nothing is due; the messages are kept whatever
 * it says, so every closed exchange is still on the record.
 */
function sorted(entries: readonly LogEntry[]) {
	const messages: Message[] = [];
	let rows = older();
	for (const entry of entries) {
		if (entry.type === 'message') messages.push(entry.message);
		else rows = folded(rows, entry);
	}
	return { messages, ...rows };
}

/** One row onto what the fold has read. A checkpoint replaces all of it; a run row says nothing here. */
function folded(rows: Read, row: Row): Read {
	if (row.type === 'checkpoint') return carried(row.checkpoint);
	if (row.type === 'lease') rows.leaseRows.push(row.lease);
	else if (row.type === 'composition') rows.composition = row.composition;
	return rows;
}

/** What the rows fold to, before the messages join them. */
type Read = ReturnType<typeof older>;

/** The rows a fold has read so far, before any of them landed. */
const older = () => ({
	leaseRows: [] as LeaseRow[],
	held: [] as LeaseHold[],
	composition: undefined as CompositionRow | undefined,
	floor: 0 as Seq,
});

/** What a checkpoint carries, in place of every row before it. */
const carried = (checkpoint: CheckpointRow): Read => ({
	leaseRows: [],
	held: [...checkpoint.leases],
	composition: checkpoint.composition,
	floor: checkpoint.floor,
});

export function foldRoom(entries: readonly LogEntry[], options: FoldOptions): RoomState {
	const { messages, leaseRows, held, composition, floor } = sorted(entries);
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const leases = foldLeases(leaseRows, held);
	const assistant = composition?.assistant.name ?? '';
	const seated = new Set(roster.map((seat) => seat.name));
	return {
		composition,
		roster,
		reserve: composition?.available.filter((seat) => !seated.has(seat.name)) ?? [],
		people,
		exchange: openExchange(messages, (name) => people.has(name)),
		closes: messages.filter(isClosed),
		leases,
		// Every activation on a message below the floor was answered when the
		// checkpoint was written, so nothing below it is read for one again.
		due: dueActivations(
			messages.filter((message) => message.seq >= floor),
			leases,
			seated,
			options,
			assistant,
		),
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
		floor,
	};
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(
	composition: CompositionRow | undefined,
	messages: readonly Message[],
): RosterSeat[] {
	if (composition === undefined) return [];
	const roster: RosterSeat[] = [
		...composition.agents.map((seat) => ({ ...seat, assistant: false })),
		{ ...composition.assistant, assistant: true },
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
			identity: message.identity ?? '',
			attention: message.attention ?? 'broadcast',
			assistant: false,
		});
	}
}

/**
 * The checkpoint that stands for this state: the composition, and every
 * lease a later fold still reads, behind the floor. The floor is the
 * earliest seq anything unfinished reaches back to: the open exchange, an
 * activation the room owes, a lease live. Below it every activation was
 * answered, so the rows about them can go, and a close below it is one the
 * room owes nothing for. The messages stay whatever the floor says, so
 * every closed exchange is still on the record and the next exchange still
 * opens after the last close. A room with no composition writes no
 * checkpoint, because a fold that reads one reads no roster.
 */
export function checkpointOf(
	state: RoomState,
	now: number,
): Without<CheckpointRow, 'after'> | undefined {
	if (state.composition === undefined) return undefined;
	const floor = floorOf(state, now);
	return {
		v: 1,
		floor,
		composition: state.composition,
		leases: [...state.leases.values()].filter((lease) => reads(lease, floor, now)),
		at: new Date(now).toISOString(),
	};
}

/** The earliest seq anything the room still owes reaches back to. */
function floorOf(state: RoomState, now: number): Seq {
	const seqs = [
		state.lastSeq + 1,
		...(state.exchange === undefined ? [] : [state.exchange.from]),
		...state.due.map((owed) => owed.seq),
		...[...state.leases.values()]
			.filter((lease) => isLive(lease, now))
			.map((lease) => parseId(lease.id)?.seq ?? 0),
	];
	return Math.min(...seqs);
}

/**
 * Whether a later fold still reads this lease. A lease that holds, or that
 * answers a message above the floor, is read for the activation that
 * message owes. A lease below the floor answers nothing a later fold asks
 * about, because no message below the floor is read for an activation.
 */
function reads(lease: LeaseState, floor: Seq, now: number): boolean {
	if (isLive(lease, now) || lease.heardThrough >= floor) return true;
	return (parseId(lease.id)?.seq ?? 0) >= floor;
}
