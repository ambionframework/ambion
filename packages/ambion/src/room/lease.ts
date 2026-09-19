/**
 * Activations, named by what caused them, and the leases they hold.
 *
 * An activation's id is derived from the journal: what caused it, where the
 * cause sits on the record, the seat's name and the attempt number. Nothing
 * mints an id, so a wake is safe to send twice, a retried commit lands once,
 * and a request from an activation whose lease ended is refused because the
 * fold says so. The id carries the cause, so a reader asks the id what the
 * activation's durable cause, seat, and attempt. `activation.ts` combines
 * those facts with the current composition to derive its authority.
 *
 * A lease has two phases. `running` is a claim or a renewal, with an
 * expiry; `ended` is terminal, with a reason. The last change for an id wins,
 * and an ended lease never runs again.
 *
 * A message reaches a seat two ways: the room names the seats at rest it
 * wakes in `wakes`, and every seat at work hears it as a steer. The journal
 * says which: a lease at work when the message landed holds a change before
 * it and ends, if it ends, after it. A running lease keeps work claimed. A
 * released lease settles only context its executor acknowledged. A renewal
 * extends liveness without advancing that acknowledgment. A lease that
 * expired or failed settles no work. Its words stay on the record, and the
 * seat reads them at the next attempt. The
 * failure counts as one attempt, and the message is pending again for
 * that seat after the backoff, under the next attempt's id, until the
 * cap. The fold reports every wake still pending with its attempts; the
 * room sends it when it is due.
 */

import type { JournalEntry } from '@ambionframework/journal';
import { type ActivationSource, decodeActivationId, encodeActivationId } from '../activation-id.ts';
import type { LeaseChange } from '../journal/events.ts';
import type { EndReason, Message, Seq } from '../types.ts';
import type { MessageDelivery } from './delivery.ts';
import {
	applyChange,
	cameToNothing as cameToNothingRule,
	countsAgainst,
	coversAttempt as coverageRule,
	isExpired as isExpiredRule,
	isLive as isLiveRule,
	latest,
	nextActivationId,
	removedAfter,
	schedule,
	type Taken,
	wakeAnswered,
} from './rules.verified.ts';

/** What the lease entries for one activation fold to. */
type LeaseFact = {
	id: string;
	/** When the last entry was written, ISO. */
	at: string;
	/** When the first entry was written, ISO. */
	claimedAt: string;
	/** The seq where this activation first attempted work. */
	since: Seq;
	/** The highest message position that the executor explicitly consumed. */
	readThrough: Seq;
};

export type LeaseHold =
	| (LeaseFact & {
			phase: 'running';
			/** When a running lease expires, in milliseconds since the epoch. */
			expiresAt: number;
	  })
	| (LeaseFact & {
			phase: 'ended';
			reason: EndReason;
			/** Derived marker for a lease ended by a cancellation projection. */
			cancelled?: true;
			/** The seq when the end landed. */
			until: Seq;
	  });

/**
 * Every lease the changes fold to. The complete journal remains available,
 * so a lease's attempt history is reconstructed directly from its changes.
 */
export function foldLeases(
	changes: readonly JournalEntry<LeaseChange>[],
	held: readonly LeaseHold[] = [],
): Map<string, LeaseHold> {
	const leases = new Map<string, LeaseHold>(held.map((lease) => [lease.id, lease]));
	for (const entry of changes) applyLease(leases, entry);
	return leases;
}

/** Apply one change to a private lease builder. Callers must not share this map. */
export function applyLease(
	leases: Map<string, LeaseHold>,
	{ body: change, seq }: JournalEntry<LeaseChange>,
): void {
	leases.set(change.id, applyChange(leases.get(change.id), change, seq));
}

export const isExpired = (lease: LeaseHold, now: number): boolean =>
	isExpiredRule(lease.phase, lease.phase === 'running' ? lease.expiresAt : 0, now);

/** A lease that holds: running, and not past its expiry. */
export const isLive = (lease: LeaseHold, now: number): boolean =>
	isLiveRule(lease.phase, lease.phase === 'running' ? lease.expiresAt : 0, now);

/**
 * An activation the room owes a seat, and has not had. A message that woke a
 * seat and a close that owes a summary cause one. The room schedules both the
 * same way, so both read as this.
 */
export interface PendingActivation {
	/** The journal fact that gives this activation its identity. */
	source: ActivationSource;
	/** The journal position of the source fact. */
	position: Seq;
	/** The next attempt number. */
	attempt: number;
	/** The id of the next attempt. Nothing mints it: the journal derives it. */
	id: string;
	/** The seat that takes the activation. */
	seat: string;
	/** How many activations took it and came to nothing. */
	unsuccessfulAttempts: number;
	/** When the next attempt may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

/** A wake on the journal that no lease has answered. */
export interface PendingWake extends PendingActivation {
	seq: Seq;
	/** When the message was written, ISO. */
	at: string;
}

/** What the fold needs to schedule an activation the room owes. */
export interface PendingActivationOptions {
	/** How long the room waits before the next attempt, after `attempt` failed ones. */
	backoff(attempt: number): number;
}

/**
 * Every wake a message decided that no lease has answered, for a seat still
 * on the roster. A seat that left the roster answers no wake: what it was
 * sent is not pending.
 */
export function pendingWakes(
	messages: readonly Message[],
	deliveries: ReadonlyMap<Seq, MessageDelivery>,
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
	options: PendingActivationOptions,
): PendingWake[] {
	const bySeat = leasesBySeat(leases, roster);
	const pending: PendingWake[] = [];
	for (const message of messages) {
		const delivery = deliveries.get(message.seq);
		if (delivery === undefined) continue;
		pending.push(...pendingForMessage(message, messages, delivery, bySeat, roster, options));
	}
	return pending;
}

function pendingForMessage(
	message: Message,
	messages: readonly Message[],
	delivery: MessageDelivery,
	bySeat: ReadonlyMap<string, LeaseHold[]>,
	roster: ReadonlySet<string>,
	options: PendingActivationOptions,
): PendingWake[] {
	const pending: PendingWake[] = [];
	for (const seat of reached(delivery, roster)) {
		if (removedAfter(removalsOf(messages, seat), message.seq)) continue;
		const taken = (bySeat.get(seat) ?? []).filter((lease) => coversAttempt(lease, message.seq));
		const wake = statusOf(message, seat, taken, options);
		if (wake !== undefined) pending.push(wake);
	}
	return pending;
}

/** The seqs of every durable removal of this seat. */
export const removalsOf = (messages: readonly Message[], seat: string): number[] =>
	messages.flatMap((message) =>
		message.kind === 'unseated' && message.subject === seat ? [message.seq] : [],
	);

/**
 * Every lease a wake claimed, by seat, for the seats on the roster. A
 * message causes one and an open causes one; a close causes the activation
 * `foldOwed` reads, so this skips it.
 */
function leasesBySeat(
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
): Map<string, LeaseHold[]> {
	const bySeat = new Map<string, LeaseHold[]>();
	for (const lease of leases.values()) {
		const parsed = decodeActivationId(lease.id);
		if (parsed === undefined || parsed.source === 'closed') continue;
		if (!roster.has(parsed.seat)) continue;
		bySeat.set(parsed.seat, [...(bySeat.get(parsed.seat) ?? []), lease]);
	}
	return bySeat;
}

/** Filter recorded recipients by the roster that exists after replay. */
function reached(delivery: MessageDelivery, roster: ReadonlySet<string>): Set<string> {
	return new Set(
		[...delivery.wakes, ...delivery.steers.map((steer) => steer.seat)].filter((seat) =>
			roster.has(seat),
		),
	);
}

/** A lease as the wake rules read it: its phase, reason, acknowledgment, and the position its id names. */
function takenOf(lease: LeaseHold): Taken {
	const position = decodeActivationId(lease.id)?.position ?? 0;
	return lease.phase === 'running'
		? { phase: 'running', readThrough: lease.readThrough, position }
		: { phase: 'ended', reason: lease.reason, readThrough: lease.readThrough, position };
}

/** A lease covers a message while it works, or through the end of its attempted work. */
const coversAttempt = (lease: LeaseHold, seq: Seq): boolean =>
	lease.phase === 'ended' ? coverageRule(true, lease.until, seq) : coverageRule(false, 0, seq);

/**
 * The wake as pending, or nothing when a lease answered it. A wake at the
 * cap is still pending, and carries the attempts that reached it: the room
 * decides what it does about a wake it gave up on.
 */
function statusOf(
	message: Message,
	seat: string,
	taken: readonly LeaseHold[],
	options: PendingActivationOptions,
): PendingWake | undefined {
	// A running lease keeps the work claimed. A completed lease settles it only
	// after the executor recorded explicit progress through this message.
	const covering = taken.map(takenOf);
	if (wakeAnswered(covering, message.seq)) return undefined;
	const failed = taken.filter((lease) => countsAgainst(takenOf(lease), message.seq));
	return {
		...pendingActivation('message', message.seq, seat, failed, options),
		seq: message.seq,
		at: message.at,
	};
}

/**
 * What the room owes, from the attempts that came to nothing: the id the
 * next attempt claims, how many came before it, and when it may start. Both
 * causes fold the same way, so both read this, and the id of every
 * activation the room owes is derived here.
 */
export function pendingActivation(
	source: ActivationSource,
	position: Seq,
	seat: string,
	failed: readonly LeaseHold[],
	options: PendingActivationOptions,
): PendingActivation {
	const unsuccessfulAttempts = failed.length;
	// `Date.parse` stays here: a stamp is a string, outside the rules' envelope.
	const last = latest(
		failed.map((lease) => Date.parse(lease.at)),
		0,
	);
	const plan = schedule(
		unsuccessfulAttempts,
		last,
		unsuccessfulAttempts === 0 ? 0 : options.backoff(unsuccessfulAttempts),
	);
	const next = nextActivationId(source, position, seat, unsuccessfulAttempts);
	return {
		id: encodeActivationId(next),
		...next,
		unsuccessfulAttempts,
		notBefore: plan.notBefore,
	};
}

/** The attempt came to nothing, so the next one is numbered after it. */
export const cameToNothing = (lease: LeaseHold): boolean =>
	lease.phase === 'ended' && cameToNothingRule(lease.reason);

/** The seat an id names, or nothing for an id the room did not derive. */
export const seatOf = (id: string): string | undefined => decodeActivationId(id)?.seat;
