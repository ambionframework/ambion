import { describe, expect, it } from 'vitest';
import { summaryCompletion } from '../src/room/exchange.ts';
import type { Message } from '../src/types.ts';
import type { Close, LeaseHold } from '../src/wire.ts';

const close = (writer: string | null = 'assistant'): Close => ({
	owner: 'priya',
	from: 2,
	through: 5,
	at: '2026-01-01T00:00:00.000Z',
	...(writer === null ? {} : { summary: writer }),
});

const summary: Message = {
	kind: 'summary',
	seq: 6,
	at: '2026-01-01T00:00:01.000Z',
	from: 'assistant',
	to: 'priya',
	text: 'Done.',
	covers: { from: 2, through: 5 },
};

const ended = (reason: Extract<LeaseHold, { phase: 'ended' }>['reason']): LeaseHold => ({
	id: 'closed:5:assistant:1',
	phase: 'ended',
	reason,
	at: '2026-01-01T00:00:02.000Z',
	claimedAt: '2026-01-01T00:00:01.000Z',
	since: 3,
	until: 7,
	readThrough: 0,
});

const running: LeaseHold = {
	id: 'closed:5:assistant:1',
	phase: 'running',
	expiresAt: Date.parse('2026-01-01T00:01:00.000Z'),
	at: '2026-01-01T00:00:02.000Z',
	claimedAt: '2026-01-01T00:00:01.000Z',
	since: 3,
	readThrough: 0,
};

const leases = (...holds: LeaseHold[]): ReadonlyMap<string, LeaseHold> =>
	new Map(holds.map((hold) => [hold.id, hold]));

describe('summary completion query', () => {
	it('uses a matching published summary before any other terminal state', () => {
		expect(summaryCompletion(close(), [summary], leases(ended('abandoned')))).toEqual({
			status: 'published',
			summary,
		});
	});

	it('requires the assigned writer before a message can settle a close', () => {
		expect(summaryCompletion(close(), [{ ...summary, from: 'another-agent' }], leases())).toEqual({
			status: 'pending',
			writer: 'assistant',
		});
		expect(summaryCompletion(close(null), [summary], leases())).toEqual({ status: 'silent' });
	});

	it('matches the close owner and complete covered range', () => {
		expect(summaryCompletion(close(), [summary], leases())).toEqual({
			status: 'published',
			summary,
		});
		expect(
			summaryCompletion(close(), [{ ...summary, covers: { from: 1, through: 6 } }], leases()),
		).toEqual({ status: 'published', summary: { ...summary, covers: { from: 1, through: 6 } } });
		expect(summaryCompletion(close(), [{ ...summary, to: 'sam' }], leases()).status).toBe(
			'pending',
		);
		expect(
			summaryCompletion(close(), [{ ...summary, covers: { from: 3, through: 5 } }], leases()),
		).toMatchObject({ status: 'pending' });
		expect(
			summaryCompletion(close(), [{ ...summary, covers: { from: 2, through: 4 } }], leases()),
		).toMatchObject({ status: 'pending' });
	});

	it('reports silent, pending, and failed terminal outcomes from the leases', () => {
		expect(summaryCompletion(close(null), [], leases()).status).toBe('silent');
		expect(summaryCompletion(close(), [], leases()).status).toBe('pending');
		expect(summaryCompletion(close(), [], leases(running)).status).toBe('pending');
		expect(
			summaryCompletion(
				close(),
				[],
				leases(running, { ...ended('released'), id: 'closed:5:assistant:2' }),
			),
		).toEqual({ status: 'pending' });
		expect(summaryCompletion(close(), [], leases(ended('released'))).status).toBe('silent');
		expect(summaryCompletion(close(), [], leases(ended('revoked'))).status).toBe('failed');
		expect(summaryCompletion(close(), [], leases(ended('abandoned'))).status).toBe('failed');
	});

	it('returns the recorded writer only while its summary remains owed', () => {
		expect(summaryCompletion(close('historical-assistant'), [], leases(ended('failed')))).toEqual({
			status: 'pending',
			writer: 'historical-assistant',
		});
		expect(summaryCompletion(close(), [], leases(running))).toEqual({
			status: 'pending',
			writer: 'assistant',
		});
	});

	it('ignores a terminal draft from another seat', () => {
		const otherSeat = { ...ended('abandoned'), id: 'closed:5:other-seat:1' };
		expect(summaryCompletion(close(), [], leases(otherSeat))).toEqual({
			status: 'pending',
			writer: 'assistant',
		});
	});

	it('ignores unrelated summary leases when the close assigns no writer', () => {
		expect(summaryCompletion(close(null), [], leases(running))).toEqual({ status: 'silent' });
		expect(summaryCompletion(close(null), [], leases(ended('failed')))).toEqual({
			status: 'silent',
		});
	});

	it('keeps retryable lease endings pending and ignores another close position', () => {
		expect(summaryCompletion(close(), [], leases(ended('failed'))).status).toBe('pending');
		expect(summaryCompletion(close(), [], leases(ended('expired'))).status).toBe('pending');
		expect(
			summaryCompletion(close(), [], leases({ ...ended('abandoned'), id: 'closed:9:assistant:1' })),
		).toMatchObject({ status: 'pending' });
		expect(
			summaryCompletion(
				close(),
				[],
				leases({ ...ended('abandoned'), id: 'message:5:assistant:1' }),
			),
		).toMatchObject({ status: 'pending' });
	});
});
