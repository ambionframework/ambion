/**
 * Activations, named by what caused them, and the leases they hold.
 *
 * An activation's id is derived from the journal: what caused it, where the
 * cause sits on the record, the seat's name and the attempt number. Nothing
 * mints an id, so a wake is safe to send twice, a retried commit lands once,
 * and a request from an activation whose lease ended is refused because the
 * fold says so. The id carries the cause, so a reader asks the id what the
 * activation's durable cause, seat, and attempt. `activation.ts` combines
 * those facts with current bindings to derive its authority.
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
import type { Message, Seq } from '../types.ts';
import type { EndReason, LeaseChange, LeaseHold } from '../wire.ts';
import {
	atWork as atWorkRule,
	coversAttempt as coverageRule,
	expired,
	nextAttempt,
} from './rules.verified.ts';

/**
 * What caused an activation. Three things cause one, and the journal holds
 * all three: a message the room delivered, the question that opened an
 * exchange, and a close that owes a summary. The room schedules them the
 * same way, so `PendingActivation` reads the same for each.
 *
 * `opened` and `closed` name the exchange's two events. `Kind` keeps
 * `close` for the entry a close writes; a cause reads `closed`, for the
 * exchange that closed.
 */
export type Cause = 'message' | 'opened' | 'closed';

/**
 * The id of one activation: what caused it, where the cause sits on the
 * record, the seat that takes it, and which attempt this is. One spelling
 * for every cause, so every reader asks the same four questions of it.
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

const ID = /^(message|opened|closed):(\d+):([a-z][a-z0-9-]*):(\d+)$/;

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
	const known = leases.get(change.id);
	if (known?.phase === 'ended') return;
	const since = known?.since ?? seq;
	const claimedAt = known?.claimedAt ?? change.at;
	const readThrough = Math.max(known?.readThrough ?? 0, change.readThrough);
	leases.set(
		change.id,
		change.phase === 'running'
			? {
					id: change.id,
					phase: 'running',
					expiresAt: change.expiresAt,
					at: change.at,
					claimedAt,
					since,
					readThrough,
				}
			: {
					id: change.id,
					phase: 'ended',
					reason: change.reason,
					at: change.at,
					claimedAt,
					since,
					until: seq,
					readThrough,
				},
	);
}

export const isExpired = (lease: LeaseHold, now: number): boolean =>
	lease.phase === 'running' && expired(lease.expiresAt, now);

/** A lease that holds: running, and not past its expiry. */
export const isLive = (lease: LeaseHold, now: number): boolean =>
	lease.phase === 'running' && !isExpired(lease, now);

/**
 * An activation the room owes a seat, and has not had. Three things on the
 * journal cause one: a message that woke a seat and no lease answered, the
 * question that opened an exchange, and a close that owes a summary. The
 * room schedules all three the same way, so all three read as this.
 */
export interface PendingActivation {
	/** The recorded cause of this activation. */
	cause: Cause;
	/** The journal position of the cause. */
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
 * Why a seat's wake on this message exists. The fold decides it once, and
 * the id carries the answer to every reader after it.
 */
export type CauseOf = (seat: string, seq: Seq) => Cause;

/**
 * Every wake a message decided that no lease has answered, for a seat still
 * on the roster. A seat that left the roster answers no wake: what it was
 * sent is not pending.
 */
export function pendingWakes(
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
	roster: ReadonlySet<string>,
	options: PendingActivationOptions,
	causeOf: CauseOf,
): PendingWake[] {
	const bySeat = leasesBySeat(leases, roster);
	const pending: PendingWake[] = [];
	for (const message of messages) {
		for (const seat of reached(message, bySeat, roster)) {
			const taken = (bySeat.get(seat) ?? []).filter((lease) => coversAttempt(lease, message.seq));
			const wake = statusOf(message, seat, taken, options, causeOf(seat, message.seq));
			if (wake !== undefined) pending.push(wake);
		}
	}
	return pending;
}

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
		const parsed = parseId(lease.id);
		if (parsed === undefined || parsed.cause === 'closed') continue;
		if (!roster.has(parsed.seat)) continue;
		bySeat.set(parsed.seat, [...(bySeat.get(parsed.seat) ?? []), lease]);
	}
	return bySeat;
}

/**
 * The seats a message reached: the ones it names, and every seat at work
 * when it landed. A seat composing the room for an exchange hears no steer,
 * so a message reaches that seat by name alone.
 */
function reached(
	message: Message,
	bySeat: ReadonlyMap<string, LeaseHold[]>,
	roster: ReadonlySet<string>,
): Set<string> {
	const seats = new Set((message.wakes ?? []).filter((seat) => roster.has(seat)));
	for (const [seat, held] of bySeat) {
		if (seat === message.from) continue;
		if (held.some((lease) => steered(lease, message.seq))) seats.add(seat);
	}
	return seats;
}

/** The lease was at work when the message landed, and it takes a steer. */
const steered = (lease: LeaseHold, seq: Seq): boolean =>
	atWork(lease, seq) && parseId(lease.id)?.cause !== 'opened';

/** The lease held a change before the message and ended, if it ended, after it. */
const atWork = (lease: LeaseHold, seq: Seq): boolean =>
	lease.phase === 'ended'
		? atWorkRule(lease.since, true, lease.until, seq)
		: atWorkRule(lease.since, false, 0, seq);

/**
 * A completed lease answers only context its executor explicitly consumed.
 * A running lease still holds its work, so the room waits for its terminal
 * result before it schedules the same message again.
 */
const answered = (lease: LeaseHold, seq: Seq): boolean =>
	lease.phase === 'running' ||
	((lease.reason === 'abandoned' || lease.reason === 'revoked') &&
		parseId(lease.id)?.position === seq) ||
	(!answersNothing(lease) && lease.readThrough >= seq);

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
	cause: Cause,
): PendingWake | undefined {
	// A running lease keeps the work claimed. A completed lease settles it only
	// after the executor recorded explicit progress through this message.
	if (taken.some((lease) => answered(lease, message.seq))) return undefined;
	const failed = taken.filter(
		(lease) =>
			cameToNothing(lease) ||
			(lease.phase === 'ended' && parseId(lease.id)?.position === message.seq),
	);
	return {
		...pendingActivation(cause, message.seq, seat, failed, options),
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
	cause: Cause,
	position: Seq,
	seat: string,
	failed: readonly LeaseHold[],
	options: PendingActivationOptions,
): PendingActivation {
	const unsuccessfulAttempts = failed.length;
	const attempt = nextAttempt(unsuccessfulAttempts);
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)));
	return {
		id: activationId(cause, position, seat, attempt),
		cause,
		position,
		seat,
		attempt,
		unsuccessfulAttempts,
		notBefore:
			unsuccessfulAttempts === 0 ? undefined : last + options.backoff(unsuccessfulAttempts),
	};
}

/** Whether the lease ended for a reason in `reasons`. */
const endedFor = (lease: LeaseHold, reasons: ReadonlySet<EndReason>): boolean =>
	lease.phase === 'ended' && reasons.has(lease.reason);

/** The lease answers no work it attempted. */
const answersNothing = (lease: LeaseHold): boolean => endedFor(lease, ANSWERS_NOTHING);

/** The attempt came to nothing, so the next one is numbered after it. */
export const cameToNothing = (lease: LeaseHold): boolean => endedFor(lease, CAME_TO_NOTHING);

/** The seat an id names, or nothing for an id the room did not derive. */
export const seatOf = (id: string): string | undefined => parseId(id)?.seat;
