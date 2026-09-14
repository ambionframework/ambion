/** The seat protocol translates room decisions into view, commit, and lease responses. */

import type { Committed } from '@ambionframework/journal';
import type { Runtime } from './host/runtime.ts';
import { type Body, placed, type RoomJournal } from './journal/journal.ts';
import { activationSpec } from './room/activation.ts';
import type { RoomState } from './room/fold.ts';
import { isLive, seatOf } from './room/lease.ts';
import type { Refusal } from './room/transition.ts';
import { type RoomFacts, viewOf } from './room/view.ts';
import type { AgentDefinition, Message, SessionEvent } from './types.ts';
import type {
	CommitRequest,
	CommitResult,
	EndReason,
	LeaseRequest,
	LeaseResponse,
	Stale,
	ViewResponse,
} from './wire.ts';

/** A command the room refused, with the wire category that answers it. */
export class RefusedError extends Error {
	constructor(readonly refusal: Refusal) {
		super('reason' in refusal ? refusal.reason : 'The record moved.');
	}
}

const stale = (why: string): Stale => ({ stale: why });

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
	write(commit: CommitRequest): Promise<Committed<Body<Message>, Body<Message>>>;
	claim(id: string): Promise<LeaseResponse>;
	renew(id: string, readThrough?: number): Promise<LeaseResponse>;
	/** End one lease, for whatever reason. Nothing to end is not an error. */
	end(id: string, reason: EndReason, readThrough: number): Promise<boolean>;
	reconcile(): Promise<void>;
}

const now = (room: Answering): number => room.runtime.clock.now();
const onRoster = (state: RoomState, name: string): boolean =>
	state.roster.some((seat) => seat.name === name);

// -- view ---------------------------------------------------------------------

export async function answerView(room: Answering, id: string): Promise<ViewResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const state = room.state();
	const seat = liveSeatOf(room, id, state);
	if (seat === undefined) return stale('the lease ended');
	const spec = activationSpec(id, state);
	if (spec === undefined || spec.seat !== seat) return stale('the activation has no current grant');
	const def = room.definition(seat);
	if (def === undefined) return stale('the seat left the roster');
	return { view: viewOf(spec, def, facts(room, state)) };
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
 * A say commits under `readThrough`, the seq the author has read. The queue
 * refuses a say the record moved past, and the loser is handed what it
 * missed. A summary commits against its fixed closed exchange, so later
 * record entries do not refuse it. A seating also commits without
 * `readThrough`. A lease that ended is answered `stale`, before and where
 * the write happens.
 */
export async function answerCommit(room: Answering, commit: CommitRequest): Promise<CommitResult> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const seat = liveSeatOf(room, commit.activation, room.state());
	if (seat === undefined) return stale('the lease ended');
	try {
		return landed(room, seat, await room.write(commit));
	} catch (error) {
		if (error instanceof RefusedError) return refused(room, seat, error.refusal);
		throw error;
	}
}

function refused(room: Answering, seat: string, refusal: Refusal): CommitResult {
	if (refusal.category === 'missed') {
		room.emit({ type: 'conflict', author: seat, missed: refusal.missed });
		return { missed: refusal.missed };
	}
	return refusal.category === 'stale' ? stale(refusal.reason) : { refused: refusal.reason };
}

/** What the queue did with the commit, as the seat reads it. */
function landed(
	room: Answering,
	seat: string,
	committed: Committed<Body<Message>, Body<Message>>,
): CommitResult {
	if ('missed' in committed) {
		const missed = committed.missed.map(placed);
		room.emit({ type: 'conflict', author: seat, missed });
		return { missed };
	}
	return { committed: placed(committed.entry) };
}

// -- lease --------------------------------------------------------------------

/**
 * A claim, a renewal or a release. A claim or a renewal needs the seat
 * on the roster; a release is answered from the fold, whatever the room's
 * state, and the room hears how the activation went.
 */
export async function answerLease(room: Answering, lease: LeaseRequest): Promise<LeaseResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const seat = seatOf(lease.activation);
	if (seat === undefined || !onRoster(room.state(), seat)) {
		return stale('the seat is not on the roster');
	}
	switch (lease.operation) {
		case 'claim':
			return room.claim(lease.activation);
		case 'renew':
			return room.renew(lease.activation, lease.readThrough);
		case 'release':
			return release(room, lease);
		default:
			return stale('the lease operation is not known');
	}
}

async function release(
	room: Answering,
	lease: Extract<LeaseRequest, { operation: 'release' }>,
): Promise<LeaseResponse> {
	let ended: boolean;
	try {
		ended = await room.end(lease.activation, lease.reason, lease.readThrough);
	} catch (error) {
		if (error instanceof RefusedError) return stale(error.message);
		throw error;
	}
	if (!ended) return stale('the lease ended');
	void room.reconcile();
	return { ok: { expiresAt: now(room), lastSeq: room.journal.lastCommitted } };
}
