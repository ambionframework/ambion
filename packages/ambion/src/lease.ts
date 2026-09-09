/**
 * Activations, named by what caused them.
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
 */

import type { Message, Seq } from './types.ts';
import type { CloseRow, EndReason, LeaseRow } from './wire.ts';

/** The id of the activation a message wakes on a seat. */
export const activationId = (seq: Seq, seat: string): string => `${seq}:${seat}`;

/** The id of the assistant's attempt at the summary a close owes. */
export const draftId = (through: Seq, attempt: number): string => `close:${through}:${attempt}`;

export type ParsedId =
	{ kind: 'wake'; seq: Seq; seat: string } | { kind: 'draft'; through: Seq; attempt: number };

/** What an id says caused the activation, or nothing for an id the room did not derive. */
export function parseId(id: string): ParsedId | undefined {
	const draft = /^close:(\d+):(\d+)$/.exec(id);
	if (draft) return { kind: 'draft', through: Number(draft[1]), attempt: Number(draft[2]) };
	const wake = /^(\d+):([a-z][a-z0-9-]*)$/.exec(id);
	if (wake) return { kind: 'wake', seq: Number(wake[1]), seat: wake[2] ?? '' };
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

/** A wake the room decided and no lease has answered. */
export interface PendingWake {
	id: string;
	seat: string;
	/** When the wake was decided, ISO: the message's or the close's `at`. */
	at: string;
}

/**
 * Every wake on the log that no lease row answers: a seat a message names in
 * `wakes`, and the assistant a close names. A wake is pending until the seat
 * claims the lease, whoever sent it and however often.
 */
export function pendingWakes(
	messages: readonly Message[],
	closes: readonly CloseRow[],
	leases: ReadonlyMap<string, LeaseState>,
	assistant: string,
): PendingWake[] {
	const decided: PendingWake[] = [];
	for (const message of messages) {
		for (const seat of message.wakes ?? []) {
			decided.push({ id: activationId(message.seq, seat), seat, at: message.at });
		}
	}
	for (const close of closes) {
		if (close.wakes?.length)
			decided.push({ id: draftId(close.through, 1), seat: assistant, at: close.at });
	}
	return decided.filter((wake) => !leases.has(wake.id));
}

/** The seat an id belongs to: the one it names, or the assistant for a draft. */
export function seatOf(id: string, assistant: string): string | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	return parsed.kind === 'wake' ? parsed.seat : assistant;
}
