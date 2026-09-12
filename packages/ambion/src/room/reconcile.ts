/**
 * How the room moves: it folds the journal, decides, and writes what it decided.
 *
 * `decide` is pure. It reads the folded state and the clock and returns the
 * entries to write, the wakes to send, and when to look again. Every wake it
 * sends comes off one list, `state.due`: the activations the room owes,
 * whether a message decided one or a close owes one. The room applies
 * a decision, and a second decision over the result writes nothing: that is
 * what makes it safe to run after every commit, every lease change, every
 * alarm and every wake, and after a resume that does not know what the last
 * run got to.
 */

import type { Close, LeaseChange, Without } from '../wire.ts';
import { draftOver } from './assistant.ts';
import type { RoomState } from './fold.ts';
import { type Due, isExpired, isLive, parseId, seatOf, startsNow } from './lease.ts';
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

type Ended = Without<Extract<LeaseChange, { phase: 'ended' }>, 'seq'>;

export interface Decision {
	/** Leases that ran past their expiry, ended here. */
	expired: Ended[];
	/** The attempts the room does not make: the activations at the cap, written off here. */
	abandoned: Ended[];
	/** The exchange the room closes, when nothing is live and one is open. */
	close: Omit<Close, 'seq'> | undefined;
	sends: Send[];
	/** When the room looks again on its own, or undefined when nothing waits on the clock. */
	alarmAt: number | undefined;
}

/**
 * The seats holding a live lease, a pending wake, or a draft that is due,
 * by name, with the ids that make them live.
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
	for (const wake of state.pending) add(wake.seat, wake.id);
	// A draft in its backoff holds nobody: the room is at rest until it is due.
	for (const owed of state.owed) if (startsNow(owed, now)) add(owed.seat, owed.id);
	return live;
}

/**
 * Whether the exchange is still being worked on: a seat that speaks for
 * itself is live, or the assistant is composing. The assistant drafting a
 * summary is not the room still working, so a draft holds no exchange open.
 */
export function working(state: RoomState, now: number): boolean {
	const assistant = state.composition?.assistant.name ?? '';
	for (const [seat, ids] of liveSeats(state, now)) {
		if (seat !== assistant) return true;
		if (ids.some((id) => parseId(id)?.cause === 'message')) return true;
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
 * entry answers the wake or the close it stood for, so the room stops trying
 * and every reader sees that it did.
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

/** The exchange closes when nothing works on it. It names the assistant when it owes a summary. */
function closing(state: RoomState, now: number): Decision['close'] {
	const exchange = state.exchange;
	if (exchange === undefined || working(state, now)) return undefined;
	const assistant = state.composition?.assistant.name ?? '';
	const speaksForItself = (name: string) => !state.people.has(name) && name !== assistant;
	const owed =
		draftOver(state.messages, exchange.from, state.lastSeq, speaksForItself) !== undefined;
	return {
		owner: exchange.owner,
		from: exchange.from,
		through: state.lastSeq,
		at: new Date(now).toISOString(),
		...(owed ? { wakes: [assistant] } : {}),
	};
}

/**
 * Every wake the room sends now: an activation it owes whose backoff has
 * passed, and which this room never sent or sent longer ago than the
 * resend window. A wake a message decided and a draft a close owes are one
 * list here, because the room schedules them the same way.
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
