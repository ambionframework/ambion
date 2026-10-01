/** The seat protocol translates room decisions into view, commit, and lease responses. */

import type {
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	Stale,
	ViewResponse,
} from './protocol.ts';
import { seatAuthority } from './room/activation.ts';
import { exchangeSession } from './room/exchange.ts';
import type { RoomState } from './room/fold.ts';
import type { Refusal, ReleaseCommand } from './room/transition.ts';
import { type RoomFacts, type TokenWindow, viewOf } from './room/view.ts';
import { copyMessage, type RoomNotification, type Seq } from './types.ts';

const stale = (why: string): Stale => ({ stale: why });

/**
 * What a seat's three calls need of the room. The room holds every one of
 * them already: nothing here is an answer's own state.
 */
export interface Answering {
	// -- the room as a value --
	readonly name: string;
	/** How much of the record one activation reads. */
	readonly limits: {
		readonly context: { readonly messages: number };
		readonly lease: { readonly deadline: number };
	};
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
	/** The token limit of a seat and its estimator. Absent when the seat sets no limit. */
	tokenWindow(seat: string): TokenWindow | undefined;
	emit(event: RoomNotification): void;
	/** One operation on the room's commit queue, with the wakes the room routes. */
	write(commit: CommitRequest): Promise<CommitResult | { refusal: Refusal }>;
	claim(id: string): Promise<LeaseResponse>;
	renew(id: string, readThrough?: number): Promise<LeaseResponse>;
	/** A seat ends its own lease. Nothing to end is not an error. */
	end(command: ReleaseCommand): Promise<boolean | { refusal: Refusal }>;
	reconcile(): Promise<void>;
}

// -- view ---------------------------------------------------------------------

export async function answerView(
	room: Answering,
	id: string,
	message?: Seq,
): Promise<ViewResponse> {
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const state = room.state();
	const authority = seatAuthority(state, id, room.now());
	if ('stale' in authority) return authority;
	const { spec, lease } = authority;
	const resume = exchangeSession(id, state.closes, state.exchange, state.leases);
	const granted = resume === undefined ? spec : { ...spec, resume };
	const view = viewOf(granted, facts(room, state, spec.seat), message);
	// The room ends the lease on its own clock. The tools of a seat read the wall clock.
	const left = Date.parse(lease.claimedAt) + room.limits.lease.deadline - room.now();
	return { view: { ...view, deadline: Date.now() + left } };
}

/** What a view is built from: the fold, and what the room holds beside it. */
function facts(room: Answering, state: RoomState, seat: string): RoomFacts {
	const tokens = room.tokenWindow(seat);
	return {
		name: room.name,
		now: room.now(),
		state,
		limits: { ...room.limits.context, ...(tokens === undefined ? {} : { tokens }) },
		live: room.live(state),
		messagesSince: (seq) => state.messages.filter((message) => message.seq > seq).length,
	};
}

// -- commit -------------------------------------------------------------------

/**
 * A say commits under `readThrough`, the seq the author has read. The queue
 * refuses a say the record moved past, and the loser is handed what it
 * missed. A scheduled say goes back to its author alone, so the room takes it
 * at any position and hands the author what it landed past. A summary commits
 * against its fixed closed exchange, so later record entries do not refuse
 * it. A seating also commits without
 * `readThrough`. A seat without the authority of its activation is
 * answered `stale`, before and where the write happens. The check before
 * the write is the same `seatAuthority`: a key that the journal already
 * holds returns its entry with no decision, so a retry after the lease
 * ended hears `stale` too.
 */
export async function answerCommit(room: Answering, commit: CommitRequest): Promise<CommitResult> {
	const captured = structuredClone(commit);
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	const authority = seatAuthority(room.state(), captured.activation, room.now());
	if ('stale' in authority) return authority;
	const result = await room.write(captured);
	return 'refusal' in result
		? refused(room, authority.spec.seat, captured.activation, result.refusal)
		: result;
}

function refused(
	room: Answering,
	seat: string,
	activation: string,
	refusal: Refusal,
): CommitResult {
	if (refusal.category === 'missed') {
		const missed = refusal.missed.map(copyMessage);
		room.emit({ type: 'conflict', seat, activation, missed });
		return { missed };
	}
	return refusal.category === 'stale' ? stale(refusal.reason) : { refused: refusal.reason };
}

// -- lease --------------------------------------------------------------------

/**
 * A claim or a renewal requires the grant of the activation, and a release
 * requires the authority of the seat: `decide` checks each where the write
 * lands. The grant holds only for a seat on the roster. A release also
 * checks the authority when the seat asks, as a commit does, so a release
 * behind a write in the queue reads the lease as the seat saw it. Room
 * control ends unclaimed work directly when it revokes or abandons that
 * work.
 */
export async function answerLease(room: Answering, lease: LeaseRequest): Promise<LeaseResponse> {
	const captured = structuredClone(lease);
	if (room.gone()) return stale('the room is gone');
	await room.ready;
	switch (captured.operation) {
		case 'claim':
			return room.claim(captured.activation);
		case 'renew':
			return room.renew(captured.activation, captured.readThrough);
		case 'release':
			return release(room, captured);
		default:
			return stale('the lease operation is not known');
	}
}

async function release(
	room: Answering,
	lease: Extract<LeaseRequest, { operation: 'release' }>,
): Promise<LeaseResponse> {
	const { activation, operation: _operation, ...ending } = lease;
	const authority = seatAuthority(room.state(), activation, room.now());
	if ('stale' in authority) return authority;
	const ended = await room.end({ type: 'release', id: activation, ...ending });
	if (typeof ended !== 'boolean') {
		const refusal = ended.refusal;
		return stale('reason' in refusal ? refusal.reason : 'the lease ended');
	}
	if (!ended) return stale('the lease ended');
	void room.reconcile();
	return { ok: { expiresAt: room.now(), lastSeq: room.state().lastSeq } };
}
