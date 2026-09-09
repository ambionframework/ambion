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
import { draftId, isExpired, isLive, parseId, seatOf } from './lease.ts';
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
 * The seats holding a live lease or a pending wake, by name. `sent` names
 * the wakes this room sent that the log does not carry — a retry of a draft
 * — and one of those is live until a lease answers it.
 */
export function liveSeats(
	state: RoomState,
	now: number,
	sent: Iterable<string> = [],
): Map<string, string[]> {
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
	for (const id of sent) {
		if (unanswered(state, id)) add(seatOf(id, assistant), id);
	}
	return live;
}

/** A wake the room sent that no lease answers, for a seat still on the roster, and not pending on the log already. */
function unanswered(state: RoomState, id: string): boolean {
	const seat = seatOf(id, state.composition?.assistant ?? '');
	if (seat === undefined || state.leases.has(id)) return false;
	if (!state.roster.some((s) => s.name === seat)) return false;
	return !state.pending.some((wake) => wake.id === id);
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
	const close = options.stopped ? undefined : closing(state, options.now);
	const sends = options.stopped ? [] : dueWakes(state, close, options);
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
		.map((lease) => ({ id: lease.id, phase: 'ended' as const, reason: 'expired' as const, at }));
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
 * Every wake the room sends now: a pending wake never sent, or sent longer
 * ago than the resend window; the wake a close decided here; and an owed
 * draft whose backoff has passed while the assistant is idle.
 */
function dueWakes(state: RoomState, close: Decision['close'], options: DecideOptions): Send[] {
	const assistant = state.composition?.assistant ?? '';
	const sends = new Map<string, Send>();
	for (const wake of state.pending) {
		if (unsent(wake.id, options)) sends.set(wake.id, { id: wake.id, seat: wake.seat });
	}
	if (close?.wakes?.length) {
		const id = draftId(close.through, 1);
		sends.set(id, { id, seat: assistant });
	}
	if (close === undefined) {
		for (const id of dueDrafts(state, options)) sends.set(id, { id, seat: assistant });
	}
	return [...sends.values()];
}

/** The draft of every owed summary whose backoff has passed, while the assistant is idle. */
function dueDrafts(state: RoomState, options: DecideOptions): string[] {
	const assistant = state.composition?.assistant ?? '';
	if (liveSeats(state, options.now).has(assistant)) return [];
	return state.owed
		.filter((owed) => due(owed, options))
		.map((owed) => draftId(owed.through, owed.attempts + 1))
		.filter((id) => !state.leases.has(id) && unsent(id, options));
}

/** A wake this room never sent, or sent longer ago than the resend window. */
function unsent(id: string, options: DecideOptions): boolean {
	const sent = options.sentAt(id);
	return sent === undefined || options.now - sent >= options.resend;
}

/** An owed draft under the cap whose backoff has passed. */
function due(owed: Owed, options: DecideOptions): boolean {
	if (owed.attempts >= options.attempts) return false;
	return owed.notBefore === undefined || owed.notBefore <= options.now;
}

function nextAlarm(state: RoomState, options: DecideOptions): number | undefined {
	const times = [
		...[...state.leases.values()]
			.filter((lease) => isLive(lease, options.now))
			.map((lease) => lease.expiry ?? 0),
		...state.pending.map((wake) => (options.sentAt(wake.id) ?? options.now) + options.resend),
		...state.owed
			.filter((owed) => owed.attempts < options.attempts)
			.map((owed) => owed.notBefore ?? 0),
	];
	const future = times.filter((at) => at > options.now);
	return future.length === 0 ? undefined : Math.min(...future);
}
