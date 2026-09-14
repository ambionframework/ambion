/**
 * What the room answers a seat with. A seat reaches its room through three
 * calls — `view` reads what an activation is given, `commit` puts one
 * message on the record, and `lease` claims, renews or releases the
 * activation — and this file holds all three.
 *
 * Every call is a function over `Answering`: what the room holds that an
 * answer reads. Three members are the room as a value — its name, its
 * journal and the runtime it runs in — and nine are behaviours the room
 * owns. The interface is the coupling, written down: a seat's call reaches
 * twelve things, and the room holds the rest where it always did.
 *
 * Nothing here keeps state. What an answer knows, it reads off the fold or
 * off the journal, so two answers in flight read one record.
 */

import type { Committed } from '@ambionframework/journal';
import type { Runtime } from './host/runtime.ts';
import { type Body, placed, type RoomJournal } from './journal/journal.ts';
import type { RoomState } from './room/fold.ts';
import { isLive, seatOf } from './room/lease.ts';
import { type RoomFacts, viewOf } from './room/view.ts';
import type {
	AgentDefinition,
	Message,
	PresenceMessage,
	Seq,
	SessionEvent,
	SpokenMessage,
	SummaryMessage,
} from './types.ts';
import type {
	Commit,
	CommitResponse,
	EndReason,
	Lease,
	LeaseResponse,
	Stale,
	ViewResponse,
} from './wire.ts';

/** A seat asked for something the room refuses, and the seat reads why. */
class RefusedError extends Error {}

/** The lease the request came from is gone, and the answer says so. */
class StaleError extends Error {}

const stale = (why: string): Stale => ({ stale: why });

/** A message before the journal stamps its seq, its key and its wakes. */
type Drafted =
	| Omit<SpokenMessage, 'seq' | 'key' | 'wakes'>
	| Omit<SummaryMessage, 'seq' | 'key' | 'wakes'>
	| Omit<PresenceMessage, 'seq' | 'key' | 'wakes'>;

/**
 * What a seat's three calls need of the room. The room holds every one of
 * them already: nothing here is an answer's own state.
 */
export interface Answering {
	// -- the room as a value --
	readonly name: string;
	readonly journal: RoomJournal;
	readonly runtime: Runtime;
	// -- what the room does --
	/** The room answers nothing more: the host stopped it, or it was dropped. */
	gone(): boolean;
	/** The replay and the first reconcile. Every call a seat makes waits here. */
	readonly ready: Promise<void>;
	/** The fold over the journal, as the room caches it. */
	state(): RoomState;
	/** The seats live now, by name, with the ids that make them live. */
	live(state: RoomState): Map<string, string[]>;
	/** The definition a seat runs, off the names this room knows. */
	definition(seat: string): AgentDefinition | undefined;
	emit(event: SessionEvent): void;
	/** One operation on the room's commit queue, with the wakes the room routes. */
	write<T extends Message>(
		key: string,
		readThrough: Seq | undefined,
		draft: (state: RoomState) => Omit<Body<T>, 'wakes'>,
	): Promise<Committed<Body<T>, Body<Message>>>;
	/** End one lease, for whatever reason. Nothing to end is not an error. */
	end(id: string, reason: EndReason): Promise<boolean>;
	reconcile(): Promise<void>;
}

const now = (room: Answering): number => room.runtime.clock.now();
const iso = (room: Answering): string => new Date(now(room)).toISOString();
const onRoster = (state: RoomState, name: string): boolean =>
	state.roster.some((seat) => seat.name === name);

// -- view ---------------------------------------------------------------------

export async function answerView(room: Answering, id: string): Promise<ViewResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const state = room.state();
	const seat = liveSeatOf(room, id, state);
	if (seat === undefined) return stale('the lease ended');
	const def = room.definition(seat);
	if (def === undefined) return stale('the seat left the roster');
	return { view: viewOf(id, seat, def, facts(room, state)) };
}

/** What a view is built from: the fold, and what the room holds beside it. */
function facts(room: Answering, state: RoomState): RoomFacts {
	return {
		name: room.name,
		now: now(room),
		state,
		live: room.live(state),
		unseen: (since) => room.journal.messages(since).length,
		guidance: (role) => room.runtime.roles.get(role)?.guidance,
	};
}

/** The seat holding a live lease under this id, or nothing. */
function liveSeatOf(room: Answering, id: string, state: RoomState): string | undefined {
	const lease = state.leases.get(id);
	if (lease === undefined || !isLive(lease, now(room))) return undefined;
	const seat = seatOf(id);
	return seat !== undefined && onRoster(state, seat) ? seat : undefined;
}

// -- commit -------------------------------------------------------------------

/**
 * Rule 5 for a say and for a summary: commit under `readThrough`, the seq
 * the author has read. The queue refuses a commit the record moved past,
 * and the loser is handed what it missed. The event names the author, not
 * the seat: a say and a summary are refused the same way. A seating
 * commits under no `readThrough`: it is decided on the question, whatever
 * landed since. A lease that ended is answered `stale`, before and where
 * the write happens.
 */
export async function answerCommit(room: Answering, commit: Commit): Promise<CommitResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const seat = liveSeatOf(room, commit.activation, room.state());
	if (seat === undefined) return stale('the lease ended');
	// Rule 5 comes first: a seat that has not read the record is told what
	// it missed before anything else is checked, so a say at a colleague
	// who left in the meantime reads the departure. The queue runs the same
	// check again where the write happens.
	const missed = unheard(room, commit.readThrough);
	if (missed !== undefined) {
		room.emit({ type: 'conflict', author: seat, missed });
		return { missed };
	}
	try {
		return landed(room, seat, await write(room, commit, seat));
	} catch (error) {
		if (error instanceof StaleError) return stale(error.message);
		if (error instanceof RefusedError) return { refused: error.message };
		throw error;
	}
}

const write = (room: Answering, commit: Commit, seat: string) =>
	room.write<Message>(commit.key, commit.readThrough, (state) => {
		if (liveSeatOf(room, commit.activation, state) === undefined) {
			throw new StaleError('the lease ended');
		}
		return draft(room, commit, seat, state);
	});

/** What the queue did with the commit, as the seat reads it. */
function landed(
	room: Answering,
	seat: string,
	committed: Committed<Body<Message>, Body<Message>>,
): CommitResponse {
	if ('missed' in committed) {
		const missed = committed.missed.map(placed);
		room.emit({ type: 'conflict', author: seat, missed });
		return { missed };
	}
	return { committed: placed(committed.entry) };
}

/** What the record holds past what the author read, or nothing when it read everything. */
function unheard(room: Answering, readThrough: Seq | undefined): Message[] | undefined {
	if (readThrough === undefined || room.journal.lastCommitted <= readThrough) return undefined;
	return room.journal.messages(readThrough);
}

/** The message a seat's intent becomes, with everything the room stamps. */
function draft(room: Answering, commit: Commit, seat: string, state: RoomState): Drafted {
	const intent = commit.intent;
	const stamp = { at: iso(room), activationId: commit.activation };
	if (intent.kind === 'said') {
		assertAddressable(seat, intent.to, state);
		return {
			kind: 'said',
			...stamp,
			from: seat,
			...(intent.to === undefined ? {} : { to: intent.to }),
			text: intent.text,
		};
	}
	if (intent.kind === 'summary') {
		return {
			kind: 'summary',
			...stamp,
			from: seat,
			to: intent.to,
			text: intent.text,
			covers: intent.covers,
		};
	}
	return seating(intent.name, seat, stamp, state);
}

/** The seating one name from the reserve becomes, or the refusal a seat reads. */
function seating(
	name: string,
	seat: string,
	stamp: { at: string; activationId: string },
	state: RoomState,
): Drafted {
	const held = state.reserve.find((s) => s.name === name);
	if (held === undefined) {
		const names = state.reserve.map((s) => s.name);
		throw new RefusedError(
			`'${name}' is not in the reserve. ` +
				(names.length ? `Seat one of: ${names.join(', ')}.` : 'The reserve is empty.'),
		);
	}
	// The roster folds the seating where it lands, before it routes: every
	// seat the seating reaches reads a roster that already agrees with it.
	return {
		kind: 'seated',
		...stamp,
		from: seat,
		subject: held.name,
		identity: held.identity,
		attention: held.attention,
	};
}

function assertAddressable(seat: string, to: string | undefined, state: RoomState): void {
	if (to === undefined) return;
	const target = state.roster.find((s) => s.name === to);
	if (!state.people.has(to) && target === undefined) {
		throw new RefusedError(`Unknown participant '${to}'. Address someone from the roster.`);
	}
	if (to === seat) throw new RefusedError('You cannot address yourself.');
	// A seat at the narrow end wakes for nothing said, so addressing it
	// would leave a message nobody reads. Say it to the room instead.
	if (target?.attention === 'none') {
		throw new RefusedError(
			`'${to}' wakes for nothing said. Say it to the room, or to somebody else.`,
		);
	}
}

// -- lease --------------------------------------------------------------------

/**
 * A claim, a renewal or a release. A claim or a renewal needs the seat
 * on the roster; a release is answered from the fold, whatever the room's
 * state, and the room hears how the activation went.
 */
export async function answerLease(room: Answering, lease: Lease): Promise<LeaseResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const seat = seatOf(lease.activation);
	if (seat === undefined || !onRoster(room.state(), seat)) {
		return stale('the seat is not on the roster');
	}
	return lease.phase === 'running' ? claim(room, lease.activation) : release(room, lease);
}

/**
 * A claim, or a renewal: the lease runs until `expiry`, unless it had
 * ended. A fresh claim is taken only for an activation the fold says is
 * due: the next attempt at a pending wake, or at an owed draft. Anything
 * else was answered already, and a second run of it would answer twice.
 * The clock is read where the change is written: a renewal that waited on
 * the queue is judged against the lease as it stands then. No lease runs
 * past the deadline: the expiry a claim or a renewal takes is capped
 * there, so an activation that runs on expires on the room's alarm.
 */
async function claim(room: Answering, id: string): Promise<LeaseResponse> {
	let expiry = 0;
	const written = await room.journal.write('lease', () => {
		const state = room.state();
		const known = state.leases.get(id);
		const at = now(room);
		if (known === undefined && (room.gone() || !due(state).has(id))) return undefined;
		if (known !== undefined && !isLive(known, at)) return undefined;
		const claimedAt = known === undefined ? at : Date.parse(known.claimedAt);
		const wake = room.runtime.wake;
		expiry = Math.min(at + wake.expiry, claimedAt + wake.deadline);
		return { id, phase: 'running', expiry, at: iso(room) };
	});
	if (!written) return stale('the lease ended');
	return { ok: { expiry, lastSeq: room.journal.lastCommitted } };
}

/** The ids the fold says may claim a fresh lease now. */
const due = (state: RoomState): Set<string> => new Set(state.due.map((owed) => owed.id));

async function release(room: Answering, lease: Lease): Promise<LeaseResponse> {
	const ended = await room.end(lease.activation, lease.reason ?? 'released');
	if (!ended) return stale('the lease ended');
	void room.reconcile();
	return { ok: { expiry: now(room), lastSeq: room.journal.lastCommitted } };
}
