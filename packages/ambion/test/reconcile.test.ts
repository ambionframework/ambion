/**
 * `decide` is pure: it reads a folded state and the clock, and says what to
 * write and send. A decision applied and decided again writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { foldRoom, type RoomState } from '../src/fold.ts';
import type { LogEntry } from '../src/log.ts';
import { type DecideOptions, decide, working } from '../src/reconcile.ts';
import type { Message } from '../src/types.ts';
import type { CloseRow, LeaseRow, Without } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const T0 = Date.parse(at);
const backoff = (attempt: number) => attempt * 30_000;

const composition = (): LogEntry => ({
	type: 'composition',
	composition: {
		assistant: 'assistant',
		agents: [{ name: 'product', attention: 'broadcast' }],
		available: [{ name: 'surveyor', attention: 'broadcast' }],
		after: 0,
		at,
	},
});
const said = (seq: number, from: string, extra: Partial<Message> = {}): LogEntry => ({
	type: 'message',
	message: { kind: 'said', seq, at, from, text: `message ${seq}`, ...extra } as Message,
});
const arrived = (seq: number, from: string): LogEntry => ({
	type: 'message',
	message: { kind: 'arrived', seq, at, from, identity: 'A person.' },
});
const lease = (row: Without<LeaseRow, 'after'>): LogEntry => ({
	type: 'lease',
	lease: { ...row, after: 0 } as LeaseRow,
});
const close = (row: Omit<CloseRow, 'after' | 'at'>): LogEntry => ({
	type: 'close',
	close: { ...row, after: row.through, at },
});

const fold = (entries: LogEntry[]): RoomState => foldRoom(entries, { backoff });
const options = (over: Partial<DecideOptions> = {}): DecideOptions => ({
	now: T0,
	resend: 5_000,
	attempts: 3,
	sentAt: () => undefined,
	stopped: false,
	...over,
});

/** The question, and the seat it woke. */
const opened = (): LogEntry[] => [
	composition(),
	arrived(1, 'priya'),
	said(2, 'priya', { wakes: ['product'] }),
];

describe('decide', () => {
	it('ends a lease past its expiry, and closes the exchange it was holding open', () => {
		const state = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
		]);
		expect(decide(state, options({ now: T0 + 59_999 }))).toMatchObject({
			expired: [],
			close: undefined,
		});
		const decision = decide(state, options({ now: T0 + 60_000 }));
		expect(decision.expired).toEqual([
			{
				id: '2:product',
				phase: 'ended',
				reason: 'expired',
				at: new Date(T0 + 60_000).toISOString(),
			},
		]);
		expect(decision.close).toMatchObject({ owner: 'priya', from: 2, through: 2 });
		expect(decision.close?.wakes).toBeUndefined();
	});

	it('closes an exchange nothing works on, and names the assistant when two agents spoke', () => {
		const state = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			said(4, 'product', { activationId: '2:product' }),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at }),
		]);
		const decision = decide(state, options());
		expect(decision.close).toEqual({
			owner: 'priya',
			from: 2,
			through: 4,
			at,
			wakes: ['assistant'],
		});
		expect(decision.sends).toEqual([{ id: 'close:4:1', seat: 'assistant' }]);
	});

	it('holds the exchange open while a seat is live or a wake is pending, and lets a draft close none', () => {
		const pending = fold(opened());
		expect(working(pending, T0)).toBe(true);
		expect(decide(pending, options()).close).toBeUndefined();
		const drafting = fold([
			...opened(),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 2 }),
			said(3, 'priya'),
			lease({ id: 'close:2:1', phase: 'running', expiry: T0 + 60_000, at }),
		]);
		expect(working(drafting, T0)).toBe(false);
		const composing = fold([
			...opened(),
			lease({ id: '2:assistant', phase: 'running', expiry: T0 + 60_000, at }),
		]);
		expect(working(composing, T0)).toBe(true);
	});

	it('sends a pending wake it never sent, and again once the resend window passed', () => {
		const state = fold(opened());
		expect(decide(state, options()).sends).toEqual([{ id: '2:product', seat: 'product' }]);
		const sent = options({ now: T0 + 4_999, sentAt: () => T0 });
		expect(decide(state, sent).sends).toEqual([]);
		expect(decide(state, sent).alarmAt).toBe(T0 + 5_000);
		expect(decide(state, options({ now: T0 + 5_000, sentAt: () => T0 })).sends).toEqual([
			{ id: '2:product', seat: 'product' },
		]);
	});

	it('drafts again after the backoff, and stops at the cap', () => {
		const failed = (n: number, when: number) =>
			lease({
				id: `close:4:${n}`,
				phase: 'ended',
				reason: 'failed',
				at: new Date(when).toISOString(),
			});
		const owed = [
			...opened(),
			said(3, 'product', { activationId: '2:product' }),
			said(4, 'product', { activationId: '2:product' }),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 4, wakes: ['assistant'] }),
			lease({ id: 'close:4:1', phase: 'running', expiry: T0 + 60_000, at }),
			failed(1, T0 + 1_000),
		];
		const once = fold(owed);
		expect(once.owed).toMatchObject([
			{ person: 'priya', from: 2, through: 4, attempts: 1, notBefore: T0 + 31_000 },
		]);
		expect(decide(once, options({ now: T0 + 30_999 })).sends).toEqual([]);
		expect(decide(once, options({ now: T0 + 30_999 })).alarmAt).toBe(T0 + 31_000);
		expect(decide(once, options({ now: T0 + 31_000 })).sends).toEqual([
			{ id: 'close:4:2', seat: 'assistant' },
		]);
		const capped = fold([...owed, failed(2, T0 + 40_000), failed(3, T0 + 100_000)]);
		expect(capped.owed[0]?.attempts).toBe(3);
		expect(decide(capped, options({ now: T0 + 1_000_000 }))).toMatchObject({
			sends: [],
			alarmAt: undefined,
		});
	});

	it('writes nothing the second time', () => {
		const entries = [
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			said(4, 'product', { activationId: '2:product' }),
		];
		const now = T0 + 60_000;
		const first = decide(fold(entries), options({ now }));
		expect(first.expired).toHaveLength(1);
		expect(first.close).toBeDefined();
		expect(first.sends).toHaveLength(1);
		// apply: the rows land, the wakes are sent
		const applied: LogEntry[] = [
			...entries,
			...first.expired.map((row) => lease(row)),
			...(first.close ? [{ type: 'close' as const, close: { ...first.close, after: 4 } }] : []),
		];
		const sent = new Set(first.sends.map((send) => send.id));
		const second = decide(
			fold(applied),
			options({ now, sentAt: (id) => (sent.has(id) ? now : undefined) }),
		);
		expect(second).toMatchObject({ expired: [], close: undefined, sends: [] });
		expect(second.alarmAt).toBe(now + 5_000);
	});

	it('closes nothing and wakes nobody once stopped', () => {
		const state = fold([
			...opened(),
			lease({ id: '2:product', phase: 'ended', reason: 'revoked', at }),
		]);
		expect(decide(state, options({ stopped: true }))).toEqual({
			expired: [],
			close: undefined,
			sends: [],
			alarmAt: undefined,
		});
	});
});
