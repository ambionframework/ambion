import { describe, expect, it } from 'vitest';
import type { Entry, Kind } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { decide, evolve, type RoomDecision } from '../src/room/transition.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };
const composition: Entry = {
	kind: 'composition',
	body: {
		agents: [{ name: 'product', identity: 'Product.', attention: 'broadcast' }],
		available: [],
		at,
	},
	seq: 1,
};
const arrived: Entry = {
	kind: 'message',
	body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' },
	seq: 2,
};

const said = (seq: number, from = 'priya'): Entry => ({
	kind: 'message',
	body: { kind: 'said', at, from, text: 'Question.', wakes: ['product'] },
	seq,
});

const event = (decision: RoomDecision<Kind>, seq: number): Entry => {
	if (!('event' in decision) || decision.event === undefined) throw new Error('Expected an event.');
	return { ...decision.event, seq };
};

describe('room transition', () => {
	it('keeps an observed close range and reconciles each exchange once', () => {
		const question: Extract<Entry, { kind: 'message' }> = {
			kind: 'message',
			seq: 3,
			body: { kind: 'said', at, from: 'priya', text: 'First.' },
		};
		const state = foldRoom([composition, arrived, question], options);
		const reconcile = {
			type: 'reconcile' as const,
			options: {
				resend: 5_000,
				attempts: 3,
				sent: new Map<string, number>(),
				sinceCheckpoint: 0,
				checkpointEvery: 256,
				stopped: false,
			},
		};
		const observed = decide(state, reconcile, now).events[0];
		if (observed?.kind !== 'close') throw new Error('Expected an observed close.');
		const later = evolve(
			state,
			{ kind: 'message', seq: 4, body: { kind: 'said', at, from: 'priya', text: 'Second.' } },
			options,
		);
		const closing = event(decide(later, { type: 'close', close: observed.body }, now), 5);
		expect(closing.body).toEqual(observed.body);
		expect(closing.body).toMatchObject({ from: 3, through: 3 });
		const closed = evolve(later, closing, options);
		expect(closed.exchange?.from).toBe(4);
		expect(decide(closed, { type: 'close', close: observed.body }, now)).toEqual({
			event: undefined,
		});
		const next = decide(closed, reconcile, now).events[0];
		if (next?.kind !== 'close') throw new Error('Expected the next close.');
		expect(next.body).toMatchObject({ from: 4, through: 4 });
		const settled = evolve(closed, { ...next, seq: 6 }, options);
		expect(decide(settled, reconcile, now).events).toEqual([]);
	});

	it('matches replay, retains the prior projection, and routes a delivery', () => {
		const before = foldRoom([composition, arrived], options);
		const decision = decide(before, { type: 'deliver', from: 'priya', text: 'Hello.' }, now);
		if (!('event' in decision) || decision.event === undefined)
			throw new Error('Expected a delivery.');
		const committed: Entry = { ...decision.event, seq: 3 };
		const live = evolve(before, committed, options);
		const replayed = foldRoom([composition, arrived, committed], options);
		expect(live).toEqual(replayed);
		expect(before.messages).toHaveLength(1);
		expect(live.messages).toHaveLength(2);
		expect(live.messages[1]?.wakes).toEqual(['product']);
	});

	it('refuses a stale claim and does not create an empty checkpoint', () => {
		const state = foldRoom([composition], options);
		expect(
			decide(
				state,
				{ type: 'claim', id: 'message:2:product:1', expiry: 60_000, deadline: 600_000 },
				now,
			),
		).toMatchObject({
			refusal: { category: 'stale' },
		});
		expect(decide(foldRoom([], options), { type: 'checkpoint', since: 1, every: 1 }, now)).toEqual({
			event: undefined,
		});
	});

	it('caps a renewal at its nondefault deadline and ignores its old expiry', () => {
		const due = foldRoom([composition, arrived, said(3)], options);
		const claim = event(
			decide(due, { type: 'claim', id: 'message:3:product:1', expiry: 10, deadline: 25 }, now),
			4,
		);
		const held = evolve(due, { ...claim, seq: 4 }, options);
		const renewed = event(
			decide(
				held,
				{ type: 'claim', id: 'message:3:product:1', expiry: 100, deadline: 25 },
				now + 9,
			),
			5,
		);
		expect(renewed.body).toMatchObject({ expiry: now + 25 });
		const live = evolve(held, { ...renewed, seq: 5 }, options);
		expect(
			decide(live, { type: 'end', id: 'message:3:product:1', reason: 'expired' }, now + 10),
		).toEqual({ event: undefined });
	});

	it('classifies stale, missed, and refused commits', () => {
		const state = foldRoom([composition, arrived, said(3)], options);
		expect(
			decide(
				state,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'a',
						intent: { kind: 'said', text: 'x' },
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'stale' } });
		const lease: Entry = {
			kind: 'lease',
			body: { id: 'message:3:product:1', phase: 'running', expiry: now + 100, at },
			seq: 4,
		};
		const held = foldRoom([composition, arrived, said(3), lease, said(5)], options);
		expect(
			decide(
				held,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'b',
						readThrough: 3,
						intent: { kind: 'said', text: 'x' },
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'missed' } });
		expect(
			decide(
				foldRoom([composition, arrived, said(3), lease], options),
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'c',
						intent: { kind: 'said', to: 'product', text: 'x' },
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'refused' } });
	});
});
