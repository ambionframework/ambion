/**
 * A lease records the context its executor consumed. Its heartbeat only
 * extends liveness. These cases keep that distinction through retries and
 * checkpoint recovery.
 */
import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/journal/journal.ts';
import { checkpointOf, foldRoom } from '../src/room/fold.ts';
import { planReconciliation } from '../src/room/reconcile.ts';
import { decide, evolve, type RoomDecision } from '../src/room/transition.ts';
import type { LeaseChange } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const retry = { backoff: () => 0 };
const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		agents: [{ name: 'solo', identity: 'Answers.', attention: 'broadcast' }],
		available: [],
		at,
	},
};
const wake = (seq: number, text = 'Question.'): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'said', at, from: 'priya', text, wakes: ['solo'] },
});
const lease = (seq: number, body: LeaseChange): Entry => ({ kind: 'lease', seq, body });
const held = (id: string, seq: number, readThrough: number): Entry =>
	lease(seq, {
		id,
		phase: 'running',
		expiresAt: now + 60_000,
		at,
		readThrough,
	});
const released = (id: string, seq: number, readThrough: number): Entry =>
	lease(seq, {
		id,
		phase: 'ended',
		reason: 'released',
		at,
		readThrough,
	});

const event = (decision: RoomDecision<'lease'>, seq: number): Entry => {
	if (!('event' in decision) || decision.event === undefined)
		throw new Error('Expected a lease event.');
	return { ...decision.event, seq };
};

const reconciliation = (attempts: number) => ({
	now,
	resend: 1_000,
	attempts,
	sent: new Map<string, number>(),
	sinceCheckpoint: 0,
	checkpointEvery: 256,
	stopped: false,
});

describe('acknowledged lease context', () => {
	it('does not infer progress from a heartbeat without readThrough', () => {
		const id = 'message:2:solo:1';
		const beforeHeartbeat = foldRoom(
			[composition, wake(2), held(id, 3, 2), wake(4, 'Later.')],
			retry,
		);
		const heartbeat = event(
			decide(beforeHeartbeat, { type: 'renew', id, expiry: 60_000, deadline: 600_000 }, now),
			5,
		);
		expect(heartbeat.body).toMatchObject({ readThrough: 2 });
		const afterRelease = foldRoom(
			[composition, wake(2), held(id, 3, 2), wake(4, 'Later.'), heartbeat, released(id, 6, 2)],
			retry,
		);
		expect(afterRelease.leases.get(id)?.readThrough).toBe(2);
		expect(afterRelease.pending.map((pending) => pending.id)).toEqual(['message:4:solo:1']);
	});

	it('keeps explicit acknowledgements monotonic when they repeat or arrive out of order', () => {
		const id = 'message:2:solo:1';
		const state = foldRoom(
			[
				composition,
				wake(2),
				held(id, 3, 2),
				wake(4, 'Later.'),
				held(id, 5, 4),
				held(id, 6, 2),
				released(id, 7, 3),
			],
			retry,
		);
		expect(state.leases.get(id)).toMatchObject({ phase: 'ended', readThrough: 4 });
		expect(state.pending).toEqual([]);
	});

	it('refuses invalid lease acknowledgements without proposing an event', () => {
		const id = 'message:2:solo:1';
		const state = foldRoom([composition, wake(2), held(id, 3, 2)], retry);
		for (const readThrough of [-1, 1.5, 99]) {
			expect(
				decide(state, { type: 'renew', id, expiry: 60_000, deadline: 600_000, readThrough }, now),
			).toMatchObject({ refusal: { category: 'refused' } });
			expect(
				decide(state, { type: 'end', id, reason: 'released', readThrough }, now),
			).toMatchObject({ refusal: { category: 'refused' } });
		}
		expect(
			decide(
				foldRoom([composition, wake(2)], retry),
				{ type: 'renew', id, expiry: 60_000, deadline: 600_000 },
				now,
			),
		).toMatchObject({ refusal: { category: 'stale' } });
	});

	it('retries unread released work under a new id and abandons it at the cap', () => {
		const first = 'message:2:solo:1';
		const releasedUnread = foldRoom(
			[composition, wake(2), held(first, 3, 0), released(first, 4, 0)],
			retry,
		);
		expect(releasedUnread.pending).toMatchObject([
			{ id: 'message:2:solo:2', attempt: 2, unsuccessfulAttempts: 1 },
		]);

		const decision = planReconciliation(releasedUnread, reconciliation(1));
		expect(decision.abandoned).toEqual([
			{ id: 'message:2:solo:2', phase: 'ended', reason: 'abandoned', at, readThrough: 0 },
		]);
		const stopped = evolve(
			releasedUnread,
			{ kind: 'lease', seq: 5, body: decision.abandoned[0] as LeaseChange },
			retry,
		);
		expect(stopped.pending).toEqual([]);
		expect(planReconciliation(stopped, reconciliation(1)).sends).toEqual([]);
	});

	it('keeps unread later work through release, checkpoint, and replay', () => {
		const id = 'message:2:solo:1';
		const entries = [composition, wake(2), held(id, 3, 2), wake(4, 'Later.'), released(id, 5, 2)];
		const before = foldRoom(entries, retry);
		expect(before.pending.map((pending) => pending.id)).toEqual(['message:4:solo:1']);
		const checkpoint = checkpointOf(before, now);
		if (checkpoint === undefined) throw new Error('Expected a checkpoint.');
		const replayed = foldRoom(
			[{ kind: 'checkpoint', seq: 6, body: checkpoint }, wake(2), wake(4, 'Later.')],
			retry,
		);
		expect(replayed.pending.map((pending) => pending.id)).toEqual(['message:4:solo:1']);
	});

	it('retains a released lease as evidence that an unwoken steer reached its seat', () => {
		const id = 'message:2:solo:1';
		const laterSteer: Entry = {
			kind: 'message',
			seq: 4,
			body: { kind: 'said', at, from: 'priya', text: 'Later.' },
		};
		const before = foldRoom(
			[composition, wake(2), held(id, 3, 2), laterSteer, released(id, 5, 2)],
			retry,
		);
		expect(before.pending.map((pending) => pending.id)).toEqual(['message:4:solo:1']);
		const checkpoint = checkpointOf(before, now);
		if (checkpoint === undefined) throw new Error('Expected a checkpoint.');
		expect(checkpoint.floor).toBe(4);
		expect(checkpoint.leases.map((lease) => lease.id)).toContain(id);
		const replayed = foldRoom(
			[{ kind: 'checkpoint', seq: 6, body: checkpoint }, wake(2), laterSteer],
			retry,
		);
		expect(replayed.pending.map((pending) => pending.id)).toEqual(['message:4:solo:1']);
	});

	it('keeps an earlier unread wake when a later activation is checkpointed live', () => {
		const id = 'message:4:solo:1';
		const live = foldRoom([composition, wake(2), wake(4, 'Later.'), held(id, 5, 0)], retry);
		const checkpoint = checkpointOf(live, now);
		if (checkpoint === undefined) throw new Error('Expected a checkpoint.');
		expect(checkpoint.floor).toBeLessThanOrEqual(2);
		const recovered = foldRoom(
			[
				{ kind: 'checkpoint', seq: 6, body: checkpoint },
				wake(2),
				wake(4, 'Later.'),
				released(id, 7, 0),
			],
			retry,
		);
		expect(recovered.pending.map((pending) => pending.id)).toContain('message:2:solo:1');
	});

	it('does not move a settled checkpoint floor backward for a fresh unread lease', () => {
		const settledId = 'message:2:solo:1';
		const settled = foldRoom(
			[composition, wake(2), held(settledId, 3, 2), released(settledId, 4, 2)],
			retry,
		);
		const first = checkpointOf(settled, now);
		if (first === undefined) throw new Error('Expected settled checkpoint.');
		const freshId = 'message:6:solo:1';
		const live = foldRoom(
			[{ kind: 'checkpoint', seq: 5, body: first }, wake(6, 'Later.'), held(freshId, 7, 0)],
			retry,
		);
		for (const checkpointAt of [now, now + 60_000]) {
			const second = checkpointOf(live, checkpointAt);
			if (second === undefined) throw new Error('Expected live checkpoint.');
			expect(second.floor).toBeGreaterThanOrEqual(first.floor);
			const recovered = foldRoom(
				[
					{ kind: 'checkpoint', seq: 8, body: second },
					wake(2),
					wake(6, 'Later.'),
					released(freshId, 9, 0),
				],
				retry,
			);
			expect(recovered.pending.map((pending) => pending.id)).toEqual(['message:6:solo:2']);
		}
	});
});
