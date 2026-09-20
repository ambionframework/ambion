/** The seat protocol translates room decisions into view, commit, and lease responses. */

import type {
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	Stale,
	ViewRange,
	ViewResponse,
} from './protocol.ts';
import { activationSpec } from './room/activation.ts';
import type { RoomState } from './room/fold.ts';
import { isLive, seatOf } from './room/lease.ts';
import type { Refusal } from './room/transition.ts';
import { type RoomFacts, viewOf } from './room/view.ts';
import {
	copyMessage,
	type EndReason,
	type FailureCause,
	type RoomNotification,
	type Usage,
} from './types.ts';

const stale = (why: string): Stale => ({ stale: why });

/**
 * What a seat's three calls need of the room. The room holds every one of
 * them already: nothing here is an answer's own state.
 */
export interface Answering {
	// -- the room as a value --
	readonly name: string;
	now(): number;
	// -- what the room does --
	/** The room answers nothing more: the host stopped it, or it was dropped. */
	gone(): boolean;
	/** The replay and the first reconcile. Every call a seat makes waits here. */
	readonly ready: Promise<void>;
	/** The fold over the journal, as the room caches it. */
	state(): RoomState;
	/** The seats live now, by name, with the ids that make them live. */
	live(state: RoomState): Map<string, string[]>;
	emit(event: RoomNotification): void;
	/** One operation on the room's commit queue, with the wakes the room routes. */
	write(commit: CommitRequest): Promise<CommitResult | { refusal: Refusal }>;
	claim(id: string): Promise<LeaseResponse>;
	renew(id: string, readThrough?: number): Promise<LeaseResponse>;
	/** End one lease, for whatever reason. Nothing to end is not an error. */
	end(
		id: string,
		reason: EndReason,
		readThrough: number,
		cause?: FailureCause,
		usage?: Usage,
	): Promise<boolean | { refusal: Refusal }>;
	reconcile(): Promise<void>;
}

const onRoster = (state: RoomState, name: string): boolean =>
	state.roster.some((seat) => seat.name === name);

// -- view ---------------------------------------------------------------------

export async function answerView(
	room: Answering,
	id: string,
	range?: ViewRange,
): Promise<ViewResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const state = room.state();
	const seat = liveSeatOf(room, id, state);
	if (seat === undefined) return stale('the lease ended');
	const spec = activationSpec(id, state);
	if (spec === undefined || spec.seat !== seat) return stale('the activation has no current grant');
	return { view: viewOf(spec, facts(room, state), range) };
}

/** What a view is built from: the fold, and what the room holds beside it. */
function facts(room: Answering, state: RoomState): RoomFacts {
	return {
		name: room.name,
		now: room.now(),
		state,
		live: room.live(state),
		messagesSince: (seq) => state.messages.filter((message) => message.seq > seq).length,
	};
}

/** The seat holding a live lease under this id, or nothing. */
function liveSeatOf(room: Answering, id: string, state: RoomState): string | undefined {
	const lease = state.leases.get(id);
	if (lease === undefined || !isLive(lease, room.now())) return undefined;
	if (activationSpec(id, state) === undefined) return undefined;
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
	const captured = structuredClone(commit);
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const seat = liveSeatOf(room, captured.activation, room.state());
	if (seat === undefined) return stale('the lease ended');
	const result = await room.write(captured);
	return 'refusal' in result ? refused(room, seat, captured.activation, result.refusal) : result;
}

function refused(
	room: Answering,
	seat: string,
	activation: string,
	refusal: Refusal,
): CommitResult {
	if (refusal.category === 'missed') {
		const missed = refusal.missed.map(copyMessage);
		room.emit({ type: 'conflict', author: seat, activation, missed });
		return { missed };
	}
	return refusal.category === 'stale' ? stale(refusal.reason) : { refused: refusal.reason };
}

// -- lease --------------------------------------------------------------------

/**
 * A claim, renewal, or release requires the seat on the roster. A release
 * requires a live lease and a valid purpose. Room control ends unclaimed
 * work directly when it revokes or abandons that work.
 */
export async function answerLease(room: Answering, lease: LeaseRequest): Promise<LeaseResponse> {
	const captured = structuredClone(lease);
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const state = room.state();
	const seat = seatOf(captured.activation);
	if (seat === undefined || !onRoster(state, seat)) {
		return stale('the seat is not on the roster');
	}
	switch (captured.operation) {
		case 'claim':
			return room.claim(captured.activation);
		case 'renew':
			return room.renew(captured.activation, captured.readThrough);
		case 'release':
			return release(room, captured, state);
		default:
			return stale('the lease operation is not known');
	}
}

async function release(
	room: Answering,
	lease: Extract<LeaseRequest, { operation: 'release' }>,
	state: RoomState,
): Promise<LeaseResponse> {
	if (
		activationSpec(lease.activation, state) === undefined ||
		liveSeatOf(room, lease.activation, state) === undefined
	)
		return stale('the lease ended');
	const ended = await room.end(
		lease.activation,
		lease.reason,
		lease.readThrough,
		lease.cause,
		lease.usage,
	);
	if (typeof ended !== 'boolean') {
		const refusal = ended.refusal;
		return stale('reason' in refusal ? refusal.reason : 'the lease ended');
	}
	if (!ended) return stale('the lease ended');
	void room.reconcile();
	return { ok: { expiresAt: room.now(), lastSeq: room.state().lastSeq } };
}
