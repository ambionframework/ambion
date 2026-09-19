/**
 * The binding between the room's verified rules and the code that runs
 * them. A proof is about a rule's body; it reaches the room only when a
 * decision runs that body on the path the contract describes. Each case
 * replaces one rule with a sentinel answer and checks that the decision
 * follows it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '../src/journal/journal.ts';
import type { CommitRequest } from '../src/protocol.ts';
import { foldRoom } from '../src/room/fold.ts';
import * as rules from '../src/room/rules.verified.ts';
import { decide } from '../src/room/transition.ts';

vi.mock('../src/room/rules.verified.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/room/rules.verified.ts')>();
	return {
		...actual,
		mayEnd: vi.fn(actual.mayEnd),
		permits: vi.fn(actual.permits),
		leaseExpiry: vi.fn(actual.leaseExpiry),
		acknowledged: vi.fn(actual.acknowledged),
		speechFreshness: vi.fn(actual.speechFreshness),
		admitsClose: vi.fn(actual.admitsClose),
		survivesCancellation: vi.fn(actual.survivesCancellation),
		applyChange: vi.fn(actual.applyChange),
		cancelHold: vi.fn(actual.cancelHold),
		wakeAnswered: vi.fn(actual.wakeAnswered),
	};
});

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };
const id = 'message:3:product:1';

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		agents: [{ name: 'product', identity: 'Product.', attention: 'broadcast' }],
		available: [],
		at,
	},
};
const person: Entry = {
	kind: 'message',
	seq: 2,
	body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Person.' },
};
const question: Entry = {
	kind: 'message',
	seq: 3,
	body: { kind: 'said', at, from: 'priya', text: 'Question.', wakes: ['product'] },
};
const running: Entry = {
	kind: 'lease',
	seq: 4,
	body: { id, phase: 'running', expiresAt: now + 60_000, at, readThrough: 3 },
};
const cancel: Entry = { kind: 'cancel', seq: 4, body: { at } };

const asked = () => foldRoom([composition, person, question], options);
const claimed = () => foldRoom([composition, person, question, running], options);

describe('the room runs the verified rules', () => {
	it('ends a lease only when mayEnd says so', () => {
		const end = { type: 'end', id, reason: 'revoked', readThrough: 0 } as const;
		vi.mocked(rules.mayEnd).mockReturnValueOnce(false);
		expect(decide(claimed(), end, now)).toEqual({ event: undefined });
		expect(decide(claimed(), end, now)).toMatchObject({
			event: { kind: 'lease', body: { phase: 'ended', reason: 'revoked' } },
		});
	});

	it('permits an intent only when permits says so', () => {
		const commit: CommitRequest = {
			activation: id,
			key: 'answer',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough: 3,
		};
		vi.mocked(rules.permits).mockReturnValueOnce(false);
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/cannot submit/) },
		});
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'said', text: 'Answer.' } },
		});
	});

	it('writes the expiry leaseExpiry answers', () => {
		vi.mocked(rules.leaseExpiry).mockReturnValueOnce(12_345);
		expect(
			decide(asked(), { type: 'claim', id, expiry: 60_000, deadline: 600_000 }, now),
		).toMatchObject({ event: { kind: 'lease', body: { phase: 'running', expiresAt: 12_345 } } });
	});

	it('writes the read position acknowledged answers', () => {
		vi.mocked(rules.acknowledged).mockReturnValueOnce(3);
		expect(
			decide(
				claimed(),
				{ type: 'renew', id, expiry: 60_000, deadline: 600_000, readThrough: 0 },
				now,
			),
		).toMatchObject({ event: { kind: 'lease', body: { readThrough: 3 } } });
	});

	it('refuses or admits speech as speechFreshness answers', () => {
		const commit = (readThrough: number): CommitRequest => ({
			activation: id,
			key: 'answer',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough,
		});
		vi.mocked(rules.speechFreshness).mockReturnValueOnce('missed');
		expect(decide(claimed(), { type: 'commit', commit: commit(3) }, now)).toMatchObject({
			refusal: { category: 'missed' },
		});
		vi.mocked(rules.speechFreshness).mockReturnValueOnce('fresh');
		expect(decide(claimed(), { type: 'commit', commit: commit(2) }, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'said' } },
		});
	});

	it('writes a close only when admitsClose says so', () => {
		const close = { owner: 'priya', from: 3, through: 3, at };
		vi.mocked(rules.admitsClose).mockReturnValueOnce(false);
		expect(decide(asked(), { type: 'close', close }, now)).toEqual({ event: undefined });
		vi.mocked(rules.admitsClose).mockReturnValueOnce(true);
		expect(decide(asked(), { type: 'close', close: { ...close, through: 9 } }, now)).toMatchObject({
			event: { kind: 'close', body: { through: 9 } },
		});
	});

	it('holds the lease applyChange answers', () => {
		const sentinel = {
			id,
			phase: 'ended',
			reason: 'failed',
			at,
			claimedAt: at,
			since: 1,
			readThrough: 0,
			until: 4,
		} as const;
		vi.mocked(rules.applyChange).mockReturnValueOnce(sentinel);
		expect(claimed().leases.get(id)).toEqual(sentinel);
		expect(claimed().leases.get(id)).toMatchObject({ phase: 'running' });
	});

	it('ends a lease at a cancellation only as cancelHold answers', () => {
		const state = () =>
			foldRoom([composition, person, question, running, { ...cancel, seq: 5 }], options);
		vi.mocked(rules.cancelHold).mockImplementationOnce((hold) => hold);
		expect(state().leases.get(id)).toMatchObject({ phase: 'running' });
		expect(state().leases.get(id)).toMatchObject({
			phase: 'ended',
			reason: 'revoked',
			cancelled: true,
		});
	});

	it('owes a wake only when wakeAnswered says nobody answered it', () => {
		vi.mocked(rules.wakeAnswered).mockReturnValueOnce(true);
		expect(asked().pending).toEqual([]);
		expect(asked().pending.map((wake) => wake.id)).toEqual([id]);
	});

	it('keeps a pending wake only when survivesCancellation says so', () => {
		vi.mocked(rules.survivesCancellation).mockReturnValue(false);
		expect(asked().pending).toEqual([]);
		vi.mocked(rules.survivesCancellation).mockReset();
		vi.mocked(rules.survivesCancellation).mockImplementation(
			(position, cancelledAt) => cancelledAt === undefined || position >= cancelledAt,
		);
		expect(asked().pending.map((wake) => wake.id)).toEqual([id]);
		expect(foldRoom([composition, person, question, cancel], options).pending).toEqual([]);
	});
});
