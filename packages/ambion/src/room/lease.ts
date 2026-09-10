/**
 * Activations, named by what caused them.
 *
 * An activation's id is derived from the log: the seq of the message that
 * woke the seat and the seat's name, or the close it answers, and the
 * attempt number after the first. Nothing mints an id, so a wake is safe to
 * send twice, a retried commit lands once, and a request from an activation
 * whose lease ended is refused because the fold says so.
 *
 * A lease has two phases. `running` is a claim or a renewal, with an
 * expiry; `ended` is terminal, with a reason. Every row carries `heard`,
 * the seq the activation has taken. The last row for an id wins, and an
 * ended lease never runs again.
 *
 * A message reaches a seat two ways: the room names the seats at rest it
 * wakes in `wakes`, and every seat at work hears it as a steer. The log
 * names both: `wakes` holds every seat the message reached, and every lease
 * row carries `heard`, the seq the activation had taken when the row was
 * written. A lease answers a message it heard while it runs, and once it
 * ended released, refused, revoked or abandoned. A lease that stood down
 * answers through the seq its release said, so a message that landed after
 * the activation last took the record is pending for the seat, as a first
 * attempt. A lease that expired or failed answers nothing it heard,
 * whatever it said: its words stay on the record, and the seat reads them
 * at the next attempt. The failure counts as one attempt, and the message
 * is pending again for that seat after the backoff, under the next
 * attempt's id. The fold reports every wake still pending with its
 * attempts; the room decides the cap, and writes it.
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

/** The last row for one id: whether it runs, until when, or why it ended, and how far it heard. */
export interface LeaseState {
	id: string;
	phase: 'running' | 'ended';
	/** When a running lease expires, in milliseconds since the epoch. */
	expiry?: number;
	reason?: EndReason;
	/** The seq the activation has taken. Never lower than an earlier row said. */
	heard: Seq;
	/** When the first row was written, ISO: when the activation claimed. */
	since: string;
	/** When the last row was written, ISO. */
	at: string;
}

export function foldLeases(rows: readonly LeaseRow[]): Map<string, LeaseState> {
	const leases = new Map<string, LeaseState>();
	for (const row of rows) {
		const known = leases.get(row.id);
		// Ended is terminal: a renewal that lands after the end changes nothing.
		if (known?.phase === 'ended') continue;
		const heard = Math.max(known?.heard ?? 0, row.heard);
		const since = known?.since ?? row.since ?? row.at;
		leases.set(
			row.id,
			row.phase === 'running'
				? { id: row.id, phase: 'running', expiry: row.expiry, heard, since, at: row.at }
				: { id: row.id, phase: 'ended', reason: row.reason, heard, since, at: row.at },
		);
	}
	return leases;
}

export const isExpired = (lease: LeaseState, now: number): boolean =>
	lease.phase === 'running' && (lease.expiry ?? 0) <= now;

/** A lease that holds: running, and not past its expiry. */
export const isLive = (lease: LeaseState, now: number): boolean =>
	lease.phase === 'running' && !isExpired(lease, now);

/** A wake on the log that no lease of its seat has answered. */
export interface PendingWake {
	/** The id of the next attempt. */
	id: string;
	seat: string;
	seq: Seq;
	/** When the message was written, ISO. */
	at: string;
	/** How many activations heard this message and came to nothing. */
	attempts: number;
	/** When the next attempt may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

export interface WakeOptions {
	/** How long the room waits before the next attempt, after `attempt` failed ones. */
	backoff(attempt: number): number;
}

/** A lease that ended this way heard the message and came to nothing. */
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
	const bySeat = leasesBySeat(leases, roster);
	const pending: PendingWake[] = [];
	for (const message of messages) {
		for (const seat of (message.wakes ?? []).filter((name) => roster.has(name))) {
			const heard = (bySeat.get(seat) ?? []).filter((lease) => lease.heard >= message.seq);
			const wake = statusOf(message, seat, heard, options);
			if (wake !== undefined) pending.push(wake);
		}
	}
	return pending;
}

/** The leases a message wake claimed, by the seat they belong to, for seats on the roster. */
function leasesBySeat(
	leases: ReadonlyMap<string, LeaseState>,
	roster: ReadonlySet<string>,
): Map<string, LeaseState[]> {
	const bySeat = new Map<string, LeaseState[]>();
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.kind !== 'wake' || !roster.has(parsed.seat)) continue;
		bySeat.set(parsed.seat, [...(bySeat.get(parsed.seat) ?? []), lease]);
	}
	return bySeat;
}

/** The wake as pending, or nothing when a lease that heard the message answered it. */
function statusOf(
	message: Message,
	seat: string,
	heard: readonly LeaseState[],
	options: WakeOptions,
): PendingWake | undefined {
	if (heard.some((lease) => !cameToNothing(lease))) return undefined;
	const attempts = heard.length;
	const last = Math.max(0, ...heard.map((lease) => Date.parse(lease.at)));
	return {
		id: activationId(message.seq, seat, attempts + 1),
		seat,
		seq: message.seq,
		at: message.at,
		attempts,
		notBefore: attempts === 0 ? undefined : last + options.backoff(attempts),
	};
}

/** A lease that ended this way answers nothing it heard, whatever it said; every other lease answers all of it. */
const cameToNothing = (lease: LeaseState): boolean =>
	lease.phase === 'ended' && lease.reason !== undefined && CAME_TO_NOTHING.has(lease.reason);

/** The seat an id belongs to: the one it names, or the assistant for a draft. */
export function seatOf(id: string, assistant: string): string | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	return parsed.kind === 'wake' ? parsed.seat : assistant;
}
