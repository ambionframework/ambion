import type { JournalEntry as Entry } from '@ambionframework/journal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ActivationId, ActivationSource } from '../src/activation-id.ts';
import type { Close, LeaseChange } from '../src/journal/events.ts';
import type { ActivationPurpose } from '../src/protocol.ts';
import { cameToNothing, foldLeases, type LeaseHold } from '../src/room/lease.ts';
import {
	type ActivationFields,
	applyChange,
	type Change,
	type CloseFact,
	cancelHold,
	type FailureCause,
	type GrantPurpose,
	type Hold,
	type LeaseEndReason,
	type LeasePhase,
	leaseExpiry,
	mayEnd,
	type OutcomeKind,
	type Source,
	wakeAnswered,
} from '../src/room/rules.verified.ts';
import type {
	EndReason,
	ExchangeOutcome,
	Message,
	FailureCause as PublicFailureCause,
} from '../src/types.ts';
import { pendingWakes } from './support/fold.ts';

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

const at = '2026-01-01T09:00:00.000Z';
const id = 'message:2:solo:1';
const running = (seq: number, readThrough: number): Entry<LeaseChange> => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'running', expiresAt: 60_000, at, readThrough },
});
const ended = (seq: number, reason: EndReason, readThrough: number): Entry<LeaseChange> => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'ended', reason, at, readThrough },
});
const said = (seq: number): Message => ({
	kind: 'said',
	seq,
	at,
	from: 'priya',
	text: 'Question',
	wakes: ['solo'],
});
/** The wakes the room still owes for these messages, after these lease entries. */
const pending = (messages: Message[], leases: Entry<LeaseChange>[]) =>
	pendingWakes(
		messages,
		new Map(messages.map((message) => [message.seq, { wakes: message.wakes ?? [], steers: [] }])),
		foldLeases(leases),
		new Set(['solo']),
		{ backoff: () => 1 },
	);

describe('verified rules', () => {
	it('declares the same unions the public types declare', () => {
		expectTypeOf<LeaseEndReason>().toEqualTypeOf<EndReason>();
		expectTypeOf<FailureCause>().toEqualTypeOf<PublicFailureCause>();
		expectTypeOf<LeasePhase>().toEqualTypeOf<'running' | 'ended'>();
		// Usage and session are facts of the record the rules never read, so the rules omit them.
		expectTypeOf<Change>().toEqualTypeOf<DistributiveOmit<LeaseChange, 'usage' | 'session'>>();
		expectTypeOf<Source>().toEqualTypeOf<ActivationSource>();
		expectTypeOf<ActivationFields>().toEqualTypeOf<ActivationId>();
		// The room adds the people a closing activation addresses to the rule's grant.
		expectTypeOf<GrantPurpose>().toEqualTypeOf<DistributiveOmit<ActivationPurpose, 'people'>>();
		expectTypeOf<OutcomeKind>().toEqualTypeOf<ExchangeOutcome['kind']>();
		expectTypeOf<Close>().toMatchTypeOf<CloseFact>();
		// The room's hold is the rule's hold plus the derived `cancelled` marker.
		expectTypeOf<Hold>().toEqualTypeOf<DistributiveOmit<LeaseHold, 'usage' | 'session'>>();
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
			cancelled: true,
			until: 6,
			since: 3,
			readThrough: 2,
		});
		expect(cancelHold(running, 7, 6, at)).toBe(running);
		const ended = cancelHold(running, 2, 6, at);
		expect(cancelHold(ended, 2, 9, at)).toBe(ended);
	});

	it.each([
		['running', undefined, 0, true],
		['ended', 'expired', 9, false],
		['ended', 'released', 1, false],
		['ended', 'revoked', 0, true],
	] as const)(
		'answers a wake that a %s %s lease holds: %s',
		(phase, reason, readThrough, answered) => {
			const lease = reason === undefined ? { phase } : { phase, reason };
			expect(wakeAnswered([{ ...lease, readThrough, position: 2 }], 2)).toBe(answered);
		},
	);

	it.each([
		[undefined, 'revoked', false, true],
		[undefined, 'released', false, false],
		['ended', 'revoked', true, false],
		['running', 'abandoned', false, false],
		['running', 'expired', true, true],
		['running', 'expired', false, false],
		['running', 'released', false, true],
		['running', 'failed', true, false],
	] as const)('gates a %s lease ending %s, past expiry %s: %s', (phase, reason, past, allowed) => {
		expect(mayEnd(phase, reason, past)).toBe(allowed);
	});

	it.each([
		[1_000, 1_060],
		[1_590, 1_600],
		[1_700, 1_600],
	])('expires a lease renewed at %i at the earlier of window and deadline: %i', (now, expiry) => {
		expect(leaseExpiry(now, 1_000, 60, 600)).toBe(expiry);
	});
});

describe('lease rules', () => {
	it('keeps a lease interval through its terminal entry', () => {
		const leases = foldLeases([running(2, 2), running(3, 3)]);
		const held = foldLeases([ended(8, 'released', 3)], [...leases.values()]).get(id);
		expect(held).toMatchObject({ since: 2, until: 8, readThrough: 3 });
		if (held?.phase !== 'ended') throw new Error('Expected terminal lease.');
		expect(held.until).toBeGreaterThanOrEqual(held.since);
	});

	it('retries unread released work and counts failed work', () => {
		expect(pending([said(2)], [ended(3, 'released', 0)])).toMatchObject([
			{ id: 'message:2:solo:2', unsuccessfulAttempts: 1 },
		]);
		const failed = foldLeases([ended(3, 'failed', 0)]).get(id);
		expect(failed !== undefined && cameToNothing(failed)).toBe(true);
	});

	it.each([
		['failed', ['message:2:solo:2', 'message:6:solo:2']],
		['expired', ['message:2:solo:2', 'message:6:solo:2']],
		['released', ['message:6:solo:1']],
		['revoked', ['message:6:solo:1']],
	] as const)('applies a %s end to its named work while preserving later work', (reason, ids) => {
		const leases = [running(2, 0), running(4, 4), ended(8, reason, 4)];
		expect(pending([said(2), said(6)], leases).map((wake) => wake.id)).toEqual(ids);
	});
});
