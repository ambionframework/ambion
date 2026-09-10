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
const backoff = (attempt: number) => attempt * 30_000;

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
/** A lease row. `heard` defaults to the seq its id names, or the close's `through` for a draft. */
const lease = (row: Without<LeaseRow, 'after' | 'heard'> & { heard?: number }): LogEntry => {
	const named = /(\d+)/.exec(row.id.replace(/^close:/, ''));
	const heard = row.heard ?? Number(named?.[1] ?? 0);
	return { type: 'lease', lease: { ...row, heard, after: 0 } as LeaseRow };
};
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
	it('ends a lease past its expiry, and holds the exchange open for the next attempt', () => {
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
				heard: 2,
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
		// at the cap the room gives up: the attempt it does not make is written off, and the row answers the close
		const capped = fold([...owed, failed(2, T0 + 40_000), failed(3, T0 + 100_000)]);
		expect(capped.owed).toMatchObject([{ attempts: 3 }]);
		const given = decide(capped, options({ now: T0 + 1_000_000 }));
		expect(given).toMatchObject({ sends: [], alarmAt: undefined });
		expect(given.abandoned).toEqual([
			{
				id: 'close:4:4',
				phase: 'ended',
				reason: 'abandoned',
				heard: 4,
				at: new Date(T0 + 1_000_000).toISOString(),
			},
		]);
		const written = fold([
			...owed,
			failed(2, T0 + 40_000),
			failed(3, T0 + 100_000),
			lease(given.abandoned[0] as Parameters<typeof lease>[0]),
		]);
		expect(written.owed).toEqual([]);
		expect(decide(written, options({ now: T0 + 1_000_000 }))).toMatchObject({
			abandoned: [],
			sends: [],
			alarmAt: undefined,
		});
	});

	it('wakes a seat again after an activation that heard the message came to nothing', () => {
		const expired = (id: string, when: number) =>
			lease({ id, phase: 'ended', reason: 'expired', at: new Date(when).toISOString() });
		// the seat claimed, heard the question, and its lease expired without a word
		const once = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			expired('2:product', T0 + 60_000),
		]);
		expect(once.pending).toMatchObject([
			{ id: '2:product:2', seat: 'product', seq: 2, attempts: 1, notBefore: T0 + 90_000 },
		]);
		expect(working(once, T0 + 60_000)).toBe(true);
		expect(decide(once, options({ now: T0 + 60_000 }))).toMatchObject({
			sends: [],
			close: undefined,
			alarmAt: T0 + 90_000,
		});
		expect(decide(once, options({ now: T0 + 90_000 })).sends).toEqual([
			{ id: '2:product:2', seat: 'product' },
		]);
		// a second activation heard it and spoke, then expired: it answers nothing, whatever it
		// said, and the seat reads its own words at the next attempt
		const spoke = fold([
			...opened(),
			expired('2:product', T0 + 60_000),
			lease({ id: '2:product:2', phase: 'running', expiry: T0 + 150_000, at }),
			said(3, 'product', { activationId: '2:product:2' }),
			expired('2:product:2', T0 + 150_000),
		]);
		expect(spoke.pending).toMatchObject([{ id: '2:product:3', attempts: 2 }]);
		// at the cap the room writes the wake off, and the exchange closes on the fold that holds the row
		const capped = fold([
			...opened(),
			expired('2:product', T0 + 60_000),
			expired('2:product:2', T0 + 150_000),
			expired('2:product:3', T0 + 300_000),
		]);
		expect(capped.pending).toMatchObject([{ id: '2:product:4', attempts: 3 }]);
		const given = decide(capped, options({ now: T0 + 300_000 }));
		expect(given.close).toBeUndefined();
		expect(given.abandoned).toMatchObject([{ id: '2:product:4', reason: 'abandoned', heard: 2 }]);
		const written = fold([
			...opened(),
			expired('2:product', T0 + 60_000),
			expired('2:product:2', T0 + 150_000),
			expired('2:product:3', T0 + 300_000),
			lease({ id: '2:product:4', phase: 'ended', reason: 'abandoned', at }),
		]);
		expect(written.pending).toEqual([]);
		expect(decide(written, options({ now: T0 + 300_000 })).close).toMatchObject({ through: 2 });
	});

	it('answers every wake a later activation of the seat heard', () => {
		// the first activation died mid-request; a colleague's reply reached the seat while it ran
		const state = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'priya', { wakes: ['product'] }),
			lease({ id: '2:product', phase: 'ended', reason: 'expired', at, heard: 2 }),
		]);
		// both wakes are pending: the second was never heard, the first came to nothing
		expect(state.pending.map((w) => [w.id, w.attempts])).toEqual([
			['2:product:2', 1],
			['3:product', 0],
		]);
		expect(decide(state, options({ now: T0 })).sends).toEqual([
			{ id: '3:product', seat: 'product' },
		]);
		// the activation for the second heard through 3, so it answers the first as well
		const answered = fold([
			...opened(),
			said(3, 'priya', { wakes: ['product'] }),
			lease({ id: '2:product', phase: 'ended', reason: 'expired', at, heard: 2 }),
			lease({ id: '3:product', phase: 'running', expiry: T0 + 60_000, at, heard: 3 }),
		]);
		expect(answered.pending).toEqual([]);
	});

	it('leaves pending what landed after the release last took, and nothing the assistant composed through', () => {
		// the seat took the record through 3, message 4 reached it at work, and the release
		// said 3: no activation heard 4, so it is pending for the seat as a first attempt
		const window = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at, heard: 3 }),
			said(4, 'priya', { wakes: ['product'] }),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at, heard: 3 }),
		]);
		expect(window.pending).toMatchObject([{ id: '4:product', seat: 'product', attempts: 0 }]);
		// a release that said 4 answers it
		const heard = fold([
			...opened(),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			said(4, 'priya', { wakes: ['product'] }),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at, heard: 4 }),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at, heard: 4 }),
		]);
		expect(heard.pending).toEqual([]);
		// the assistant composing hears no steer, so a message that lands while it composes
		// names no wake for it: a failed compose leaves the compose pending again, and nothing else
		const composed = fold([
			composition(),
			arrived(1, 'priya'),
			said(2, 'priya', { wakes: ['product', 'assistant'] }),
			lease({ id: '2:assistant', phase: 'running', expiry: T0 + 60_000, at }),
			lease({ id: '2:product', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: '2:product' }),
			lease({ id: '2:product', phase: 'ended', reason: 'released', at, heard: 3 }),
			lease({ id: '2:assistant', phase: 'ended', reason: 'failed', at }),
		]);
		expect(composed.pending.map((wake) => wake.id)).toEqual(['2:assistant:2']);
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
		// pass two: the expired lease answers nothing, whatever it said, so the wake is
		// pending again after the backoff, the exchange stays open, and the alarm waits
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
			lease({ id: '2:product:2', phase: 'running', expiry: later + 60_000, at, heard: 4 }),
			lease({ id: '2:product:2', phase: 'ended', reason: 'released', at, heard: 4 }),
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
			abandoned: [],
			close: undefined,
			sends: [],
			alarmAt: undefined,
		});
	});
});
