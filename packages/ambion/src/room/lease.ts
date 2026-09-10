/**
 * Activations, named by what caused them, and the leases they hold.
 *
 * An activation's id is derived from the log: the seq of the message that
 * woke the seat and the seat's name, or the close it answers and the
 * attempt number. Nothing mints an id, so a wake is safe to send twice, a
 * retried commit lands once, and a request from an activation whose lease
 * ended is refused because the fold says so.
 *
 * A lease has two phases. `running` is a claim or a renewal, with an
 * expiry; `ended` is terminal, with a reason. The last row for an id wins,
 * and an ended lease never runs again.
 *
 * A wake is a message and a seat it names in `wakes`. A lease of that wake
 * answers it when it runs, when it ended released, refused or revoked, or
 * when the activation spoke. A lease that expired or failed without a
 * word answers nothing: it counts as one attempt, and the wake is pending
 * again after the backoff, under the next attempt's id, until the cap.
 * The fold reports every wake still pending with its attempts; the room
 * sends it when it is due.
 */

import type { Message, Seq } from '../types.ts';
import type { EndReason, LeaseRow } from '../wire.ts';

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

/** The last row for one id: whether it runs, until when, or why it ended. */
export interface LeaseState {
	id: string;
	phase: 'running' | 'ended';
	/** When a running lease expires, in milliseconds since the epoch. */
	expiry?: number;
	reason?: EndReason;
	/** When the last row was written, ISO. */
	at: string;
}

export function foldLeases(rows: readonly LeaseRow[]): Map<string, LeaseState> {
	const leases = new Map<string, LeaseState>();
	for (const row of rows) {
		// Ended is terminal: a renewal that lands after the end changes nothing.
		if (leases.get(row.id)?.phase === 'ended') continue;
		leases.set(
			row.id,
			row.phase === 'running'
				? { id: row.id, phase: 'running', expiry: row.expiry, at: row.at }
				: { id: row.id, phase: 'ended', reason: row.reason, at: row.at },
		);
	}
	return leases;
}

export const isExpired = (lease: LeaseState, now: number): boolean =>
	lease.phase === 'running' && (lease.expiry ?? 0) <= now;

/** A lease that holds: running, and not past its expiry. */
export const isLive = (lease: LeaseState, now: number): boolean =>
	lease.phase === 'running' && !isExpired(lease, now);

/** A wake on the log that no lease has answered. */
export interface PendingWake {
	/** The id of the next attempt. */
	id: string;
	seat: string;
	seq: Seq;
	/** When the message was written, ISO. */
	at: string;
	/** How many activations took this wake and came to nothing. */
	attempts: number;
	/** When the next attempt may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

export interface WakeOptions {
	/** How many attempts the room makes at one wake before it gives up. */
	attempts: number;
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
	leases: ReadonlyMap<string, LeaseState>,
	roster: ReadonlySet<string>,
	options: WakeOptions,
): PendingWake[] {
	const spoke = new Set(
		messages.flatMap((m) => (m.activationId === undefined ? [] : [m.activationId])),
	);
	const byWake = leasesByWake(leases);
	const pending: PendingWake[] = [];
	for (const message of messages) {
		for (const seat of (message.wakes ?? []).filter((name) => roster.has(name))) {
			const taken = byWake.get(activationId(message.seq, seat)) ?? [];
			const wake = statusOf(message, seat, taken, spoke, options);
			if (wake !== undefined) pending.push(wake);
		}
	}
	return pending;
}

/** Every lease a wake's attempts took, keyed by the first attempt's id. */
function leasesByWake(leases: ReadonlyMap<string, LeaseState>): Map<string, LeaseState[]> {
	const byWake = new Map<string, LeaseState[]>();
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.kind !== 'wake') continue;
		const first = activationId(parsed.seq, parsed.seat);
		byWake.set(first, [...(byWake.get(first) ?? []), lease]);
	}
	return byWake;
}

/** The wake as pending, or nothing when a lease answered it or the room gave up. */
function statusOf(
	message: Message,
	seat: string,
	taken: readonly LeaseState[],
	spoke: ReadonlySet<string>,
	options: WakeOptions,
): PendingWake | undefined {
	if (taken.some((lease) => answers(lease, spoke))) return undefined;
	const failed = taken.filter((lease) => cameToNothing(lease));
	const attempts = failed.length;
	if (attempts >= options.attempts) return undefined;
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)));
	return {
		id: activationId(message.seq, seat, attempts + 1),
		seat,
		seq: message.seq,
		at: message.at,
		attempts,
		notBefore: attempts === 0 ? undefined : last + options.backoff(attempts),
	};
}

/** A lease answers the wake it took: it runs, it stood down, or the activation spoke. */
function answers(lease: LeaseState, spoke: ReadonlySet<string>): boolean {
	if (lease.phase === 'running' || spoke.has(lease.id)) return true;
	return !cameToNothing(lease);
}

const cameToNothing = (lease: LeaseState): boolean =>
	lease.phase === 'ended' && lease.reason !== undefined && CAME_TO_NOTHING.has(lease.reason);

/** The seat an id belongs to: the one it names, or the assistant for a draft. */
export function seatOf(id: string, assistant: string): string | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	return parsed.kind === 'wake' ? parsed.seat : assistant;
}
