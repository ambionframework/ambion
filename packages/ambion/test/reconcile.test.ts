/**
 * `decide` is pure: it reads a folded state and the clock, and says what to
 * write and send. A decision applied and decided again writes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../src/log/log.ts';
import { foldRoom, type RoomState } from '../src/room/fold.ts';
import { parseId } from '../src/room/lease.ts';
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
/** A lease row lands after the message that caused it, or after the close a draft answers. */
const afterOf = (id: string): number => {
	const parsed = parseId(id);
	return parsed === undefined ? 0 : parsed.kind === 'wake' ? parsed.seq : parsed.through;
};
const lease = (row: Without<LeaseRow, 'after'>): LogEntry => ({
	type: 'lease',
	lease: { ...row, after: afterOf(row.id) } as LeaseRow,
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

	it('wakes the seat again after a lease that came to nothing, and stops at the cap', () => {
		const ended = (id: string, reason: 'expired' | 'failed' | 'released', when: number) =>
			lease({ id, phase: 'ended', reason, at: new Date(when).toISOString() });
		// the seat claimed, and its lease expired without a word: the wake is
		// pending again under the next attempt's id, after the backoff
		const expired = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			ended('2:product', 'expired', T0 + 60_000),
		]);
		expect(expired.pending).toMatchObject([
			{ id: '2:product:2', seat: 'product', seq: 2, attempts: 1, notBefore: T0 + 90_000 },
		]);
		expect(working(expired, T0 + 60_000)).toBe(true);
		expect(decide(expired, options({ now: T0 + 60_000 }))).toMatchObject({
			close: undefined,
			sends: [],
			alarmAt: T0 + 90_000,
		});
		expect(decide(expired, options({ now: T0 + 90_000 })).sends).toEqual([
			{ id: '2:product:2', seat: 'product' },
		]);
		// a lease that spoke and then expired answers nothing: the seat reads its own
		// words at the next attempt
		const spoke = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			ended('2:product', 'expired', T0 + 60_000),
		]);
		expect(spoke.pending).toMatchObject([{ id: '2:product:2', attempts: 1 }]);
		// a lease that stood down answers every message it heard, and every one its view held
		const stood = fold([
			...opened(),
			said(3, 'priya', { wakes: ['product'] }),
			lease({ id: '3:product', phase: 'running', expiry: T0 + 60_000, at }),
			ended('3:product', 'released', T0 + 1_000),
		]);
		expect(stood.pending).toEqual([]);
		// at the cap the wake is pending no longer: the exchange closes
		const capped = fold([
			...opened(),
			ended('2:product', 'failed', T0 + 1_000),
			ended('2:product:2', 'failed', T0 + 40_000),
			ended('2:product:3', 'expired', T0 + 100_000),
		]);
		expect(capped.pending).toEqual([]);
		expect(working(capped, T0 + 100_000)).toBe(false);
		expect(decide(capped, options({ now: T0 + 100_000 })).close).toMatchObject({ through: 2 });
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
		// pass two: the expired lease answers nothing, so the wake is pending again after
		// the backoff, the exchange stays open, and the alarm waits for the backoff
		const expired: LogEntry[] = [...entries, ...first.expired.map((row) => lease(row))];
		const second = decide(fold(expired), options({ now }));
		expect(second).toMatchObject({ expired: [], close: undefined, sends: [] });
		expect(second.alarmAt).toBe(now + 30_000);
		// pass three, after the backoff: the seat is woken again
		const later = now + 30_000;
		const third = decide(fold(expired), options({ now: later }));
		expect(third).toMatchObject({ expired: [], close: undefined });
		expect(third.sends).toEqual([{ id: '2:product:2', seat: 'product' }]);
		// pass four: the seat read its own words and stood down, so the exchange closes
		const stood: LogEntry[] = [
			...expired,
			lease({ id: '2:product:2', phase: 'running', expiry: later + 60_000, at }),
			lease({ id: '2:product:2', phase: 'ended', reason: 'released', at }),
		];
		const fourth = decide(fold(stood), options({ now: later }));
		expect(fourth).toMatchObject({ expired: [], sends: [] });
		expect(fourth.close).toMatchObject({ through: 4, wakes: ['assistant'] });
		// pass five: the draft the close owes is sent
		const closed: LogEntry[] = [
			...stood,
			...(fourth.close ? [{ type: 'close' as const, close: { ...fourth.close, after: 4 } }] : []),
		];
		const fifth = decide(fold(closed), options({ now: later }));
		expect(fifth).toMatchObject({ expired: [], close: undefined });
		expect(fifth.sends).toEqual([{ id: 'close:4:1', seat: 'assistant' }]);
		// pass six: nothing
		const sent = new Set(fifth.sends.map((send) => send.id));
		const sixth = decide(
			fold(closed),
			options({ now: later, sentAt: (id) => (sent.has(id) ? later : undefined) }),
		);
		expect(sixth).toMatchObject({ expired: [], close: undefined, sends: [] });
		expect(sixth.alarmAt).toBe(later + 5_000);
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
