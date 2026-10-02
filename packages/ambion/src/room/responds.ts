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
import { type DueActivationOptions, type DueRespond, dueOf, type LeaseHold } from './lease.ts';
import { coversAttempt, wakeAnswered } from './rules.verified.ts';

/** A wake that a running lease answers while it runs. It is pending again when that lease comes to nothing. */
type HeldRespond = Pick<DueRespond, 'seat' | 'position' | 'at'>;

/** A wake still open: pending now, or held by a running lease. */
export type OpenRespond = DueRespond | HeldRespond;

const isPending = (wake: OpenRespond): wake is DueRespond => 'id' in wake;

/** The leases of one seat that a wake claims, by activation id. */
export type SeatLeases = ReadonlyMap<string, LeaseHold>;

/** The wake of one seat, or nothing when an ended lease answered it for good. */
function judgeWake(
	seat: string,
	message: { seq: Seq; at: string },
	leases: SeatLeases | undefined,
	options: DueActivationOptions,
): OpenRespond | undefined {
	const taken = [...(leases?.values() ?? [])].filter((lease) => coversAttempt(lease, message.seq));
	const wake = dueOf(message, seat, taken, options);
	if (wake !== undefined) return wake;
	const settled = taken.filter((lease) => lease.phase === 'ended');
	if (wakeAnswered(settled, message.seq)) return undefined;
	return { seat, position: message.seq, at: message.at };
}

/** The wakes one message opens, in the order of its recipients. */
export function respondsOf(
	message: { seq: Seq; at: string },
	delivery: MessageDelivery,
	seatLeases: ReadonlyMap<string, SeatLeases>,
	options: DueActivationOptions,
): OpenRespond[] {
	const seats = new Set([...delivery.wakes, ...delivery.steers.map((steer) => steer.seat)]);
	return [...seats].flatMap((seat) => {
		const wake = judgeWake(seat, message, seatLeases.get(seat), options);
		return wake === undefined ? [] : [wake];
	});
}

/** Read every wake of one seat again after its leases changed. */
export function rejudgeSeat(
	wakes: readonly OpenRespond[],
	seat: string,
	leases: SeatLeases | undefined,
	options: DueActivationOptions,
): OpenRespond[] {
	return wakes.flatMap((wake) => {
		if (wake.seat !== seat) return [wake];
		const next = judgeWake(seat, { seq: wake.position, at: wake.at }, leases, options);
		return next === undefined ? [] : [next];
	});
}

/** A removal of the seat makes every wake open before it stale. */
export const dropSeat = (wakes: readonly OpenRespond[], seat: string): OpenRespond[] =>
	wakes.filter((wake) => wake.seat !== seat);

/** The wakes still pending for the seats on the roster, in the order they opened. */
export const dueRespondsOf = (
	wakes: readonly OpenRespond[],
	roster: ReadonlySet<string>,
): DueRespond[] =>
	wakes.filter((wake): wake is DueRespond => isPending(wake) && roster.has(wake.seat));
