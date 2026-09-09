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
	/** How many drafts the room tries for one close. */
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

export interface Decision {
	/** Leases that ran past their expiry, ended here. */
	expired: Without<Extract<LeaseRow, { phase: 'ended' }>, 'after'>[];
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
	// An expiry changes what is pending: the close waits for the fold that holds it.
	const close = options.stopped || expired.length > 0 ? undefined : closing(state, options.now);
	const sends = options.stopped ? [] : dueWakes(state, options);
	return {
		expired,
		close,
		sends,
		alarmAt: options.stopped ? undefined : nextAlarm(state, options),
	};
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
	const sends: Send[] = [];
	for (const wake of state.pending) {
		if (ready(wake, options.now) && unsent(wake.id, options)) {
			sends.push({ id: wake.id, seat: wake.seat });
		}
	}
	for (const owed of state.owed) {
		const id = draftId(owed.through, owed.attempts + 1);
		if (due(owed, options.now) && unsent(id, options)) sends.push({ id, seat: assistant });
	}
	return sends;
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

function nextAlarm(state: RoomState, options: DecideOptions): number | undefined {
	const again = (id: string, notBefore: number | undefined) =>
		notBefore !== undefined && notBefore > options.now
			? notBefore
			: (options.sentAt(id) ?? options.now) + options.resend;
	const times = [
		...[...state.leases.values()]
			.filter((lease) => isLive(lease, options.now))
			.map((lease) => lease.expiry ?? 0),
		...state.pending.map((wake) => again(wake.id, wake.notBefore)),
		...state.owed.map((owed) => again(draftId(owed.through, owed.attempts + 1), owed.notBefore)),
	];
	const future = times.filter((at) => at > options.now);
	return future.length === 0 ? undefined : Math.min(...future);
}
