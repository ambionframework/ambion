/**
 * Activations, named by what caused them, and the leases they hold.
 *
 * An activation's id is derived from the journal: the seq of the message that
 * woke the seat and the seat's name, or the close it answers and the
 * attempt number. Nothing mints an id, so a wake is safe to send twice, a
 * retried commit lands once, and a request from an activation whose lease
 * ended is refused because the fold says so.
 *
 * A lease has two phases. `running` is a claim or a renewal, with an
 * expiry; `ended` is terminal, with a reason. The last change for an id wins,
 * and an ended lease never runs again.
 *
 * A message reaches a seat two ways: the room names the seats at rest it
 * wakes in `wakes`, and every seat at work hears it as a steer. The journal
 * says which: a lease at work when the message landed holds a change before
 * it and ends, if it ends, after it. A lease answers a message it heard,
 * or that its view held because it was claimed after the message, while
 * it runs and once it ended released, refused or revoked. A lease that
 * stood down answers through the seq its last renewal confirmed, so a
 * message that landed between that renewal and the release is pending
 * for the seat, as a first attempt. A lease that
 * expired or failed answers nothing it heard, whatever it said: its words
 * stay on the record, and the seat reads them at the next attempt. The
 * failure counts as one attempt, and the message is pending again for
 * that seat after the backoff, under the next attempt's id, until the
 * cap. The fold reports every wake still pending with its attempts; the
 * room sends it when it is due.
 */

import type { Entry } from '@ambionframework/journal';
import type { Message, Seq } from '../types.ts';
import type { EndReason, LeaseChange, LeaseHold } from '../wire.ts';
import {
	atWork as atWorkRule,
	expired,
	heard as heardRule,
	nextAttempt,
} from './rules.verified.ts';

/**
 * What caused an activation. A message the room delivered causes one, and a
 * close that owes a summary causes one. The journal holds both, and the
 * room schedules them the same way.
 */
export type Cause = 'message' | 'close';

/**
 * The id of one activation: what caused it, where the cause sits on the
 * record, the seat that takes it, and which attempt this is. One spelling
 * for both causes, so every reader asks the same four questions of it.
 */
export const activationId = (cause: Cause, position: Seq, seat: string, attempt = 1): string =>
	`${cause}:${position}:${seat}:${attempt}`;

/** What an id says about the activation it names. */
export interface ParsedId {
	cause: Cause;
	/** Where the cause sits: the message that woke the seat, or the close's `through`. */
	position: Seq;
	seat: string;
	attempt: number;
}

const ID = /^(message|close):(\d+):([a-z][a-z0-9-]*):(\d+)$/;

/** What an id says caused the activation, or nothing for an id the room did not derive. */
export function parseId(id: string): ParsedId | undefined {
	const parts = ID.exec(id);
	if (parts === null) return undefined;
	return {
		cause: parts[1] as Cause,
		position: Number(parts[2]),
		seat: parts[3] ?? '',
		attempt: Number(parts[4]),
	};
}

/**
 * Every lease the changes fold to. `held` is what a checkpoint carried: the
 * changes after it fold onto those, so a lease the checkpoint holds keeps
 * the seqs and the times its first changes wrote.
 */
export function foldLeases(
	changes: readonly Entry<LeaseChange>[],
	held: readonly LeaseHold[] = [],
): Map<string, LeaseHold> {
	const leases = new Map<string, LeaseHold>(held.map((lease) => [lease.id, lease]));
	for (const { body: change, seq } of changes) {
		const known = leases.get(change.id);
		// Ended is terminal: a renewal that lands after the end changes nothing.
		if (known?.phase === 'ended') continue;
		const since = known?.since ?? seq;
		const claimedAt = known?.claimedAt ?? change.at;
		const heardThrough = change.phase === 'running' ? seq : (known?.heardThrough ?? seq);
		leases.set(
			change.id,
			change.phase === 'running'
				? {
						id: change.id,
						phase: 'running',
						expiry: change.expiry,
						at: change.at,
						claimedAt,
						since,
						heardThrough,
					}
				: {
						id: change.id,
						phase: 'ended',
						reason: change.reason,
						at: change.at,
						claimedAt,
						since,
						until: seq,
						heardThrough,
					},
		);
	}
	return leases;
}

export const isExpired = (lease: LeaseHold, now: number): boolean =>
	lease.phase === 'running' && expired(lease.expiry ?? 0, now);

/** A lease that holds: running, and not past its expiry. */
export const isLive = (lease: LeaseHold, now: number): boolean =>
	lease.phase === 'running' && !isExpired(lease, now);

/**
 * An activation the room owes a seat, and has not had. Two things on the
 * journal cause one: a message that woke a seat and no lease answered, and a
 * close that owes the assistant a summary. The room schedules both the same
 * way, so both read as this.
 */
export interface Due {
	/** The id of the next attempt. Nothing mints it: the journal derives it. */
	id: string;
	/** The seat that takes the activation. */
	seat: string;
	/** How many activations took it and came to nothing. */
	attempts: number;
	/** When the next attempt may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

/** A wake on the journal that no lease has answered. */
export interface PendingWake extends Due {
	seq: Seq;
	/** When the message was written, ISO. */
	at: string;
}

/** Whether the next attempt at this may start: its backoff has passed. */
export const startsNow = (owed: Pick<Due, 'notBefore'>, now: number): boolean =>
	owed.notBefore === undefined || owed.notBefore <= now;

/** What the fold needs to schedule an activation the room owes. */
export interface DueOptions {
	/** How long the room waits before the next attempt, after `attempt` failed ones. */
	backoff(attempt: number): number;
}

/**
 * A lease that ended this way answers nothing it heard. The seat read the
 * record and left nothing anybody can use, so every message it heard is
 * pending again for that seat.
 */
const ANSWERS_NOTHING: ReadonlySet<EndReason> = new Set<EndReason>(['failed', 'expired']);

/**
 * A lease that ended this way took the activation and came to nothing, so
 * the next attempt is numbered after it. It holds `refused` beside the two
 * above: an assistant that ran out of drafts made an attempt, and the range
 * it owes stays owed. A message never ends an activation `refused`, so the
 * two sets differ over the assistant's drafts alone.
 */
const CAME_TO_NOTHING: ReadonlySet<EndReason> = new Set<EndReason>([...ANSWERS_NOTHING, 'refused']);

/**
 * Every wake a message decided that no lease has answered, for a seat still
 * on the roster. A seat that left the roster answers no wake: what it was
 * sent is not pending.
 */
export function pendingWakes(
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
	options: DueOptions,
	assistant: string,
): PendingWake[] {
	const bySeat = leasesBySeat(leases, roster);
	const pending: PendingWake[] = [];
	for (const message of messages) {
		for (const seat of reached(message, bySeat, roster, assistant)) {
			const taken = (bySeat.get(seat) ?? []).filter((lease) => heard(lease, message.seq));
			const wake = statusOf(message, seat, taken, options);
			if (wake !== undefined) pending.push(wake);
		}
	}
	return pending;
}

/** Every lease a wake claimed, by seat, for the seats on the roster. */
function leasesBySeat(
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
): Map<string, LeaseHold[]> {
	const bySeat = new Map<string, LeaseHold[]>();
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.cause !== 'message' || !roster.has(parsed.seat)) continue;
		bySeat.set(parsed.seat, [...(bySeat.get(parsed.seat) ?? []), lease]);
	}
	return bySeat;
}

/**
 * The seats a message reached: the ones it names, and every seat at work
 * when it landed. The assistant composing hears no steer, so a message
 * reaches it by name alone.
 */
function reached(
	message: Message,
	bySeat: ReadonlyMap<string, LeaseHold[]>,
	roster: ReadonlySet<string>,
	assistant: string,
): Set<string> {
	const seats = new Set((message.wakes ?? []).filter((seat) => roster.has(seat)));
	for (const [seat, held] of bySeat) {
		if (seat === message.from || seat === assistant) continue;
		if (held.some((lease) => atWork(lease, message.seq))) seats.add(seat);
	}
	return seats;
}

/** The lease held a change before the message and ended, if it ended, after it. */
const atWork = (lease: LeaseHold, seq: Seq): boolean =>
	atWorkRule(lease.since, lease.until !== undefined, lease.until ?? 0, seq);

/**
 * The lease heard the message. A lease that runs or came to nothing heard
 * every message through its end, whether it was at work for the message or
 * the message landed before it claimed: its view held the record either
 * way. A lease that stood down heard what its last renewal confirmed: a
 * message that landed between that renewal and the release reached no
 * activation.
 *
 * The rule reads `until` alone, because `foldLeases` holds every lease to
 * `until >= since`: an end lands at or after the first change, and `after`
 * only grows.
 */
const heard = (lease: LeaseHold, seq: Seq): boolean =>
	heardRule(
		lease.phase === 'running' || answersNothing(lease),
		lease.until !== undefined,
		lease.until ?? 0,
		lease.heardThrough,
		seq,
	);

/**
 * The wake as pending, or nothing when a lease answered it. A wake at the
 * cap is still pending, and carries the attempts that reached it: the room
 * decides what it does about a wake it gave up on.
 */
function statusOf(
	message: Message,
	seat: string,
	taken: readonly LeaseHold[],
	options: DueOptions,
): PendingWake | undefined {
	// A lease that answered the message settles it, whatever the attempts say.
	if (taken.some((lease) => !answersNothing(lease))) return undefined;
	const failed = taken.filter((lease) => cameToNothing(lease));
	return {
		...dueFrom('message', message.seq, seat, failed, options),
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
export function dueFrom(
	cause: Cause,
	position: Seq,
	seat: string,
	failed: readonly LeaseHold[],
	options: DueOptions,
): Due {
	const attempts = failed.length;
	const attempt = nextAttempt(attempts);
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)));
	return {
		id: activationId(cause, position, seat, attempt),
		seat,
		attempts,
		notBefore: attempts === 0 ? undefined : last + options.backoff(attempts),
	};
}

/** Whether the lease ended for a reason in `reasons`. */
const endedFor = (lease: LeaseHold, reasons: ReadonlySet<EndReason>): boolean =>
	lease.phase === 'ended' && lease.reason !== undefined && reasons.has(lease.reason);

/** The lease answers nothing it heard; every other lease answers all of it. */
const answersNothing = (lease: LeaseHold): boolean => endedFor(lease, ANSWERS_NOTHING);

/** The attempt came to nothing, so the next one is numbered after it. */
export const cameToNothing = (lease: LeaseHold): boolean => endedFor(lease, CAME_TO_NOTHING);

/** The seat an id names, or nothing for an id the room did not derive. */
export const seatOf = (id: string): string | undefined => parseId(id)?.seat;
