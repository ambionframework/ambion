/**
 * How the room moves: it folds the journal, decides, and writes what it decided.
 *
 * `decide` is pure. It reads the folded state and the clock and returns the
 * entries to write, the wakes to send, and when to look again. Every wake it
 * sends comes off one list, `state.due`: the activations the room owes,
 * whatever caused each one. The room applies
 * a decision, and a second decision over the result writes nothing: that is
 * what makes it safe to run after every commit, every lease change, every
 * alarm and every wake, and after a resume that does not know what the last
 * run got to.
 */

import type { Close, LeaseChange } from '../wire.ts';
import { draftOver } from './assistant.ts';
import { answering, type RoomState } from './fold.ts';
import { type Due, isExpired, isLive, parseId, seatOf } from './lease.ts';
import { givesUp } from './rules.verified.ts';

export interface DecideOptions {
	now: number;
	/** How long an unanswered wake waits before the room sends it again. */
	resend: number;
	/** How many attempts the room makes at one wake or one draft before it gives up. */
	attempts: number;
	/** When this room last sent each wake it waits on. A wake it never sent is absent. */
	sent: ReadonlyMap<string, number>;
	/** How many entries the journal has taken since the last checkpoint. */
	sinceCheckpoint: number;
	/** How many entries the journal takes before the room writes the next checkpoint. */
	checkpointEvery: number;
	/** A stopped room closes nothing and wakes nobody. */
	stopped: boolean;
}

/** One wake over the wire: the activation, and the seat that takes it. */
interface Send {
	id: string;
	seat: string;
}

type Ended = Extract<LeaseChange, { phase: 'ended' }>;

export interface Decision {
	/** Leases that ran past their expiry, ended here. */
	expired: Ended[];
	/** The attempts the room does not make: the activations at the cap, written off here. */
	abandoned: Ended[];
	/** The exchange the room closes, when nothing is live and one is open. */
	close: Omit<Close, 'seq'> | undefined;
	sends: Send[];
	/**
	 * Wakes this room waited on and no longer does: nothing the fold says is
	 * due names them. The room drops them from what it has sent.
	 */
	forget: string[];
	/**
	 * The journal has taken enough entries for a checkpoint. The room writes
	 * one where the pass writes nothing else, so it stands for a room at rest.
	 */
	checkpoint: boolean;
	/** When the room looks again on its own, or undefined when nothing waits on the clock. */
	alarmAt: number | undefined;
}

/**
 * The seats holding a live lease or an activation the room owes, by name,
 * with the ids that make them live. An activation holds its seat from the
 * moment the room owes it until the room answers it or gives up on it. A
 * backoff between two attempts is part of that stretch, so a seat waiting
 * out one is live.
 */
function liveSeats(state: RoomState, now: number): Map<string, string[]> {
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
 * What the room works on now. One value answers both questions anybody asks
 * of a room, so the room asks once and the callers read the answer.
 *
 * `exchange` is the narrow one: an activation the exchange's own work
 * caused is live. A message causes one, and the question that opened the
 * exchange causes one. A close is the end of an exchange, so the activation
 * that answers one holds no exchange open — whichever seat holds it.
 *
 * `rest` is the wide one: no activation of any cause is live.
 */
export interface LiveWork {
	/** The seats live now, by name, with the ids that make them live. */
	readonly seats: Map<string, string[]>;
	/** An activation the exchange's own work caused is live. */
	readonly exchange: boolean;
	/** Nothing at all is live. */
	readonly rest: boolean;
}

/** One scan of the folded state and the clock, for every caller that asks. */
export function liveWork(state: RoomState, now: number): LiveWork {
	const seats = liveSeats(state, now);
	const holders = [...seats.values()];
	return {
		seats,
		exchange: holders.some((ids) => ids.some(holdsExchange)),
		rest: seats.size === 0,
	};
}

/** The activation holds an exchange open: a message caused it, or the open did. */
function holdsExchange(id: string): boolean {
	const cause = parseId(id)?.cause;
	return cause === 'message' || cause === 'opened';
}

export function decide(state: RoomState, options: DecideOptions): Decision {
	const work = liveWork(state, options.now);
	const expired = expiries(state, options.now);
	const abandoned = options.stopped ? [] : abandonments(state, options);
	// An expiry or an abandonment changes what is live: the close waits for the fold that holds it.
	const settled = expired.length === 0 && abandoned.length === 0;
	const close = options.stopped || !settled ? undefined : closing(state, work, options.now);
	const sends = options.stopped ? [] : dueWakes(state, options);
	return {
		expired,
		abandoned,
		close,
		sends,
		forget: forgotten(state, options),
		checkpoint: options.sinceCheckpoint >= options.checkpointEvery,
		alarmAt: options.stopped ? undefined : nextAlarm(state, options),
	};
}

/**
 * The wakes the room waited on that the fold no longer says are due. A wake
 * it forgets is one it would send again, so the room holds what it sent for
 * exactly as long as the fold owes the activation.
 */
function forgotten(state: RoomState, options: DecideOptions): string[] {
	const due = new Set(state.due.map((owed) => owed.id));
	return [...options.sent.keys()].filter((id) => !due.has(id));
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

/**
 * The exchange closes when nothing works on it. It names the seat whose role
 * answers `closed`, when the exchange owes a summary. A room with no such
 * seat closes the exchange and owes nothing.
 */
function closing(state: RoomState, work: LiveWork, now: number): Decision['close'] {
	const exchange = state.exchange;
	if (exchange === undefined || work.exchange) return undefined;
	const writer = answering(state.roster, 'closed')?.name;
	const speaksForItself = (name: string) => !state.people.has(name) && name !== writer;
	const owed =
		writer !== undefined &&
		draftOver(state.messages, exchange.from, state.lastSeq, speaksForItself) !== undefined;
	return {
		owner: exchange.owner,
		from: exchange.from,
		through: state.lastSeq,
		at: new Date(now).toISOString(),
		...(owed && writer !== undefined ? { wakes: [writer] } : {}),
	};
}

/** The activations the room still tries: what it owes, less what it gave up on. */
const owing = (state: RoomState, options: DecideOptions): Due[] =>
	state.due.filter((owed) => !capped(owed, options));

/**
 * When the room sends one activation it owes. Two waits stand in front of
 * it, and the later one decides:
 *
 * - A **backoff** after an attempt that came to nothing. The fold reads it
 *   off the journal, so it survives a crash and every room agrees on it.
 * - A **resend window** after a send this room made. It is in memory,
 *   because only this room knows what it sent.
 *
 * A wake a message decided and a draft a close owes wait the same way.
 */
function dueAt(owed: Due, options: DecideOptions): number {
	const backoff = owed.notBefore ?? options.now;
	if (backoff > options.now) return backoff;
	const sent = options.sent.get(owed.id);
	return sent === undefined ? options.now : sent + options.resend;
}

/** Every wake the room sends now: an activation it owes that waits on nothing. */
function dueWakes(state: RoomState, options: DecideOptions): Send[] {
	return owing(state, options)
		.filter((owed) => dueAt(owed, options) <= options.now)
		.map((owed) => ({ id: owed.id, seat: owed.seat }));
}

/**
 * When the room looks at each activation it owes again. One the room sends
 * this pass waits the resend window, because the send starts that window.
 * The room reads this on the pass that writes nothing and sends nothing, so
 * every activation left is one that waits.
 */
function retryTimes(state: RoomState, options: DecideOptions): number[] {
	return owing(state, options).map((owed) => {
		const at = dueAt(owed, options);
		return at > options.now ? at : options.now + options.resend;
	});
}

function nextAlarm(state: RoomState, options: DecideOptions): number | undefined {
	const expiries = [...state.leases.values()]
		.filter((lease) => isLive(lease, options.now))
		.map((lease) => lease.expiry ?? 0);
	const future = [...expiries, ...retryTimes(state, options)].filter((at) => at > options.now);
	return future.length === 0 ? undefined : Math.min(...future);
}
