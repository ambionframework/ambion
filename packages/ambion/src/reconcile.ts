/**
 * How the room moves: it folds the log, decides, and writes what it decided.
 *
 * `decide` is pure. It reads the folded state and the clock and returns the
 * rows to write, the wakes to send, and when to look again. The room applies
 * a decision, and a second decision over the result writes nothing: that is
 * what makes it safe to run after every commit, every lease change, every
 * alarm and every wake, and after a resume that does not know what the last
 * run got to.
 */
import { draftOver } from './assistant.ts';
import type { Owed, RoomState } from './fold.ts';
import { draftId, isExpired, isLive, type PendingWake, parseId, seatOf } from './lease.ts';
import type { CloseRow, LeaseRow, Without } from './wire.ts';

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

interface Send {
	id: string;
	seat: string;
}

type Ended = Without<Extract<LeaseRow, { phase: 'ended' }>, 'after'>;

export interface Decision {
	/** Leases that ran past their expiry, ended here. */
	expired: Ended[];
	/** The attempts the room does not make: wakes and drafts at the cap, written off here. */
	abandoned: Ended[];
	/** The exchange the room closes, when nothing is live and one is open. */
	close: Omit<CloseRow, 'after'> | undefined;
	sends: Send[];
	/** When the room looks again on its own, or undefined when nothing waits on the clock. */
	alarmAt: number | undefined;
}

/**
 * The seats holding a live lease, a pending wake, or a draft that is due,
 * by name, with the ids that make them live.
 */
export function liveSeats(state: RoomState, now: number): Map<string, string[]> {
	const assistant = state.composition?.assistant ?? '';
	const live = new Map<string, string[]>();
	const add = (seat: string | undefined, id: string) => {
		if (seat === undefined) return;
		live.set(seat, [...(live.get(seat) ?? []), id]);
	};
	for (const lease of state.leases.values()) {
		if (isLive(lease, now)) add(seatOf(lease.id, assistant), lease.id);
	}
	for (const wake of state.pending) add(wake.seat, wake.id);
	for (const owed of state.owed) {
		if (due(owed, now)) add(assistant, draftId(owed.through, owed.attempts + 1));
	}
	return live;
}

/**
 * Whether the exchange is still being worked on: a seat that speaks for
 * itself is live, or the assistant is composing. The assistant drafting a
 * summary is not the room still working, so a draft holds no exchange open.
 */
export function working(state: RoomState, now: number): boolean {
	const assistant = state.composition?.assistant ?? '';
	for (const [seat, ids] of liveSeats(state, now)) {
		if (seat !== assistant) return true;
		if (ids.some((id) => parseId(id)?.kind === 'wake')) return true;
	}
	return false;
}

export function decide(state: RoomState, options: DecideOptions): Decision {
	const expired = expiries(state, options.now);
	const abandoned = options.stopped ? [] : abandonments(state, options);
	// An expiry or an abandonment changes what is pending: the close waits for the fold that holds it.
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

/** A wake or a draft whose attempts reached the cap. */
const capped = (attempts: number, options: DecideOptions): boolean => attempts >= options.attempts;

/** The attempt at each wake and each draft at the cap, ended before it starts. */
function abandonments(state: RoomState, options: DecideOptions): Ended[] {
	const at = new Date(options.now).toISOString();
	const abandon = (id: string, heard: number): Ended => ({
		id,
		phase: 'ended',
		reason: 'abandoned',
		heard,
		at,
	});
	return [
		...state.pending
			.filter((wake) => capped(wake.attempts, options))
			.map((wake) => abandon(wake.id, wake.seq)),
		...state.owed
			.filter((owed) => capped(owed.attempts, options))
			.map((owed) => abandon(draftId(owed.through, owed.attempts + 1), owed.through)),
	];
}

function expiries(state: RoomState, now: number): Decision['expired'] {
	const at = new Date(now).toISOString();
	return [...state.leases.values()]
		.filter((lease) => isExpired(lease, now))
		.map((lease) => ({
			id: lease.id,
			phase: 'ended' as const,
			reason: 'expired' as const,
			heard: lease.heard,
			at,
		}));
}

/** The exchange closes when nothing works on it. It names the assistant when it owes a summary. */
function closing(state: RoomState, now: number): Decision['close'] {
	const exchange = state.exchange;
	if (exchange === undefined || working(state, now)) return undefined;
	const assistant = state.composition?.assistant ?? '';
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
 * Every wake the room sends now: a pending wake whose backoff has passed,
 * and an owed draft whose backoff has passed, each one never sent by this
 * room or sent longer ago than the resend window.
 */
function dueWakes(state: RoomState, options: DecideOptions): Send[] {
	const assistant = state.composition?.assistant ?? '';
	const wakes = state.pending
		.filter((wake) => !capped(wake.attempts, options) && ready(wake, options.now))
		.filter((wake) => unsent(wake.id, options))
		.map((wake) => ({ id: wake.id, seat: wake.seat }));
	const drafts = state.owed
		.filter((owed) => !capped(owed.attempts, options) && due(owed, options.now))
		.map((owed) => ({ id: draftId(owed.through, owed.attempts + 1), seat: assistant }))
		.filter((send) => unsent(send.id, options));
	return [...wakes, ...drafts];
}

/** A wake this room never sent, or sent longer ago than the resend window. */
function unsent(id: string, options: DecideOptions): boolean {
	const sent = options.sentAt(id);
	return sent === undefined || options.now - sent >= options.resend;
}

/** A pending wake whose backoff has passed. */
const ready = (wake: PendingWake, now: number): boolean =>
	wake.notBefore === undefined || wake.notBefore <= now;

/** An owed draft whose backoff has passed. The fold holds the cap. */
const due = (owed: Owed, now: number): boolean =>
	owed.notBefore === undefined || owed.notBefore <= now;

/** When each pending wake and each owed draft under the cap is next due, or sent again. */
function retryTimes(state: RoomState, options: DecideOptions): number[] {
	const again = (id: string, notBefore: number | undefined) =>
		notBefore !== undefined && notBefore > options.now
			? notBefore
			: (options.sentAt(id) ?? options.now) + options.resend;
	const wakes = state.pending.filter((wake) => !capped(wake.attempts, options));
	const drafts = state.owed.filter((owed) => !capped(owed.attempts, options));
	return [
		...wakes.map((wake) => again(wake.id, wake.notBefore)),
		...drafts.map((owed) => again(draftId(owed.through, owed.attempts + 1), owed.notBefore)),
	];
}

function nextAlarm(state: RoomState, options: DecideOptions): number | undefined {
	const expiries = [...state.leases.values()]
		.filter((lease) => isLive(lease, options.now))
		.map((lease) => lease.expiry ?? 0);
	const future = [...expiries, ...retryTimes(state, options)].filter((at) => at > options.now);
	return future.length === 0 ? undefined : Math.min(...future);
}
