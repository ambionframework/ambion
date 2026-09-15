import type { JournalEntry as Entry } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { cameToNothing, foldLeases, pendingWakes } from '../src/room/lease.ts';
import type { Message } from '../src/types.ts';
import type { EndReason, LeaseChange } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const lease = (seq: number, body: LeaseChange): Entry<LeaseChange> => ({
	kind: 'lease',
	seq,
	body,
});

describe('lease rules', () => {
	it('keeps a lease interval through its terminal entry', () => {
		const leases = foldLeases([
			lease(2, { id: 'message:2:solo:1', phase: 'running', expiresAt: 60_000, at, readThrough: 2 }),
			lease(3, { id: 'message:2:solo:1', phase: 'running', expiresAt: 60_000, at, readThrough: 3 }),
		]);
		const carried = foldLeases(
			[
				lease(8, {
					id: 'message:2:solo:1',
					phase: 'ended',
					reason: 'released',
					at,
					readThrough: 3,
				}),
			],
			[...leases.values()],
		);
		const held = carried.get('message:2:solo:1');
		expect(held).toMatchObject({ since: 2, until: 8, readThrough: 3 });
		if (held?.phase !== 'ended') throw new Error('Expected terminal lease.');
		expect(held.until).toBeGreaterThanOrEqual(held.since);
	});

	it('retries unread released work and counts failed work', () => {
		const message: Message = {
			kind: 'said',
			seq: 2,
			at,
			from: 'priya',
			text: 'Question',
			wakes: ['solo'],
		};
		const released = foldLeases([
			lease(3, { id: 'message:2:solo:1', phase: 'ended', reason: 'released', at, readThrough: 0 }),
		]);
		expect(
			pendingWakes([message], released, new Set(['solo']), { backoff: () => 1 }, () => 'message'),
		).toMatchObject([{ id: 'message:2:solo:2', unsuccessfulAttempts: 1 }]);
		const failed = foldLeases([
			lease(3, { id: 'message:2:solo:1', phase: 'ended', reason: 'failed', at, readThrough: 0 }),
		]).get('message:2:solo:1');
		expect(failed !== undefined && cameToNothing(failed)).toBe(true);
	});

	it('applies each terminal reason to its named work while preserving later work', () => {
		const message = (seq: number): Message => ({
			kind: 'said',
			seq,
			at,
			from: 'priya',
			text: 'Question',
			wakes: ['solo'],
		});
		const pending = (reason: EndReason) =>
			pendingWakes(
				[message(2), message(6)],
				foldLeases([
					lease(2, {
						id: 'message:2:solo:1',
						phase: 'running',
						expiresAt: 60_000,
						at,
						readThrough: 0,
					}),
					lease(4, {
						id: 'message:2:solo:1',
						phase: 'running',
						expiresAt: 60_000,
						at,
						readThrough: 4,
					}),
					lease(8, { id: 'message:2:solo:1', phase: 'ended', reason, at, readThrough: 4 }),
				]),
				new Set(['solo']),
				{ backoff: () => 1 },
				() => 'message',
			).map((wake) => wake.id);
		expect(pending('failed')).toEqual(['message:2:solo:2', 'message:6:solo:2']);
		expect(pending('expired')).toEqual(['message:2:solo:2', 'message:6:solo:2']);
		expect(pending('refused')).toEqual(['message:6:solo:2']);
		expect(pending('released')).toEqual(['message:6:solo:1']);
		expect(pending('revoked')).toEqual(['message:6:solo:1']);
	});
});
