import { describe, expect, it } from 'vitest';
import { messageDelivery } from '../src/room/delivery.ts';
import type { Message } from '../src/types.ts';
import type { LeaseHold } from '../src/wire.ts';

const message = (seq = 10, wakes?: string[]): Message => ({
	kind: 'said',
	seq,
	at: '2026-01-01T00:00:00.000Z',
	from: 'priya',
	text: 'Question.',
	...(wakes === undefined ? {} : { wakes }),
});

const running = (id: string, since: number, expiresAt = 1): LeaseHold => ({
	id,
	phase: 'running',
	expiresAt,
	at: '2026-01-01T00:00:00.000Z',
	claimedAt: '2026-01-01T00:00:00.000Z',
	since,
	readThrough: 0,
});

const ended = (
	id: string,
	since: number,
	until: number,
	reason: Extract<LeaseHold, { phase: 'ended' }>['reason'] = 'released',
): LeaseHold => ({
	id,
	phase: 'ended',
	reason,
	at: '2026-01-01T00:00:00.000Z',
	claimedAt: '2026-01-01T00:00:00.000Z',
	since,
	until,
	readThrough: 0,
});

const leases = (...holds: LeaseHold[]): ReadonlyMap<string, LeaseHold> =>
	new Map(holds.map((hold) => [hold.id, hold]));

describe('message delivery rule', () => {
	it('deduplicates an explicit wake with an active steer and excludes the author', () => {
		expect(
			messageDelivery(
				message(10, ['beta', 'author']),
				leases(
					running('message:3:beta:1', 3),
					running('message:3:priya:1', 3),
					running('message:3:gamma:1', 3),
				),
			),
		).toEqual({
			wakes: ['beta', 'author'],
			steers: [{ seat: 'gamma', activation: 'message:3:gamma:1' }],
		});
	});

	it('uses journal intervals and ordinary message causes only', () => {
		expect(
			messageDelivery(
				message(),
				leases(
					ended('message:3:before:1', 3, 9),
					ended('message:3:at-end:1', 3, 10),
					ended('message:3:after:1', 3, 11),
					running('message:3:running:1', 3, 0),
					running('opened:3:opened:1', 3),
					running('closed:10:closed:1', 3),
				),
			),
		).toEqual({
			wakes: [],
			steers: [
				{ seat: 'at-end', activation: 'message:3:at-end:1' },
				{ seat: 'after', activation: 'message:3:after:1' },
				{ seat: 'running', activation: 'message:3:running:1' },
			],
		});
	});

	it('leaves explicit recorded wakes intact when no historical lease can steer', () => {
		expect(messageDelivery(message(10, ['removed', 'unknown']), leases())).toEqual({
			wakes: ['removed', 'unknown'],
			steers: [],
		});
	});
});
