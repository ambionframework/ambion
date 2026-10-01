/**
 * A lease records the context its executor consumed. Its heartbeat only
 * extends liveness. These cases keep that distinction through retries and
 * full journal replay.
 */
import { describe, expect, it } from 'vitest';
import type { LeaseChange } from '../src/journal/entries.ts';
import type { RoomEntry } from '../src/journal/journal.ts';
import { planReconciliation } from '../src/room/reconcile.ts';
import { decide, type RoomDecision } from '../src/room/transition.ts';
import { evolve } from './support/evolve.ts';
import { foldRoom, pendingOf, replayState } from './support/fold.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const retry = { backoff: () => 0 };
const id = 'message:2:solo:1';
const composition: RoomEntry = {
	kind: 'composition',
	seq: 1,
	body: {
		agents: [{ name: 'solo', identity: 'Answers.', attention: 'broadcast' }],
		available: [],
		at,
	},
};
const wake = (seq: number, text = 'Question.'): RoomEntry => ({
	kind: 'message',
	seq,
	body: { kind: 'said', at, from: 'priya', text, wakes: ['solo'] },
});
const lease = (seq: number, body: LeaseChange): RoomEntry => ({ kind: 'lease', seq, body });
const held = (id: string, seq: number, readThrough: number): RoomEntry =>
	lease(seq, {
		id,
		phase: 'running',
		expiresAt: now + 60_000,
		at,
		readThrough,
	});
const released = (id: string, seq: number, readThrough: number): RoomEntry =>
	lease(seq, {
		id,
		phase: 'ended',
		reason: 'released',
		at,
		readThrough,
	});

const entryAt = (decision: RoomDecision<'lease'>, seq: number): RoomEntry => {
	if (!('entry' in decision) || decision.entry === undefined)
		throw new Error('Expected a lease entry.');
	return { ...decision.entry, seq };
};

const reconciliation = (attempts: number) => ({
	now,
	resend: 1_000,
	attempts,
	sent: new Map<string, number>(),
	stopped: false,
});

describe('acknowledged lease context', () => {
	it('does not infer progress from a heartbeat without readThrough', () => {
		const beforeHeartbeat = replayState(
			[composition, wake(2), held(id, 3, 2), wake(4, 'Later.')],
			retry,
		);
		const heartbeat = entryAt(
			decide(beforeHeartbeat, { type: 'renew', id, expiry: 60_000, deadline: 600_000 }, now),
			5,
		);
		// The entry states what the renewal states. The fold keeps the prior acknowledgment.
		expect(heartbeat.body).toMatchObject({ readThrough: 0 });
		const afterRelease = replayState(
			[composition, wake(2), held(id, 3, 2), wake(4, 'Later.'), heartbeat, released(id, 6, 2)],
			retry,
		);
		expect(afterRelease.leases.get(id)?.readThrough).toBe(2);
		expect(pendingOf(afterRelease).map((pending) => pending.id)).toEqual(['message:4:solo:1']);
	});

	it('keeps explicit acknowledgements monotonic when they repeat or arrive out of order', () => {
		const state = replayState(
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
		expect(pendingOf(state)).toEqual([]);
	});

	it('refuses invalid lease acknowledgements without proposing an entry', () => {
		const state = replayState([composition, wake(2), held(id, 3, 2)], retry);
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
				replayState([composition, wake(2)], retry),
				{ type: 'renew', id, expiry: 60_000, deadline: 600_000 },
				now,
			),
		).toMatchObject({ refusal: { category: 'stale' } });
	});

	it('retries unread released work under a new id and abandons it at the cap', () => {
		const releasedUnread = replayState(
			[composition, wake(2), held(id, 3, 0), released(id, 4, 0)],
			retry,
		);
		expect(pendingOf(releasedUnread)).toMatchObject([
			{ id: 'message:2:solo:2', attempt: 2, unsuccessfulAttempts: 1 },
		]);

		const [abandoned, ...rest] = planReconciliation(releasedUnread, reconciliation(1)).abandoned;
		expect(rest).toEqual([]);
		if (abandoned === undefined) throw new Error('Expected an abandonment.');
		const ended = decide(releasedUnread, { type: 'end', ...abandoned }, now);
		expect(ended).toEqual({
			entry: {
				kind: 'lease',
				body: {
					id: 'message:2:solo:2',
					phase: 'ended',
					reason: 'abandoned',
					at,
					readThrough: 0,
					cause: 'transient',
				},
			},
		});
		const stopped = evolve(releasedUnread, entryAt(ended, 5), retry);
		expect(pendingOf(stopped)).toEqual([]);
		expect(planReconciliation(stopped, reconciliation(1)).sends).toEqual([]);
	});

	// An unwoken steer owes no wake, yet the released lease is the evidence it reached the seat.
	it.each([
		['a later wake', wake(4, 'Later.')],
		[
			'an unwoken steer',
			{
				kind: 'message',
				seq: 4,
				body: { kind: 'said', at, from: 'priya', text: 'Later.' },
			} as RoomEntry,
		],
	])(
		'keeps unread work after %s through release and replay, and retains the released lease',
		(_name, later) => {
			const entries = [composition, wake(2), held(id, 3, 2), later, released(id, 5, 2)];
			const incremental = evolve(foldRoom(entries.slice(0, -1), retry), released(id, 5, 2), retry);
			expect(pendingOf(incremental).map((pending) => pending.id)).toEqual(['message:4:solo:1']);
			expect(incremental.leases.get(id)).toMatchObject({ phase: 'ended', readThrough: 2 });
			expect(foldRoom(JSON.parse(JSON.stringify(entries)) as RoomEntry[], retry)).toEqual(
				incremental,
			);
		},
	);

	it('keeps an earlier unread wake when a later activation is released', () => {
		const later = 'message:4:solo:1';
		const recovered = replayState(
			[composition, wake(2), wake(4, 'Later.'), held(later, 5, 0), released(later, 6, 0)],
			retry,
		);
		expect(pendingOf(recovered).map((pending) => pending.id)).toContain('message:2:solo:1');
	});

	it('does not resurrect settled work when a fresh unread lease follows it', () => {
		const settledId = 'message:2:solo:1';
		const freshId = 'message:6:solo:1';
		const recovered = replayState(
			[
				composition,
				wake(2),
				held(settledId, 3, 2),
				released(settledId, 4, 2),
				wake(6, 'Later.'),
				held(freshId, 7, 0),
				released(freshId, 8, 0),
			],
			retry,
		);
		expect(pendingOf(recovered).map((pending) => pending.id)).toEqual(['message:6:solo:2']);
	});
});
