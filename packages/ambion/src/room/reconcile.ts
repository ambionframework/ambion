/**
 * How the room moves: it folds the log, decides, and writes what it decided.
 *
 * `decide` is pure. It reads the folded state and the clock and returns what
 * to write, the wakes to send, and when to look again. Every wake it sends
 * comes off one list, `state.due`: the activations the room owes, whatever
 * message caused each one. The room applies a decision, and a second decision
 * over the result writes nothing: that is what makes it safe to run after
 * every commit, every lease change, every alarm and every wake, and after a
 * resume that does not know what the last run got to.
 */

import type { Seq } from '../types.ts';
import type { LeaseRow, Without } from '../wire.ts';
import type { RoomState } from './fold.ts';
import { type Due, drafting, isExpired, isLive, seatOf, startsNow } from './lease.ts';
import { givesUp } from './rules.verified.ts';

export interface DecideOptions {
	now: number;
	/** How long an unanswered wake waits before the room sends it again. */
	resend: number;
	/** How many attempts the room makes at one wake or one draft before it gives up. */
	attempts: number;
	/** When each wake was last sent by this room, or undefined when it never was. */
	sentAt(id: string): number | undefined;
	/** A stopped room closes nothing and wakes nobody. */
	stopped: boolean;
}

/** One wake over the wire: the activation, and the seat that takes it. */
interface Send {
	id: string;
	seat: string;
}

type Ended = Without<Extract<LeaseRow, { phase: 'ended' }>, 'after'>;

/** The exchange the room closes, and the range it turned out to cover. */
export interface Closing {
	owner: string;
	from: Seq;
	through: Seq;
}

export interface Decision {
	/** Leases that ran past their expiry, ended here. */
	expired: Ended[];
	/** The attempts the room does not make: the activations at the cap, written off here. */
	abandoned: Ended[];
	/** The exchange the room closes, when nothing is live and one is open. */
	close: Closing | undefined;
	sends: Send[];
	/** When the room looks again on its own, or undefined when nothing waits on the clock. */
	alarmAt: number | undefined;
}

/**
 * The seats holding a live lease or an activation the room still owes, by
 * name, with the ids that make them live. A seat is live through a backoff
 * too: the room owes the activation, so the room is not at rest, and it says
 * `quiet` only once it owes nothing.
 */
export function liveSeats(state: RoomState, now: number): Map<string, string[]> {
	const live = new Map<string, string[]>();
	const add = (seat: string | undefined, id: string) => {
		if (seat === undefined) return;
		live.set(seat, [...(live.get(seat) ?? []), id]);
	};
	for (const lease of state.leases.values()) {
		if (isLive(lease, now)) add(seatOf(lease.id), lease.id);
	}
	for (const owed of state.due) add(owed.seat, owed.id);
	return live;
}

/**
 * Whether the exchange is still being worked on: any live activation except
 * the assistant's draft. The assistant writing about an exchange is not the
 * room still working on it, so a draft holds no exchange open.
 */
export function working(state: RoomState, now: number): boolean {
	for (const ids of liveSeats(state, now).values()) {
		if (ids.some((id) => !drafting(id, state.messages))) return true;
	}
	return false;
}

export function decide(state: RoomState, options: DecideOptions): Decision {
	const expired = expiries(state, options.now);
	const abandoned = options.stopped ? [] : abandonments(state, options);
	// An expiry or an abandonment changes what is live: the close waits for the fold that holds it.
	const settled = expired.length === 0 && abandoned.length === 0;
	const close = options.stopped || !settled ? undefined : closing(state, options.now);
	const sends = options.stopped ? [] : dueWakes(state, options);
	return {
		expired,
		abandoned,
		close,
		sends,
		alarmAt: options.stopped ? undefined : nextAlarm(state, options),
	};
}

/** An activation the room owes whose attempts reached the cap. */
const capped = (owed: Due, options: DecideOptions): boolean =>
	givesUp(owed.attempts, options.attempts);

/**
 * The attempt at each activation at the cap, ended before it starts. The
 * row answers the message that owed it, so the room stops trying and every
 * reader sees that it did.
 */
function abandonments(state: RoomState, options: DecideOptions): Ended[] {
	const at = new Date(options.now).toISOString();
	return state.due
		.filter((owed) => capped(owed, options))
		.map((owed) => ({ id: owed.id, phase: 'ended' as const, reason: 'abandoned' as const, at }));
}

function expiries(state: RoomState, now: number): Decision['expired'] {
	const at = new Date(now).toISOString();
	return [...state.leases.values()]
		.filter((lease) => isExpired(lease, now))
		.map((lease) => ({ id: lease.id, phase: 'ended' as const, reason: 'expired' as const, at }));
}

/**
 * The exchange closes when nothing works on it, over the range the record
 * reached. Who the close wakes is the room's routing to decide where the
 * close is written, not the decision's.
 */
function closing(state: RoomState, now: number): Closing | undefined {
	const exchange = state.exchange;
	if (exchange === undefined || working(state, now)) return undefined;
	return { owner: exchange.owner, from: exchange.from, through: state.lastSeq };
}

/**
 * Every wake the room sends now: an activation it owes whose backoff has
 * passed, and which this room never sent or sent longer ago than the
 * resend window.
 */
function dueWakes(state: RoomState, options: DecideOptions): Send[] {
	return state.due
		.filter((owed) => !capped(owed, options))
		.filter((owed) => startsNow(owed, options.now) && unsent(owed.id, options))
		.map((owed) => ({ id: owed.id, seat: owed.seat }));
}

/** A wake this room never sent, or sent longer ago than the resend window. */
function unsent(id: string, options: DecideOptions): boolean {
	const sent = options.sentAt(id);
	return sent === undefined || options.now - sent >= options.resend;
}

/** When each activation the room owes is next due, or sent again. */
function retryTimes(state: RoomState, options: DecideOptions): number[] {
	return state.due
		.filter((owed) => !capped(owed, options))
		.map((owed) =>
			startsNow(owed, options.now)
				? (options.sentAt(owed.id) ?? options.now) + options.resend
				: (owed.notBefore ?? options.now),
		);
}

function nextAlarm(state: RoomState, options: DecideOptions): number | undefined {
	const expiries = [...state.leases.values()]
		.filter((lease) => isLive(lease, options.now))
		.map((lease) => lease.expiry ?? 0);
	const future = [...expiries, ...retryTimes(state, options)].filter((at) => at > options.now);
	return future.length === 0 ? undefined : Math.min(...future);
}
