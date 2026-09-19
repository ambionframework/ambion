/**
 * How the room moves: it folds the journal, decides, and writes what it decided.
 *
 * `decide` is pure. It reads the folded state and the clock and returns the
 * entries to write, the wakes to send, and when to look again. Every wake it
 * sends comes off one list, `state.due`: the activations the room owes,
 * whatever caused each one. Each pass writes what the fold owes after the
 * last, and the loop stops at the pass that writes nothing: that is what
 * makes it safe to run after every commit, every lease change, every alarm
 * and every wake, and after a resume that does not know what the last run
 * got to.
 */

import { decodeActivationId } from '../activation-id.ts';
import type { Close, LeaseChange } from '../journal/events.ts';
import type { RoomState } from './fold.ts';
import {
	isExpired,
	isLive,
	type LeaseHold,
	type PendingActivation,
	removalsOf,
	seatOf,
} from './lease.ts';
import {
	earliestAfter,
	endingOf,
	exchangeLive,
	forgets,
	givesUp,
	type LiveLease,
	looksAgainAt,
	mayClose,
	type OwedActivation,
	onRoster,
	readyToSend,
	removedAfter,
	staleLease,
} from './rules.verified.ts';
import { summaryWriter } from './summary.ts';

export interface ReconcileOptions {
	now: number;
	/** How long an unanswered wake waits before the room sends it again. */
	resend: number;
	/** How many attempts the room makes at one wake or one draft before it gives up. */
	attempts: number;
	/** When this room last sent each wake it waits on. A wake it never sent is absent. */
	sent: ReadonlyMap<string, number>;
	/** A stopped room closes nothing and wakes nobody. */
	stopped: boolean;
}

/** One wake over the wire: the activation, and the seat that takes it. */
interface Send {
	id: string;
	seat: string;
}

type Ended = Extract<LeaseChange, { phase: 'ended' }>;

export interface Reconciliation {
	/** Running leases made stale by a seat's durable removal. */
	revoked: Ended[];
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
 * caused is live. A message causes one. A close is the end of an exchange, so
 * the activation that answers one holds no exchange open — whichever seat
 * holds it.
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
	return {
		seats,
		exchange: exchangeLive(liveLeases(state), owedActivations(state), now),
		rest: seats.size === 0,
	};
}

/** Every lease the room derived an id for, as the liveness rules read it. */
function liveLeases(state: RoomState): LiveLease[] {
	return [...state.leases.values()].flatMap((lease: LeaseHold) => {
		const parsed = decodeActivationId(lease.id);
		if (parsed === undefined) return [];
		return [
			{
				source: parsed.source,
				seat: parsed.seat,
				phase: lease.phase,
				expiresAt: lease.phase === 'running' ? lease.expiresAt : 0,
			},
		];
	});
}

/** Every activation the room owes, as the liveness rules read it. */
function owedActivations(state: RoomState): OwedActivation[] {
	return state.due.map((owed) => ({ source: owed.source, seat: owed.seat }));
}

export function planReconciliation(state: RoomState, options: ReconcileOptions): Reconciliation {
	const work = liveWork(state, options.now);
	const { revoked, expired } = endings(state, options.now);
	const abandoned = options.stopped ? [] : abandonments(state, options);
	// An ending changes what is live: the close waits for the fold that holds it.
	const ended = revoked.length + expired.length + abandoned.length;
	const close = mayClose(options.stopped, ended, state.exchange !== undefined, work.exchange)
		? closing(state, options.now)
		: undefined;
	const sends = options.stopped ? [] : dueWakes(state, options);
	return {
		revoked,
		expired,
		abandoned,
		close,
		sends,
		forget: forgotten(state, options),
		alarmAt: options.stopped ? undefined : nextAlarm(state, options),
	};
}

/**
 * A lease is stale when the room did not derive its id, its seat left the
 * roster, or a removal of its seat landed after its cause. A running lease
 * from before a removal is stale forever. This check is journal-derived so
 * a resumed room repairs a crash between the removal message and the
 * asynchronous cut of the old seat.
 */
function isStale(state: RoomState, id: string): boolean {
	const parsed = decodeActivationId(id);
	const seated = parsed !== undefined && onRoster(state.roster, parsed.seat);
	const removedAfterCause =
		parsed !== undefined && removedAfter(removalsOf(state.messages, parsed.seat), parsed.position);
	return staleLease(parsed !== undefined, seated, removedAfterCause);
}

/** Every lease that ends in this pass, by how it ends. A revocation wins over an expiry. */
function endings(state: RoomState, now: number): { revoked: Ended[]; expired: Ended[] } {
	const at = new Date(now).toISOString();
	const revoked: Ended[] = [];
	const expired: Ended[] = [];
	for (const lease of state.leases.values()) {
		const ending = endingOf(
			lease.phase === 'running',
			isStale(state, lease.id),
			isExpired(lease, now),
		);
		if (ending === 'stays') continue;
		const ended = { id: lease.id, phase: 'ended' as const, at, readThrough: lease.readThrough };
		if (ending === 'revoked') revoked.push({ ...ended, reason: 'revoked' });
		else expired.push({ ...ended, reason: 'expired' });
	}
	return { revoked, expired };
}

/**
 * The wakes the room waited on that the fold no longer says are due. A wake
 * it forgets is one it would send again, so the room holds what it sent for
 * exactly as long as the fold owes the activation.
 */
function forgotten(state: RoomState, options: ReconcileOptions): string[] {
	return forgets(
		[...options.sent.keys()],
		state.due.map((owed) => owed.id),
	);
}

/** An activation the room owes whose attempts reached the cap. */
const capped = (owed: PendingActivation, options: ReconcileOptions): boolean =>
	givesUp(owed.unsuccessfulAttempts, options.attempts);

/**
 * The attempt at each activation at the cap, ended before it starts. The
 * entry answers the wake or the close it stood for, so the room stops trying
 * and every reader sees that it did.
 */
function abandonments(state: RoomState, options: ReconcileOptions): Ended[] {
	const at = new Date(options.now).toISOString();
	return state.due
		.filter((owed) => capped(owed, options))
		.map((owed) => ({
			id: owed.id,
			phase: 'ended' as const,
			reason: 'abandoned' as const,
			at,
			readThrough: 0,
		}));
}

/**
 * The exchange closes when nothing works on it. It names the configured
 * summary writer when the exchange owes a summary. `mayClose` decided the
 * pass; this reads the open exchange it admitted.
 */
function closing(state: RoomState, now: number): Reconciliation['close'] {
	const exchange = state.exchange;
	if (exchange === undefined) return undefined;
	const base = {
		owner: exchange.owner,
		from: exchange.from,
		through: state.lastSeq,
		at: new Date(now).toISOString(),
	};
	const writer = state.people.has(exchange.owner)
		? summaryWriter(state.composition, state.roster)
		: undefined;
	return {
		...base,
		...(writer === undefined ? {} : { summary: writer }),
	};
}

/** The activations the room still tries: what it owes, less what it gave up on. */
const owing = (state: RoomState, options: ReconcileOptions): PendingActivation[] =>
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
function waits(owed: PendingActivation, options: ReconcileOptions) {
	const sent = options.sent.get(owed.id);
	return {
		backedOff: owed.notBefore !== undefined,
		notBefore: owed.notBefore ?? 0,
		wasSent: sent !== undefined,
		sentAt: sent ?? 0,
	};
}

/** Every wake the room sends now: an activation it owes that waits on nothing. */
function dueWakes(state: RoomState, options: ReconcileOptions): Send[] {
	return owing(state, options)
		.filter((owed) => {
			const { backedOff, notBefore, wasSent, sentAt } = waits(owed, options);
			return readyToSend(options.now, backedOff, notBefore, wasSent, sentAt, options.resend);
		})
		.map((owed) => ({ id: owed.id, seat: owed.seat }));
}

/**
 * When the room looks at each activation it owes again. One the room sends
 * this pass waits the resend window, because the send starts that window.
 * The room reads this on the pass that writes nothing and sends nothing, so
 * every activation left is one that waits.
 */
function retryTimes(state: RoomState, options: ReconcileOptions): number[] {
	return owing(state, options).map((owed) => {
		const { backedOff, notBefore, wasSent, sentAt } = waits(owed, options);
		return looksAgainAt(options.now, backedOff, notBefore, wasSent, sentAt, options.resend);
	});
}

function nextAlarm(state: RoomState, options: ReconcileOptions): number | undefined {
	const expiries = [...state.leases.values()].flatMap((lease) =>
		lease.phase === 'running' && isLive(lease, options.now) ? [lease.expiresAt] : [],
	);
	return earliestAfter(options.now, [...expiries, ...retryTimes(state, options)]);
}
