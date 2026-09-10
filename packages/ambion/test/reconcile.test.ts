/**
 * `decide` is pure: it reads a folded state and the clock, and says what to
 * write and send. A decision applied and decided again writes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/log/log.ts';
import { foldRoom, type RoomState } from '../src/room/fold.ts';
import { type DecideOptions, decide, working } from '../src/room/reconcile.ts';
import type { Message } from '../src/types.ts';
import type { CloseRow, LeaseRow, Without } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const T0 = Date.parse(at);
const retry = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

const composition = (): LogEntry => ({
	type: 'composition',
	composition: {
		assistant: { name: 'assistant', identity: 'Writes the one message.', attention: 'none' },
		agents: [{ name: 'product', identity: 'The product.', attention: 'broadcast' }],
		available: [{ name: 'surveyor', identity: 'Holds the tonnage.', attention: 'broadcast' }],
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

const fold = (entries: LogEntry[]): RoomState => foldRoom(entries, retry);
const options = (over: Partial<DecideOptions> = {}): DecideOptions => ({
	now: T0,
	resend: 5_000,
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
	it('ends a lease past its expiry, and closes on the fold that holds the expiry', () => {
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
		expect(decision.close).toBeUndefined();
	});

	it('closes an exchange nothing works on, names the assistant when two agents spoke, and drafts', () => {
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
		expect(decision.sends).toEqual([]);
		// once the close is on the log, the draft it owes is due
		const closed = fold([
			...opened(),
			said(3, 'product', { activationId: '2:product' }),
			said(4, 'product', { activationId: '2:product' }),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 4, wakes: ['assistant'] }),
		]);
		expect(decide(closed, options()).sends).toEqual([{ id: 'close:4:1', seat: 'assistant' }]);
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
		// at the cap the draft is owed no longer: nothing is sent, and no alarm waits on it
		const capped = fold([...owed, failed(2, T0 + 40_000), failed(3, T0 + 100_000)]);
		expect(capped.owed).toEqual([]);
		expect(decide(capped, options({ now: T0 + 1_000_000 }))).toMatchObject({
			sends: [],
			alarmAt: undefined,
		});
	});

	it('answers a wake with any lease of its id, and leaves a seat that left the roster no wake', () => {
		// the seat claimed, and its lease expired without a word: the wake is answered, not retried
		const expired = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			lease({ id: '2:product', phase: 'ended', reason: 'expired', at }),
		]);
		expect(expired.pending).toEqual([]);
		expect(working(expired, T0 + 60_000)).toBe(false);
		expect(decide(expired, options({ now: T0 + 60_000 })).close).toMatchObject({ through: 2 });
		// a seat the host unseated answers nothing: what it was sent is not pending
		const unseated = fold([
			...opened(),
			{ type: 'message', message: { kind: 'unseated', seq: 3, at, from: 'product' } },
		]);
		expect(unseated.pending).toEqual([]);
	});

	it('writes nothing the second time', () => {
		const entries = [
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			said(4, 'product', { activationId: '2:product' }),
		];
		const now = T0 + 60_000;
		// pass one: the lease expires, and the close waits for the fold that holds the expiry
		const first = decide(fold(entries), options({ now }));
		expect(first.expired).toHaveLength(1);
		expect(first).toMatchObject({ close: undefined, sends: [] });
		// pass two: nothing is live, so the exchange closes
		const expired: LogEntry[] = [...entries, ...first.expired.map((row) => lease(row))];
		const second = decide(fold(expired), options({ now }));
		expect(second).toMatchObject({ expired: [], sends: [] });
		expect(second.close).toMatchObject({ through: 4, wakes: ['assistant'] });
		// pass three: the draft the close owes is sent
		const closed: LogEntry[] = [
			...expired,
			...(second.close ? [{ type: 'close' as const, close: { ...second.close, after: 4 } }] : []),
		];
		const third = decide(fold(closed), options({ now }));
		expect(third).toMatchObject({ expired: [], close: undefined });
		expect(third.sends).toEqual([{ id: 'close:4:1', seat: 'assistant' }]);
		// pass four: nothing
		const sent = new Set(third.sends.map((send) => send.id));
		const fourth = decide(
			fold(closed),
			options({ now, sentAt: (id) => (sent.has(id) ? now : undefined) }),
		);
		expect(fourth).toMatchObject({ expired: [], close: undefined, sends: [] });
		expect(fourth.alarmAt).toBe(now + 5_000);
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
