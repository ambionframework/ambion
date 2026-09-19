import type { JournalEntry as Entry } from '@ambionframework/journal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { LeaseChange } from '../src/journal/events.ts';
import { cameToNothing, foldLeases, pendingWakes } from '../src/room/lease.ts';
import {
	type Intent,
	type LeaseEndReason,
	type LeasePhase,
	leaseExpiry,
	mayEnd,
	permits,
	type Purpose,
} from '../src/room/rules.verified.ts';
import type { CommitRequest } from '../src/protocol.ts';
import type { ActivationSpec } from '../src/protocol.ts';
import type { EndReason, Message } from '../src/types.ts';

const at = '2026-01-01T09:00:00.000Z';
const lease = (seq: number, body: LeaseChange): Entry<LeaseChange> => ({
	kind: 'lease',
	seq,
	body,
});

const explicitDeliveries = (messages: Message[]) =>
	new Map(messages.map((message) => [message.seq, { wakes: message.wakes ?? [], steers: [] }]));

describe('verified rules', () => {
	it('declares the same unions the public types declare', () => {
		expectTypeOf<LeaseEndReason>().toEqualTypeOf<EndReason>();
		expectTypeOf<LeasePhase>().toEqualTypeOf<'running' | 'ended'>();
		expectTypeOf<Purpose>().toEqualTypeOf<ActivationSpec['purpose']['kind']>();
		expectTypeOf<Intent>().toEqualTypeOf<CommitRequest['intent']['kind']>();
	});

	it('gates every end reason by the lease phase and the clock', () => {
		expect(mayEnd(undefined, 'revoked', false)).toBe(true);
		expect(mayEnd(undefined, 'released', false)).toBe(false);
		expect(mayEnd('ended', 'revoked', true)).toBe(false);
		expect(mayEnd('running', 'abandoned', false)).toBe(false);
		expect(mayEnd('running', 'expired', true)).toBe(true);
		expect(mayEnd('running', 'expired', false)).toBe(false);
		expect(mayEnd('running', 'released', false)).toBe(true);
		expect(mayEnd('running', 'failed', true)).toBe(false);
	});

	it('permits speech under both purposes and membership under a response only', () => {
		expect(permits('summarize', 'said')).toBe(true);
		expect(permits('summarize', 'seated')).toBe(false);
		expect(permits('respond', 'unseated')).toBe(true);
	});

	it('expires a lease at the earlier of the renewal window and the deadline', () => {
		expect(leaseExpiry(1_000, 1_000, 60, 600)).toBe(1_060);
		expect(leaseExpiry(1_590, 1_000, 60, 600)).toBe(1_600);
		expect(leaseExpiry(1_700, 1_000, 60, 600)).toBe(1_600);
	});
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
			pendingWakes([message], explicitDeliveries([message]), released, new Set(['solo']), {
				backoff: () => 1,
			}),
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
		const pending = (reason: EndReason) => {
			const messages = [message(2), message(6)];
			const leases = foldLeases([
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
			]);
			return pendingWakes(messages, explicitDeliveries(messages), leases, new Set(['solo']), {
				backoff: () => 1,
			}).map((wake) => wake.id);
		};
		expect(pending('failed')).toEqual(['message:2:solo:2', 'message:6:solo:2']);
		expect(pending('expired')).toEqual(['message:2:solo:2', 'message:6:solo:2']);
		expect(pending('released')).toEqual(['message:6:solo:1']);
		expect(pending('revoked')).toEqual(['message:6:solo:1']);
	});
});
