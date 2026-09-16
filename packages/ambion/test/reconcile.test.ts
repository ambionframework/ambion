import { describe, expect, it } from 'vitest';
import { decodeActivationId } from '../src/activation-id.ts';
import type { Close, LeaseChange } from '../src/journal/events.ts';
import type { Body, Entry } from '../src/journal/journal.ts';
import { foldRoom, type RoomState } from '../src/room/fold.ts';
import { liveWork, planReconciliation, type ReconcileOptions } from '../src/room/reconcile.ts';
import type { Message } from '../src/types.ts';

const at = '2026-01-01T09:00:00.000Z';
const T0 = Date.parse(at);
const retry = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

const composition = (): Entry => ({
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		summary: 'writer',
		agents: [
			{ name: 'product', identity: 'Product.', attention: 'broadcast' },
			{ name: 'writer', identity: 'Writer.', attention: 'broadcast' },
		],
		available: [{ name: 'reserve', identity: 'Reserve.', attention: 'broadcast' }],
		at,
	},
});

const arrived = (seq = 2, from = 'priya'): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'arrived', at, from, subject: from, identity: 'Person.' },
});

const said = (seq = 3, from = 'priya', extra: Partial<Message> = {}): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'said', at, from, text: `Message ${seq}`, ...extra } as Body<Message>,
});

const sourcePosition = (id: string): number => decodeActivationId(id)?.position ?? 0;
const lease = (body: LeaseChange, seq = sourcePosition(body.id)): Entry => ({
	kind: 'lease',
	body,
	seq,
});
const close = (body: Omit<Close, 'at'>, seq = body.through): Entry => ({
	kind: 'close',
	body: { ...body, at },
	seq,
});
const fold = (entries: Entry[]): RoomState => foldRoom(entries, retry);
const options = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
	now: T0,
	resend: 5_000,
	attempts: retry.attempts,
	sent: new Map(),
	stopped: false,
	...over,
});

describe('room reconciliation', () => {
	it('expires a running activation before closing its exchange', () => {
		const state = fold([
			composition(),
			arrived(),
			said(),
			lease({
				id: 'message:3:product:1',
				phase: 'running',
				expiresAt: T0 + 60_000,
				at,
				readThrough: 0,
			}),
		]);
		expect(planReconciliation(state, options({ now: T0 + 59_999 }))).toMatchObject({
			expired: [],
			close: undefined,
		});
		const result = planReconciliation(state, options({ now: T0 + 60_000 }));
		expect(result.expired).toMatchObject([{ id: 'message:3:product:1', reason: 'expired' }]);
		expect(result.close).toBeUndefined();
	});

	it('closes a quiet human exchange and assigns its configured seated writer', () => {
		const state = fold([
			composition(),
			arrived(),
			said(),
			lease({ id: 'message:3:product:1', phase: 'ended', reason: 'released', at, readThrough: 3 }),
		]);
		expect(planReconciliation(state, options()).close).toEqual({
			owner: 'priya',
			from: 3,
			through: 3,
			at,
			summary: 'writer',
		});
	});

	it('does not assign a summary when the human owner is absent or the writer is unseated', () => {
		const absentOwner = fold([
			composition(),
			said(2, 'visitor'),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at, readThrough: 2 }),
		]);
		expect(planReconciliation(absentOwner, options()).close).toEqual(undefined);

		const writerLeft = fold([
			composition(),
			arrived(),
			said(),
			{ kind: 'message', seq: 4, body: { kind: 'unseated', at, subject: 'writer' } },
			lease({ id: 'message:3:product:1', phase: 'ended', reason: 'released', at, readThrough: 3 }),
		]);
		expect(planReconciliation(writerLeft, options()).close).toEqual({
			owner: 'priya',
			from: 3,
			through: 4,
			at,
		});
	});

	it('holds an exchange while an ordinary wake or lease is live, but not for summary work', () => {
		const pending = fold([
			composition(),
			arrived(),
			said(3, 'priya', { wakes: ['product', 'writer'] }),
		]);
		expect(liveWork(pending, T0).exchange).toBe(true);
		expect(planReconciliation(pending, options()).close).toBeUndefined();

		const closing = fold([
			composition(),
			arrived(),
			said(),
			lease({ id: 'message:3:product:1', phase: 'ended', reason: 'released', at, readThrough: 3 }),
			close({ owner: 'priya', from: 3, through: 3, summary: 'writer' }),
			lease({
				id: 'closed:3:writer:1',
				phase: 'running',
				expiresAt: T0 + 60_000,
				at,
				readThrough: 0,
			}),
		]);
		expect(liveWork(closing, T0).exchange).toBe(false);
	});

	it('sends a pending ordinary wake immediately and after its resend window', () => {
		const state = fold([composition(), arrived(), said(3, 'priya', { wakes: ['product'] })]);
		expect(planReconciliation(state, options()).sends).toEqual([
			{ id: 'message:3:product:1', seat: 'product' },
		]);
		expect(
			planReconciliation(
				state,
				options({ now: T0 + 4_999, sent: new Map([['message:3:product:1', T0]]) }),
			).sends,
		).toEqual([]);
		expect(
			planReconciliation(
				state,
				options({ now: T0 + 5_000, sent: new Map([['message:3:product:1', T0]]) }),
			).sends,
		).toEqual([{ id: 'message:3:product:1', seat: 'product' }]);
	});

	it('does not revive a wake recorded before removal when the name is reseated', () => {
		const state = fold([
			composition(),
			arrived(),
			said(3, 'priya', { wakes: ['writer'] }),
			{ kind: 'message', seq: 4, body: { kind: 'unseated', at, subject: 'writer' } },
			{
				kind: 'message',
				seq: 5,
				body: {
					kind: 'seated',
					at,
					subject: 'writer',
					identity: 'Writer.',
					attention: 'broadcast',
				},
			},
		]);
		expect(state.roster.map((seat) => seat.name)).toContain('writer');
		expect(state.pending.some((wake) => wake.id === 'message:3:writer:1')).toBe(false);
	});

	it('durably revokes a running activation left behind by removal', () => {
		const state = fold([
			composition(),
			arrived(),
			said(3, 'priya', { wakes: ['writer'] }),
			lease({
				id: 'message:3:writer:1',
				phase: 'running',
				expiresAt: T0 + 60_000,
				at,
				readThrough: 0,
			}),
			{ kind: 'message', seq: 4, body: { kind: 'unseated', at, subject: 'writer' } },
		]);
		const result = planReconciliation(state, options());
		expect(result.revoked).toMatchObject([{ id: 'message:3:writer:1', reason: 'revoked' }]);
		expect(result.expired).toEqual([]);
		expect(result.close).toBeUndefined();
	});

	it('revokes a removed lease even after its expiry deadline', () => {
		const state = fold([
			composition(),
			arrived(),
			said(3, 'priya', { wakes: ['writer'] }),
			lease({ id: 'message:3:writer:1', phase: 'running', expiresAt: T0 - 1, at, readThrough: 0 }),
			{ kind: 'message', seq: 4, body: { kind: 'unseated', at, subject: 'writer' } },
		]);
		const result = planReconciliation(state, options());
		expect(result.revoked).toMatchObject([{ id: 'message:3:writer:1', reason: 'revoked' }]);
		expect(result.expired).toEqual([]);
	});

	it('retries a failed summary after backoff and abandons it at the configured cap', () => {
		const base = [
			composition(),
			arrived(),
			said(),
			lease({ id: 'message:3:product:1', phase: 'ended', reason: 'released', at, readThrough: 3 }),
			close({ owner: 'priya', from: 3, through: 3, summary: 'writer' }),
		];
		const failed = (attempt: number, when: number): Entry =>
			lease({
				id: `closed:3:writer:${attempt}`,
				phase: 'ended',
				reason: 'failed',
				at: new Date(when).toISOString(),
				readThrough: 0,
			});
		const once = fold([...base, failed(1, T0 + 1_000)]);
		expect(once.owed).toMatchObject([{ unsuccessfulAttempts: 1, notBefore: T0 + 31_000 }]);
		expect(planReconciliation(once, options({ now: T0 + 30_999 })).sends).toEqual([]);
		expect(planReconciliation(once, options({ now: T0 + 31_000 })).sends).toEqual([
			{ id: 'closed:3:writer:2', seat: 'writer' },
		]);

		const capped = fold([
			...base,
			failed(1, T0 + 1_000),
			failed(2, T0 + 40_000),
			failed(3, T0 + 100_000),
		]);
		expect(planReconciliation(capped, options({ now: T0 + 1_000_000 }))).toMatchObject({
			abandoned: [{ id: 'closed:3:writer:4', reason: 'abandoned' }],
			sends: [],
			alarmAt: undefined,
		});
	});

	it('does not reopen a published summary after a later message or writer removal', () => {
		const published: Message = {
			kind: 'summary',
			seq: 5,
			at,
			from: 'writer',
			to: 'priya',
			text: 'Done.',
			covers: { from: 3, through: 3 },
		};
		const state = fold([
			composition(),
			arrived(),
			said(),
			lease({ id: 'message:3:product:1', phase: 'ended', reason: 'released', at, readThrough: 3 }),
			close({ owner: 'priya', from: 3, through: 3, summary: 'writer' }),
			{ kind: 'message', seq: 5, body: published },
			{ kind: 'message', seq: 6, body: { kind: 'unseated', at, subject: 'writer' } },
		]);
		expect(state.owed).toEqual([]);
	});
});
