/**
 * The wakes still open, as an index that one entry updates.
 *
 * A wake is open until a lease that has ended answers it, a removal of its
 * seat makes it stale, or a cancellation cuts it. Each of these is final, so
 * the index drops the wake. A running lease answers a wake only while it runs,
 * so the index keeps that wake and reads it again when the seat's leases
 * change. The rules are the ones `lease.ts` holds. This file changes how
 * often they run.
 */

import type { Seq } from '../types.ts';
import type { MessageDelivery } from './delivery.ts';
import {
	coversAttempt,
	type LeaseHold,
	type PendingActivationOptions,
	type PendingWake,
	statusOf,
	takenOf,
} from './lease.ts';
import { survivesCancellation, wakeAnswered } from './rules.verified.ts';

/** One seat a message reached, and whether its wake is pending now. */
export interface WakeCandidate {
	seat: string;
	seq: Seq;
	at: string;
	/** Undefined while a running lease answers the wake. */
	wake: PendingWake | undefined;
}

/** The leases of one seat that a wake claims, by activation id. */
export type SeatLeases = ReadonlyMap<string, LeaseHold>;

/** A candidate for one seat, or nothing when an ended lease answered the wake for good. */
function judgeWake(
	seat: string,
	message: { seq: Seq; at: string },
	leases: SeatLeases | undefined,
	options: PendingActivationOptions,
): WakeCandidate | undefined {
	const taken = [...(leases?.values() ?? [])].filter((lease) => coversAttempt(lease, message.seq));
	const wake = statusOf(message, seat, taken, options);
	const settled = taken.filter((lease) => lease.phase === 'ended').map(takenOf);
	if (wake === undefined && wakeAnswered(settled, message.seq)) return undefined;
	return { seat, seq: message.seq, at: message.at, wake };
}

/** The candidates one message opens, in the order the fold reads its recipients. */
export function candidatesOf(
	message: { seq: Seq; at: string },
	delivery: MessageDelivery,
	seatLeases: ReadonlyMap<string, SeatLeases>,
	options: PendingActivationOptions,
): WakeCandidate[] {
	const seats = new Set([...delivery.wakes, ...delivery.steers.map((steer) => steer.seat)]);
	return [...seats].flatMap((seat) => {
		const candidate = judgeWake(seat, message, seatLeases.get(seat), options);
		return candidate === undefined ? [] : [candidate];
	});
}

/** Read every candidate of one seat again after its leases changed. */
export function rejudgeSeat(
	candidates: readonly WakeCandidate[],
	seat: string,
	leases: SeatLeases | undefined,
	options: PendingActivationOptions,
): WakeCandidate[] {
	return candidates.flatMap((candidate) => {
		if (candidate.seat !== seat) return [candidate];
		const next = judgeWake(seat, candidate, leases, options);
		return next === undefined ? [] : [next];
	});
}

/** A removal of the seat makes every wake open before it stale. */
export const dropSeat = (candidates: readonly WakeCandidate[], seat: string): WakeCandidate[] =>
	candidates.filter((candidate) => candidate.seat !== seat);

/** The wakes still pending for the seats on the roster, in the order of the fold. */
export function pendingOf(
	candidates: readonly WakeCandidate[],
	roster: ReadonlySet<string>,
	cancelledAt: Seq | undefined,
): PendingWake[] {
	return candidates.flatMap((candidate) =>
		candidate.wake !== undefined &&
		roster.has(candidate.seat) &&
		survivesCancellation(candidate.seq, cancelledAt)
			? [candidate.wake]
			: [],
	);
}
