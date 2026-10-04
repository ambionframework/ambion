/**
 * Activations, named by what caused them, and the leases they hold.
 *
 * An activation's id is derived from the journal: what caused it, where the
 * cause sits on the record, the seat's name and the attempt number. Nothing
 * mints an id, so a wake is safe to send twice, a retried commit lands once,
 * and a request from an activation whose lease ended is refused because the
 * journal says so. The id carries the cause, so a reader asks the id what the
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
 * cap. The projection reports every wake still pending with its attempts; the
 * room sends it when it is due.
 */

import type { Entry } from '@ambionframework/journal';
import { type ActivationSource, decodeActivationId, encodeActivationId } from '../activation-id.ts';
import type { Lease } from '../journal/entries.ts';
import type { Message, MessageSnapshot, Seq, Usage, VendorSession } from '../types.ts';
import {
	applyChange,
	countsAgainst,
	nextActivationId,
	type RuleLease,
	wakeAnswered,
} from './rules.verified.ts';

/** What the lease entries for one activation fold to: the rules' `RuleLease`. */
export type LeaseHold = RuleLease & {
	/** What the activation spent, from the ended entry its driver wrote. */
	readonly usage?: Usage;
	/** The vendor session the ended entry recorded. */
	readonly session?: VendorSession;
};

/**
 * Every lease the changes fold to. The complete journal remains available,
 * so a lease's attempt history is reconstructed directly from its changes.
 */
export function foldLeases(
	changes: readonly Entry<Lease>[],
	held: readonly LeaseHold[] = [],
): Map<string, LeaseHold> {
	const leases = new Map<string, LeaseHold>(held.map((lease) => [lease.id, lease]));
	for (const entry of changes) applyLease(leases, entry);
	return leases;
}

/**
 * Apply one change to a private lease builder. Callers must not share this
 * map. The validator refuses a lease entry whose id the room did not derive,
 * so the fold holds no lease that it cannot decode.
 */
export function applyLease(
	leases: Map<string, LeaseHold>,
	{ body: change, seq }: Entry<Lease>,
): void {
	const activation = decodeActivationId(change.id);
	if (activation === undefined) return;
	const known = leases.get(change.id);
	const next: LeaseHold = applyChange(known, change, seq, activation);
	// An ended lease is final: only the entry that ends it carries usage and session.
	const ending = change.phase === 'ended' && next !== known ? change : undefined;
	leases.set(change.id, {
		...next,
		...(ending?.usage === undefined ? {} : { usage: ending.usage }),
		...(ending?.session === undefined ? {} : { session: ending.session }),
	});
}

/**
 * An activation the room owes a seat, and has not had. A message that woke a
 * seat and a close that owes a summary cause one. The room schedules both the
 * same way, so both read as this.
 */
export interface DueActivation {
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
	/** A failed attempt ended for a permanent cause, so the room abandons it. */
	permanent: boolean;
}

/** A due activation that a message caused, and no lease has answered. */
export interface DueRespond extends DueActivation {
	/** When the message was written, ISO. */
	at: string;
}

/** What the room needs to schedule an activation it owes. */
export interface DueActivationOptions {
	/** How long the room waits before the next attempt, after `attempt` failed ones. */
	backoff(attempt: number): number;
}

/** The seqs of every durable removal of this seat. */
const removalsOf = (messages: readonly MessageSnapshot[], seat: string): number[] =>
	messages.flatMap((message) =>
		message.kind === 'unseated' && message.subject === seat ? [message.seq] : [],
	);

/** A removal of the seat landed after the position, so work caused at or before it is stale. */
export const removedAfter = (
	messages: readonly MessageSnapshot[],
	seat: string,
	seq: number,
): boolean => removalsOf(messages, seat).some((removal) => removal > seq);

/**
 * The activation that a message makes due for a seat, or nothing when a
 * lease answered it. An activation at the cap is still due, and carries the
 * attempts that reached it: the room decides what it does about an
 * activation it gave up on.
 */
export function dueOf(
	message: Pick<Message, 'seq' | 'at'>,
	seat: string,
	taken: readonly LeaseHold[],
	options: DueActivationOptions,
): DueRespond | undefined {
	// A running lease keeps the work claimed. A completed lease settles it only
	// after the executor recorded explicit progress through this message.
	if (wakeAnswered(taken, message.seq)) return undefined;
	const failed = taken.filter((lease) => countsAgainst(lease, message.seq));
	return { ...dueActivation('message', message.seq, seat, failed, options), at: message.at };
}

/**
 * What the room owes, from the attempts that came to nothing: the id the
 * next attempt claims, how many came before it, and when it may start. Both
 * causes fold the same way, so both read this, and the id of every
 * activation the room owes is derived here.
 */
export function dueActivation(
	source: ActivationSource,
	position: Seq,
	seat: string,
	failed: readonly LeaseHold[],
	options: DueActivationOptions,
): DueActivation {
	const unsuccessfulAttempts = failed.length;
	// A stamp `Date.parse` cannot read counts as no time, so the backoff still holds.
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)).filter(Number.isFinite));
	const next = nextActivationId(source, position, seat, unsuccessfulAttempts);
	// A permanent failure stops the retries: no attempt follows it, so any
	// permanent cause among the failures is the last attempt's cause.
	const permanent = failed.some((lease) => lease.phase === 'ended' && lease.cause === 'permanent');
	return {
		id: encodeActivationId(next),
		...next,
		unsuccessfulAttempts,
		notBefore:
			unsuccessfulAttempts === 0 ? undefined : last + options.backoff(unsuccessfulAttempts),
		permanent,
	};
}

/** The seat an id names, or nothing for an id the room did not derive. */
export const seatOf = (id: string): string | undefined => decodeActivationId(id)?.seat;
