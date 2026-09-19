import type { JournalEntry as Entry } from '@ambionframework/journal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ActivationId, ActivationSource } from '../src/activation-id.ts';
import type { Close, LeaseChange } from '../src/journal/events.ts';
import type { ActivationPurpose, ActivationSpec, CommitRequest } from '../src/protocol.ts';
import { cameToNothing, foldLeases, type LeaseHold, pendingWakes } from '../src/room/lease.ts';
import type { PersonState } from '../src/room/presence.ts';
import {
	type ActivationFields,
	type Attention,
	applyChange,
	type Change,
	type CloseFact,
	cancelHold,
	endingStands,
	type GrantPurpose,
	type Hold,
	type Intent,
	type LeaseEndReason,
	type LeasePhase,
	leaseExpiry,
	type MessageKind,
	mayEnd,
	type Person,
	type Presence,
	type Purpose,
	permits,
	type Source,
	schedule,
	stillExpired,
	wakeAnswered,
} from '../src/room/rules.verified.ts';
import type {
	EndReason,
	Message,
	PresenceStatus,
	Attention as PublicAttention,
} from '../src/types.ts';

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
		expectTypeOf<Change>().toEqualTypeOf<LeaseChange>();
		expectTypeOf<Source>().toEqualTypeOf<ActivationSource>();
		expectTypeOf<Attention>().toEqualTypeOf<PublicAttention>();
		expectTypeOf<MessageKind>().toEqualTypeOf<Message['kind']>();
		expectTypeOf<Presence>().toEqualTypeOf<PresenceStatus>();
		expectTypeOf<Person>().toMatchTypeOf<PersonState>();
		expectTypeOf<PersonState>().toMatchTypeOf<Person>();
		expectTypeOf<ActivationFields>().toEqualTypeOf<ActivationId>();
		expectTypeOf<GrantPurpose>().toEqualTypeOf<ActivationPurpose>();
		expectTypeOf<Close>().toMatchTypeOf<CloseFact>();
		// The room's hold is the rule's hold plus the derived `cancelled` marker.
		expectTypeOf<Hold>().toMatchTypeOf<LeaseHold>();
		expectTypeOf<LeaseHold>().toMatchTypeOf<Hold>();
	});

	it('folds one lease entry: ended is final, since is fixed, readThrough never moves back', () => {
		const first = applyChange(
			undefined,
			{ id: 'message:2:solo:1', phase: 'running', expiresAt: 9, at, readThrough: 2 },
			3,
		);
		expect(first).toMatchObject({ phase: 'running', since: 3, claimedAt: at, readThrough: 2 });
		const renewed = applyChange(
			first,
			{ id: 'message:2:solo:1', phase: 'running', expiresAt: 19, at, readThrough: 0 },
			5,
		);
		expect(renewed).toMatchObject({ since: 3, readThrough: 2, expiresAt: 19 });
		const ended = applyChange(
			renewed,
			{ id: 'message:2:solo:1', phase: 'ended', reason: 'released', at, readThrough: 4 },
			8,
		);
		expect(ended).toMatchObject({ phase: 'ended', since: 3, until: 8, readThrough: 4 });
		expect(
			applyChange(
				ended,
				{ id: 'message:2:solo:1', phase: 'running', expiresAt: 99, at, readThrough: 9 },
				9,
			),
		).toBe(ended);
	});

	it('cancels a running lease caused before the marker and leaves every other lease alone', () => {
		const running: Hold = {
			id: 'message:2:solo:1',
			phase: 'running',
			at,
			claimedAt: at,
			since: 3,
			readThrough: 2,
			expiresAt: 9,
		};
		expect(cancelHold(running, 2, 6, at)).toMatchObject({
			phase: 'ended',
			reason: 'revoked',
			until: 6,
			since: 3,
			readThrough: 2,
		});
		expect(cancelHold(running, 7, 6, at)).toBe(running);
		const ended = cancelHold(running, 2, 6, at);
		expect(cancelHold(ended, 2, 9, at)).toBe(ended);
	});

	it('accepts at the write the ending the decision made', () => {
		expect(stillExpired(1_000, 1_000, 1_500)).toBe(true);
		// Expired at the decision, and still expired at the write.
		expect(endingStands(false, 1_000, 1_000, 1_500)).toBe(true);
		// Revoked: no clock.
		expect(endingStands(true, 9_000, 1_000, 1_500)).toBe(true);
		// Neither: the lease stays.
		expect(endingStands(false, 9_000, 1_000, 1_500)).toBe(false);
	});

	it('answers a wake by reason and schedules the next attempt after the backoff', () => {
		expect(wakeAnswered([{ phase: 'running', readThrough: 0, position: 2 }], 2)).toBe(true);
		expect(
			wakeAnswered([{ phase: 'ended', reason: 'expired', readThrough: 9, position: 2 }], 2),
		).toBe(false);
		expect(
			wakeAnswered([{ phase: 'ended', reason: 'released', readThrough: 1, position: 2 }], 2),
		).toBe(false);
		expect(
			wakeAnswered([{ phase: 'ended', reason: 'revoked', readThrough: 0, position: 2 }], 2),
		).toBe(true);
		expect(schedule(0, 0, 0)).toEqual({ attempt: 1, notBefore: undefined });
		expect(schedule(2, 1_000, 300)).toEqual({ attempt: 3, notBefore: 1_300 });
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
