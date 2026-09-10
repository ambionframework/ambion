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
 * A wake is a message and a seat it names in `wakes`. Any lease of that id
 * answers it: the seat claimed, so the wake reached it. A wake no lease
 * answers is pending, and the room sends it again.
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

/** A wake on the log that no lease of its id has answered. */
export interface PendingWake {
	id: string;
	seat: string;
	seq: Seq;
	/** When the message was written, ISO. */
	at: string;
}

/**
 * Every wake a message decided that no lease has answered, for a seat still
 * on the roster. A seat that left the roster answers no wake: what it was
 * sent is not pending.
 */
export function pendingWakes(
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseState>,
	roster: ReadonlySet<string>,
): PendingWake[] {
	const pending: PendingWake[] = [];
	for (const message of messages) {
		for (const seat of message.wakes ?? []) {
			const id = activationId(message.seq, seat);
			if (!roster.has(seat) || leases.has(id)) continue;
			pending.push({ id, seat, seq: message.seq, at: message.at });
		}
	}
	return pending;
}

/** The seat an id belongs to: the one it names, or the assistant for a draft. */
export function seatOf(id: string, assistant: string): string | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	return parsed.kind === 'wake' ? parsed.seat : assistant;
}
