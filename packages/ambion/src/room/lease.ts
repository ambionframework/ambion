/**
 * Activations, named by the message that caused them, and the leases they hold.
 *
 * An activation's id is derived from the record: the seq of the message that
 * woke the seat, the seat's name, and the attempt number. Nothing mints an
 * id, so a wake is safe to send twice, a retried commit lands once, and a
 * request from an activation whose lease ended is refused because the fold
 * says so.
 *
 * One message wakes a seat, whatever the message is. A person's question, a
 * colleague's say, somebody arriving, a seating, and the room's own close all
 * reach a seat the same way, so the room owes one kind of activation and
 * schedules it one way. What the activation may do is read off the message
 * that woke it (`view.ts`): a close wakes the assistant, and that activation
 * writes the one message a person reads.
 *
 * A lease has two phases. `running` is a claim or a renewal, with an
 * expiry; `ended` is terminal, with a reason. The last row for an id wins,
 * and an ended lease never runs again.
 *
 * A participant's message reaches a seat two ways: the room names the seats
 * at rest it wakes in `wakes`, and every seat at work hears it as a steer.
 * The log says which: a lease at work when the message landed holds a row
 * before it and ends, if it ends, after it. A lease answers a message it
 * heard, or that its view held because it was claimed after the message,
 * while it runs and once it ended released, revoked or abandoned. A lease
 * that stood down answers through the seq its last renewal confirmed, so a
 * message that landed between that renewal and the release is due for the
 * seat again, as a first attempt.
 *
 * The room's own close steers nobody, so it reaches the assistant it names
 * and no other seat, and only the attempts at that close answer it. A
 * summary that stands for the whole of a close answers it too: that is the
 * one thing the record itself says about an activation, and it is what lets
 * one message cover several closes of the same person.
 *
 * A lease that expired, failed or was refused answers nothing it heard,
 * whatever it said: its words stay on the record, and the seat reads them at
 * the next attempt. The failure counts as one attempt, and the message is
 * due again for that seat after the backoff, under the next attempt's id.
 * The fold reports every activation still due with its attempts, the ones at
 * the cap included; the room decides what it does about an activation it
 * gave up on, and sends the rest when they are due.
 */

import { isClosed, isSummary, type Message, type Seq } from '../types.ts';
import type { EndReason, LeaseHold, LeaseRow } from '../wire.ts';
import { covered } from './exchange.ts';
import {
	atWork as atWorkRule,
	expired,
	heard as heardRule,
	nextAttempt,
} from './rules.verified.ts';

/** The id of the activation a message wakes on a seat: the first attempt bare, later ones numbered. */
export const activationId = (seq: Seq, seat: string, attempt = 1): string =>
	attempt === 1 ? `${seq}:${seat}` : `${seq}:${seat}:${attempt}`;

/** What an id says caused the activation: the message, the seat, and the attempt. */
export interface ParsedId {
	seq: Seq;
	seat: string;
	attempt: number;
}

/** What an id says caused the activation, or nothing for an id the room did not derive. */
export function parseId(id: string): ParsedId | undefined {
	const parsed = /^(\d+):([a-z][a-z0-9-]*)(?::(\d+))?$/.exec(id);
	if (parsed === null) return undefined;
	return {
		seq: Number(parsed[1]),
		seat: parsed[2] ?? '',
		attempt: parsed[3] === undefined ? 1 : Number(parsed[3]),
	};
}

/** The seat an id belongs to, or nothing for an id the room did not derive. */
export const seatOf = (id: string): string | undefined => parseId(id)?.seat;

/** The message that woke this activation, or nothing when the record holds none under the id. */
export const wokenBy = (id: string, messages: readonly Message[]): Message | undefined => {
	const parsed = parseId(id);
	return parsed && messages.find((message) => message.seq === parsed.seq);
};

/**
 * Whether this activation answers a close: the assistant writing the one
 * message a person reads. It is read off the record rather than off the id,
 * because what woke a seat is what its activation is for.
 */
export const drafting = (id: string, messages: readonly Message[]): boolean =>
	wokenBy(id, messages)?.kind === 'closed';

/**
 * The last row for one id: whether it runs, until when, or why it ended,
 * and where on the log. A checkpoint carries these in place of the rows
 * that made them, so the shape is the wire's ([`LeaseHold`](../wire.ts)).
 */
export type LeaseState = LeaseHold;

/**
 * Every lease the rows fold to. `held` is what a checkpoint carried: the
 * rows after it fold onto those, so a lease the checkpoint holds keeps
 * the seqs and the times its first rows wrote.
 */
export function foldLeases(
	rows: readonly LeaseRow[],
	held: readonly LeaseHold[] = [],
): Map<string, LeaseState> {
	const leases = new Map<string, LeaseState>(held.map((lease) => [lease.id, lease]));
	for (const row of rows) {
		const known = leases.get(row.id);
		// Ended is terminal: a renewal that lands after the end changes nothing.
		if (known?.phase === 'ended') continue;
		const since = known?.since ?? row.after;
		const claimedAt = known?.claimedAt ?? row.at;
		const heardThrough = row.phase === 'running' ? row.after : (known?.heardThrough ?? row.after);
		leases.set(
			row.id,
			row.phase === 'running'
				? {
						id: row.id,
						phase: 'running',
						expiry: row.expiry,
						at: row.at,
						claimedAt,
						since,
						heardThrough,
					}
				: {
						id: row.id,
						phase: 'ended',
						reason: row.reason,
						at: row.at,
						claimedAt,
						since,
						until: row.after,
						heardThrough,
					},
		);
	}
	return leases;
}

export const isExpired = (lease: LeaseState, now: number): boolean =>
	lease.phase === 'running' && expired(lease.expiry ?? 0, now);

/** A lease that holds: running, and not past its expiry. */
export const isLive = (lease: LeaseState, now: number): boolean =>
	lease.phase === 'running' && !isExpired(lease, now);

/**
 * An activation the room owes a seat, and has not had. One message on the
 * record causes it, and the message says what it is for.
 */
export interface Due {
	/** The id of the next attempt. Nothing mints it: the record derives it. */
	id: string;
	/** The seat that takes the activation. */
	seat: string;
	/** The message that caused it. */
	seq: Seq;
	/** When that message was written, ISO. */
	at: string;
	/** How many activations took it and came to nothing. */
	attempts: number;
	/** When the next attempt may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

/** Whether the next attempt at this may start: its backoff has passed. */
export const startsNow = (owed: Pick<Due, 'notBefore'>, now: number): boolean =>
	owed.notBefore === undefined || owed.notBefore <= now;

export interface WakeOptions {
	/** How long the room waits before the next attempt, after `attempt` failed ones. */
	backoff(attempt: number): number;
}

/** A lease that ended this way took the activation and came to nothing. */
const CAME_TO_NOTHING: ReadonlySet<EndReason> = new Set(['failed', 'expired', 'refused']);

/**
 * Every activation a message decided that no lease has answered, for a seat
 * still on the roster. A seat that left the roster answers nothing: what it
 * was sent is no longer due.
 */
export function dueActivations(
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseState>,
	roster: ReadonlySet<string>,
	options: WakeOptions,
	assistant: string,
): Due[] {
	const bySeat = leasesBySeat(leases, roster);
	const done = settled(messages);
	const due: Due[] = [];
	for (const message of messages) {
		if (done(message)) continue;
		for (const seat of reached(message, bySeat, roster, assistant)) {
			const owed = statusOf(message, seat, standing(message, bySeat.get(seat) ?? []), options);
			if (owed !== undefined) due.push(owed);
		}
	}
	return due;
}

/**
 * Whether the record already holds what a message asked for. A close asks the
 * assistant for the one message its person reads, so a summary that stands
 * for the whole of that close answers it, whichever draft wrote the summary:
 * a draft widens its range when the room moves, so one message can answer
 * several closes. Nothing else a message asks for is on the record, and only
 * a lease answers it.
 */
function settled(messages: readonly Message[]): (message: Message) => boolean {
	const summaries = messages.filter(isSummary);
	return (message) => isClosed(message) && summaries.some((summary) => covered(summary, message));
}

/** Every lease an activation claimed, by seat, for the seats on the roster. */
function leasesBySeat(
	leases: ReadonlyMap<string, LeaseState>,
	roster: ReadonlySet<string>,
): Map<string, LeaseState[]> {
	const bySeat = new Map<string, LeaseState[]>();
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed === undefined || !roster.has(parsed.seat)) continue;
		bySeat.set(parsed.seat, [...(bySeat.get(parsed.seat) ?? []), lease]);
	}
	return bySeat;
}

/**
 * The seats a message reached: the ones it names, and every seat at work
 * when it landed. The room's own close steers nobody, so it reaches the
 * assistant it names and no other seat. The assistant composing hears no
 * steer either, so a message reaches it by name alone.
 */
function reached(
	message: Message,
	bySeat: ReadonlyMap<string, LeaseState[]>,
	roster: ReadonlySet<string>,
	assistant: string,
): Set<string> {
	const seats = new Set((message.wakes ?? []).filter((seat) => roster.has(seat)));
	if (isClosed(message)) return seats;
	for (const [seat, held] of bySeat) {
		if (seat === message.from || seat === assistant) continue;
		if (held.some((lease) => atWork(lease, message.seq))) seats.add(seat);
	}
	return seats;
}

/**
 * Every lease that stands for this activation. A message that steers is
 * answered by any activation of the seat that heard it, however that
 * activation started. The room's own close steers nobody, so only the
 * attempts at that close stand for it.
 */
function standing(message: Message, held: readonly LeaseState[]): LeaseState[] {
	if (isClosed(message)) return held.filter((lease) => parseId(lease.id)?.seq === message.seq);
	return held.filter((lease) => heard(lease, message.seq));
}

/** The lease held a row before the message and ended, if it ends, after it. */
const atWork = (lease: LeaseState, seq: Seq): boolean =>
	atWorkRule(lease.since, lease.until !== undefined, lease.until ?? 0, seq);

/**
 * The lease heard the message. A lease that runs or came to nothing heard
 * every message it was at work for, and every one its view held. A lease
 * that stood down heard what its last renewal confirmed: a message that
 * landed between that renewal and the release reached no activation.
 */
const heard = (lease: LeaseState, seq: Seq): boolean =>
	heardRule(
		lease.phase === 'running' || cameToNothing(lease),
		lease.since,
		lease.until !== undefined,
		lease.until ?? 0,
		lease.heardThrough,
		seq,
	);

/**
 * The activation as due, or nothing when a lease answered it. One at the cap
 * is still due, and carries the attempts that reached it: the room decides
 * what it does about an activation it gave up on.
 */
function statusOf(
	message: Message,
	seat: string,
	taken: readonly LeaseState[],
	options: WakeOptions,
): Due | undefined {
	if (taken.some((lease) => !cameToNothing(lease))) return undefined;
	const attempts = taken.length;
	const last = Math.max(0, ...taken.map((lease) => Date.parse(lease.at)));
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
const cameToNothing = (lease: LeaseState): boolean =>
	lease.phase === 'ended' && lease.reason !== undefined && CAME_TO_NOTHING.has(lease.reason);
