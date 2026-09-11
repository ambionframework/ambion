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

import type { Message, Seq } from '../types.ts';
import type { EndReason, LeaseChange, LeaseHold } from '../wire.ts';
import {
	atWork as atWorkRule,
	expired,
	heard as heardRule,
	nextAttempt,
} from './rules.verified.ts';

/** The id of the activation a message wakes on a seat: the first attempt bare, later ones numbered. */
export const activationId = (seq: Seq, seat: string, attempt = 1): string =>
	attempt === 1 ? `${seq}:${seat}` : `${seq}:${seat}:${attempt}`;

/** The id of the assistant's attempt at the summary a close owes. */
export const draftId = (through: Seq, attempt: number): string => `close:${through}:${attempt}`;

export type ParsedId =
	| { kind: 'wake'; seq: Seq; seat: string; attempt: number }
	| { kind: 'draft'; through: Seq; attempt: number };

/** What an id says caused the activation, or nothing for an id the room did not derive. */
export function parseId(id: string): ParsedId | undefined {
	const draft = /^close:(\d+):(\d+)$/.exec(id);
	if (draft) return { kind: 'draft', through: Number(draft[1]), attempt: Number(draft[2]) };
	const wake = /^(\d+):([a-z][a-z0-9-]*)(?::(\d+))?$/.exec(id);
	if (wake) {
		return {
			kind: 'wake',
			seq: Number(wake[1]),
			seat: wake[2] ?? '',
			attempt: wake[3] === undefined ? 1 : Number(wake[3]),
		};
	}
	return undefined;
}

/**
 * Every lease the changes fold to. `held` is what a checkpoint carried: the
 * changes after it fold onto those, so a lease the checkpoint holds keeps
 * the seqs and the times its first changes wrote.
 */
export function foldLeases(
	changes: readonly LeaseChange[],
	held: readonly LeaseHold[] = [],
): Map<string, LeaseHold> {
	const leases = new Map<string, LeaseHold>(held.map((lease) => [lease.id, lease]));
	for (const change of changes) {
		const known = leases.get(change.id);
		// Ended is terminal: a renewal that lands after the end changes nothing.
		if (known?.phase === 'ended') continue;
		const since = known?.since ?? change.after;
		const claimedAt = known?.claimedAt ?? change.at;
		const heardThrough =
			change.phase === 'running' ? change.after : (known?.heardThrough ?? change.after);
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
						until: change.after,
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

export interface WakeOptions {
	/** How long the room waits before the next attempt, after `attempt` failed ones. */
	backoff(attempt: number): number;
}

/** A lease that ended this way took the wake and came to nothing. */
const CAME_TO_NOTHING: ReadonlySet<EndReason> = new Set(['failed', 'expired']);

/**
 * Every wake a message decided that no lease has answered, for a seat still
 * on the roster. A seat that left the roster answers no wake: what it was
 * sent is not pending.
 */
export function pendingWakes(
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
	options: WakeOptions,
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
		if (parsed?.kind !== 'wake' || !roster.has(parsed.seat)) continue;
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
		lease.phase === 'running' || cameToNothing(lease),
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
	options: WakeOptions,
): PendingWake | undefined {
	if (taken.some((lease) => !cameToNothing(lease))) return undefined;
	const failed = taken.filter((lease) => cameToNothing(lease));
	const attempts = failed.length;
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)));
	return {
		id: activationId(message.seq, seat, nextAttempt(attempts)),
		seat,
		seq: message.seq,
		at: message.at,
		attempts,
		notBefore: attempts === 0 ? undefined : last + options.backoff(attempts),
	};
}

/** A lease that ended this way answers nothing it heard; every other lease answers all of it. */
const cameToNothing = (lease: LeaseHold): boolean =>
	lease.phase === 'ended' && lease.reason !== undefined && CAME_TO_NOTHING.has(lease.reason);

/** The seat an id belongs to: the one it names, or the assistant for a draft. */
export function seatOf(id: string, assistant: string): string | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	return parsed.kind === 'wake' ? parsed.seat : assistant;
}
