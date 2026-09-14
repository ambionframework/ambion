/**
 * `decide` is pure: it reads a folded state and the clock, and says what to
 * write and send. A decision applied and decided again writes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { Body, Entry } from '../src/journal/journal.ts';
import { foldRoom, type RoomState } from '../src/room/fold.ts';
import { parseId } from '../src/room/lease.ts';
import {
	planReconciliation as decide,
	liveWork,
	type ReconcileOptions,
} from '../src/room/reconcile.ts';
import type { Message } from '../src/types.ts';
import type { Close, LeaseChange } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const T0 = Date.parse(at);
const retry = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

const composition = (): Entry => ({
	kind: 'composition',
	body: {
		agents: [
			{ name: 'product', identity: 'The product.', attention: 'broadcast' },
			{
				name: 'assistant',
				identity: 'Writes the one message.',
				attention: 'none',
				role: { name: 'assistant', answers: { opened: 'seat', closed: 'summarise' } },
			},
		],
		available: [{ name: 'surveyor', identity: 'Holds the tonnage.', attention: 'broadcast' }],
		at,
	},
	seq: 0,
});
const said = (seq: number, from: string, extra: Partial<Message> = {}): Entry => ({
	kind: 'message',
	body: { kind: 'said', at, from, text: `message ${seq}`, ...extra } as Body<Message>,
	seq,
});
const arrived = (seq: number, from: string): Entry => ({
	kind: 'message',
	body: { kind: 'arrived', at, from, subject: from, identity: 'A person.' },
	seq,
});
/** A lease change lands after the message that caused it, or after the close a draft answers. */
const causeOf = (id: string): number => parseId(id)?.position ?? 0;
const lease = (body: LeaseChange, seq = causeOf(body.id)): Entry => ({ kind: 'lease', body, seq });
const close = (body: Omit<Close, 'at'>): Entry => ({
	kind: 'close',
	body: { ...body, at },
	seq: body.through,
});

const fold = (entries: Entry[]): RoomState => foldRoom(entries, retry);
const options = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
	now: T0,
	resend: 5_000,
	attempts: retry.attempts,
	sent: new Map(),
	sinceCheckpoint: 0,
	checkpointEvery: 256,
	stopped: false,
	...over,
});

/** The question, and the seat it woke. */
const opened = (): Entry[] => [
	composition(),
	arrived(1, 'priya'),
	said(2, 'priya', { wakes: ['product'] }),
];

describe('decide', () => {
	it('ends a lease past its expiry, and closes on the fold that holds the expiry', () => {
		const state = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
		]);
		expect(decide(state, options({ now: T0 + 59_999 }))).toMatchObject({
			expired: [],
			close: undefined,
		});
		const decision = decide(state, options({ now: T0 + 60_000 }));
		expect(decision.expired).toEqual([
			{
				id: 'message:2:product:1',
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
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			said(4, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
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
		// once the close is on the journal, the draft it owes is due
		const closed = fold([
			...opened(),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			said(4, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 4, wakes: ['assistant'] }),
		]);
		expect(decide(closed, options()).sends).toEqual([
			{ id: 'closed:4:assistant:1', seat: 'assistant' },
		]);
	});

	it('holds the exchange open while a seat is live or a wake is pending, and lets a draft close none', () => {
		const pending = fold(opened());
		expect(liveWork(pending, T0).exchange).toBe(true);
		expect(decide(pending, options()).close).toBeUndefined();
		const drafting = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 2 }),
			said(3, 'priya'),
			lease({ id: 'closed:2:assistant:1', phase: 'running', expiry: T0 + 60_000, at }),
		]);
		expect(liveWork(drafting, T0).exchange).toBe(false);
	});

	it('sends a pending wake it never sent, and again once the resend window passed', () => {
		const state = fold(opened());
		expect(decide(state, options()).sends).toEqual([
			{ id: 'message:2:product:1', seat: 'product' },
		]);
		const sent = options({ now: T0 + 4_999, sent: new Map([['message:2:product:1', T0]]) });
		expect(decide(state, sent).sends).toEqual([]);
		expect(decide(state, sent).alarmAt).toBe(T0 + 5_000);
		const later = options({ now: T0 + 5_000, sent: new Map([['message:2:product:1', T0]]) });
		expect(decide(state, later).sends).toEqual([{ id: 'message:2:product:1', seat: 'product' }]);
	});

	it('drafts again after the backoff, and stops at the cap', () => {
		const failed = (n: number, when: number) =>
			lease({
				id: `closed:4:assistant:${n}`,
				phase: 'ended',
				reason: 'failed',
				at: new Date(when).toISOString(),
			});
		const owed = [
			...opened(),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			said(4, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 4, wakes: ['assistant'] }),
			lease({ id: 'closed:4:assistant:1', phase: 'running', expiry: T0 + 60_000, at }),
			failed(1, T0 + 1_000),
		];
		const once = fold(owed);
		expect(once.owed).toMatchObject([
			{ person: 'priya', from: 2, through: 4, attempts: 1, notBefore: T0 + 31_000 },
		]);
		expect(decide(once, options({ now: T0 + 30_999 })).sends).toEqual([]);
		expect(decide(once, options({ now: T0 + 30_999 })).alarmAt).toBe(T0 + 31_000);
		expect(decide(once, options({ now: T0 + 31_000 })).sends).toEqual([
			{ id: 'closed:4:assistant:2', seat: 'assistant' },
		]);
		// at the cap the room gives up: it writes the attempt it does not make,
		// sends nothing, and waits on nothing
		const capped = fold([...owed, failed(2, T0 + 40_000), failed(3, T0 + 100_000)]);
		expect(capped.owed).toMatchObject([{ person: 'priya', attempts: 3 }]);
		expect(decide(capped, options({ now: T0 + 1_000_000 }))).toMatchObject({
			abandoned: [{ id: 'closed:4:assistant:4', phase: 'ended', reason: 'abandoned' }],
			close: undefined,
			sends: [],
			alarmAt: undefined,
		});
		// the entry answers the close: the room owes nothing more, and says so once
		const gaveUp = fold([
			...owed,
			failed(2, T0 + 40_000),
			failed(3, T0 + 100_000),
			lease({ id: 'closed:4:assistant:4', phase: 'ended', reason: 'abandoned', at }),
		]);
		expect(gaveUp.owed).toEqual([]);
		expect(decide(gaveUp, options({ now: T0 + 1_000_000 })).abandoned).toEqual([]);
	});

	it('wakes the seat again after a lease that came to nothing, and stops at the cap', () => {
		const ended = (id: string, reason: 'expired' | 'failed' | 'released', when: number) =>
			lease({ id, phase: 'ended', reason, at: new Date(when).toISOString() });
		// the seat claimed, and its lease expired without a word: the wake is
		// pending again under the next attempt's id, after the backoff
		const expired = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			ended('message:2:product:1', 'expired', T0 + 60_000),
		]);
		expect(expired.pending).toMatchObject([
			{ id: 'message:2:product:2', seat: 'product', seq: 2, attempts: 1, notBefore: T0 + 90_000 },
		]);
		expect(liveWork(expired, T0 + 60_000).exchange).toBe(true);
		expect(decide(expired, options({ now: T0 + 60_000 }))).toMatchObject({
			close: undefined,
			sends: [],
			alarmAt: T0 + 90_000,
		});
		expect(decide(expired, options({ now: T0 + 90_000 })).sends).toEqual([
			{ id: 'message:2:product:2', seat: 'product' },
		]);
		// a lease that spoke and then expired answers nothing: the seat reads its own
		// words at the next attempt
		const spoke = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			ended('message:2:product:1', 'expired', T0 + 60_000),
		]);
		expect(spoke.pending).toMatchObject([{ id: 'message:2:product:2', attempts: 1 }]);
		// a lease that stood down answers every message it heard, and every one its view held
		const stood = fold([
			...opened(),
			said(3, 'priya', { wakes: ['product'] }),
			lease({ id: 'message:3:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			ended('message:3:product:1', 'released', T0 + 1_000),
		]);
		expect(stood.pending).toEqual([]);
		// at the cap the room gives up: it writes the attempt it does not make,
		// and holds the close for the fold that carries the entry
		const tried = [
			...opened(),
			ended('message:2:product:1', 'failed', T0 + 1_000),
			ended('message:2:product:2', 'failed', T0 + 40_000),
			ended('message:2:product:3', 'expired', T0 + 100_000),
		];
		const capped = fold(tried);
		expect(capped.pending).toMatchObject([{ id: 'message:2:product:4', attempts: 3 }]);
		expect(decide(capped, options({ now: T0 + 100_000 }))).toMatchObject({
			abandoned: [{ id: 'message:2:product:4', phase: 'ended', reason: 'abandoned' }],
			close: undefined,
			sends: [],
		});
		// the entry answers the wake: nothing works on the exchange, so it closes
		const gaveUp = fold([
			...tried,
			lease({ id: 'message:2:product:4', phase: 'ended', reason: 'abandoned', at }, 2),
		]);
		expect(gaveUp.pending).toEqual([]);
		expect(liveWork(gaveUp, T0 + 100_000).exchange).toBe(false);
		expect(decide(gaveUp, options({ now: T0 + 100_000 }))).toMatchObject({
			abandoned: [],
			close: { through: 2 },
		});
		// a seat the host unseated answers nothing: what it was sent is not pending
		const unseated = fold([
			...opened(),
			{ kind: 'message' as const, body: { kind: 'unseated', at, subject: 'product' }, seq: 3 },
		]);
		expect(unseated.pending).toEqual([]);
	});

	it('leaves pending what landed between the last renewal and the release, and what the assistant composed through', () => {
		// the seat renewed after 3, message 4 landed, and the release landed after 4: no
		// activation heard 4, so it is pending for the seat as a first attempt
		const window = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }, 3),
			said(4, 'priya'),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }, 4),
		]);
		expect(window.pending).toMatchObject([
			{ id: 'message:4:product:1', seat: 'product', attempts: 0 },
		]);
		// a lease that heard 4 before it stood down answers it
		const heard = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			said(4, 'priya'),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }, 4),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }, 4),
		]);
		expect(heard.pending).toEqual([]);
		// the assistant composing hears no steer: a failed draft leaves the compose
		// pending again, and nothing for the message that landed while it composed
		const composed = fold([
			composition(),
			arrived(1, 'priya'),
			said(2, 'priya', { wakes: ['product', 'assistant'] }),
			lease({ id: 'opened:2:assistant:1', phase: 'running', expiry: T0 + 60_000, at }),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }, 3),
			lease({ id: 'opened:2:assistant:1', phase: 'ended', reason: 'failed', at }, 3),
		]);
		expect(composed.pending.map((wake) => wake.id)).toEqual(['opened:2:assistant:2']);
	});

	it('writes nothing the second time', () => {
		const entries = [
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			said(4, 'product', { activationId: 'message:2:product:1' }),
		];
		const now = T0 + 60_000;
		// pass one: the lease expires, and the close waits for the fold that holds the expiry
		const first = decide(fold(entries), options({ now }));
		expect(first.expired).toHaveLength(1);
		expect(first).toMatchObject({ close: undefined, sends: [] });
		// pass two: the expired lease answers nothing, so the wake is pending again after
		// the backoff, the exchange stays open, and the alarm waits for the backoff
		const expired: Entry[] = [...entries, ...first.expired.map((entry) => lease(entry))];
		const second = decide(fold(expired), options({ now }));
		expect(second).toMatchObject({ expired: [], close: undefined, sends: [] });
		expect(second.alarmAt).toBe(now + 30_000);
		// pass three, after the backoff: the seat is woken again
		const later = now + 30_000;
		const third = decide(fold(expired), options({ now: later }));
		expect(third).toMatchObject({ expired: [], close: undefined });
		expect(third.sends).toEqual([{ id: 'message:2:product:2', seat: 'product' }]);
		// pass four: the seat read its own words and stood down, so the exchange closes
		const stood: Entry[] = [
			...expired,
			lease({ id: 'message:2:product:2', phase: 'running', expiry: later + 60_000, at }),
			lease({ id: 'message:2:product:2', phase: 'ended', reason: 'released', at }),
		];
		const fourth = decide(fold(stood), options({ now: later }));
		expect(fourth).toMatchObject({ expired: [], sends: [] });
		expect(fourth.close).toMatchObject({ through: 4, wakes: ['assistant'] });
		// pass five: the draft the close owes is sent
		const closed: Entry[] = [
			...stood,
			...(fourth.close ? [{ kind: 'close' as const, body: fourth.close, seq: 4 }] : []),
		];
		const fifth = decide(fold(closed), options({ now: later }));
		expect(fifth).toMatchObject({ expired: [], close: undefined });
		expect(fifth.sends).toEqual([{ id: 'closed:4:assistant:1', seat: 'assistant' }]);
		// pass six: nothing
		const sent = new Map(fifth.sends.map((send) => [send.id, later]));
		const sixth = decide(fold(closed), options({ now: later, sent }));
		expect(sixth).toMatchObject({ expired: [], close: undefined, sends: [] });
		expect(sixth.alarmAt).toBe(later + 5_000);
	});

	it('closes nothing and wakes nobody once stopped', () => {
		const state = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'revoked', at }),
		]);
		expect(decide(state, options({ stopped: true }))).toEqual({
			expired: [],
			abandoned: [],
			close: undefined,
			sends: [],
			forget: [],
			checkpoint: false,
			alarmAt: undefined,
		});
	});

	/**
	 * The room holds what it sent for as long as the fold owes the activation.
	 * A wake it forgets is one it would send again, so a decision that kept a
	 * sent id the fold no longer owes would leave the room waiting on it.
	 */
	it('forgets a wake the fold no longer says is due, and keeps one it does', () => {
		const state = fold(opened());
		expect(state.due.map((owed) => owed.id)).toEqual(['message:2:product:1']);
		const sent = new Map([
			['message:2:product:1', T0],
			['message:99:gone:1', T0],
		]);
		expect(decide(state, options({ sent })).forget).toEqual(['message:99:gone:1']);
	});

	/** The journal says when a checkpoint is due; the room writes it where it writes nothing else. */
	it('says a checkpoint is due at the count the runtime set, and not before', () => {
		const state = fold(opened());
		expect(decide(state, options({ sinceCheckpoint: 255, checkpointEvery: 256 })).checkpoint).toBe(
			false,
		);
		expect(decide(state, options({ sinceCheckpoint: 256, checkpointEvery: 256 })).checkpoint).toBe(
			true,
		);
		// a stopped room still says so; the room writes nothing once it is gone
		expect(
			decide(state, options({ sinceCheckpoint: 256, checkpointEvery: 256, stopped: true }))
				.checkpoint,
		).toBe(true);
	});
});

describe('liveWork', () => {
	const live = { expiry: T0 + 60_000, at };

	it('holds the exchange open while an activation a message caused is live', () => {
		const state = fold([
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', ...live }),
		]);
		expect(liveWork(state, T0).exchange).toBe(true);
	});

	it('holds the exchange open while the activation the open caused is live', () => {
		// The question wakes the seat that composes the room, and its lease
		// answers that wake, so this activation is the only thing live. The
		// exchange stays open until it ends: the room that closed here would
		// close every exchange before the room was composed for it.
		const composing = fold([
			composition(),
			arrived(1, 'priya'),
			said(2, 'priya', { wakes: ['assistant'] }),
			lease({ id: 'opened:2:assistant:1', phase: 'running', ...live }),
		]);
		expect([...liveWork(composing, T0).seats.keys()]).toEqual(['assistant']);
		expect(liveWork(composing, T0).exchange).toBe(true);
	});

	it('holds nothing open for an activation a close caused, whichever seat holds it', () => {
		// A close is the end of an exchange, so the activation that answers one
		// cannot hold that exchange open. The cause decides it, and not the name
		// of the seat: a room that read the name would keep its own writer
		// privileged, and would never settle once any other seat drafted.
		// the wake the question decided is answered, so nothing else is owed
		const closed = [
			...opened(),
			lease({ id: 'message:2:product:1', phase: 'running', expiry: T0 + 60_000, at }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 2, wakes: ['assistant'] }),
		];
		for (const seat of ['assistant', 'product']) {
			const state = fold([
				...closed,
				lease({ id: `closed:2:${seat}:1`, phase: 'running', ...live }),
			]);
			expect(liveWork(state, T0).exchange).toBe(false);
		}
	});

	it('is at rest only where no lease is live, no wake is pending and no draft is due', () => {
		// A pending wake holds the room: it owes the activation nobody took yet.
		const pending = fold(opened());
		expect(liveWork(pending, T0)).toMatchObject({ exchange: true, rest: false });
		// The lease that answers the wake holds it too.
		const running = fold([
			...opened(),
			lease({ id: 'message:2:product:1', ...live, phase: 'running' }),
		]);
		expect([...liveWork(running, T0).seats.keys()]).toEqual(['product']);
		expect(liveWork(running, T0).rest).toBe(false);
		// The exchange closed, and the draft it owes is due: the room still works.
		const owed = [
			...opened(),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 3, wakes: ['assistant'] }),
		];
		expect(liveWork(fold(owed), T0)).toMatchObject({ exchange: false, rest: false });
		// The first attempt failed, so the draft waits out its backoff. The seat
		// holds it the whole time: the room owes that person a message, and it
		// tries again when the backoff passes.
		const backoff = fold([
			...owed,
			lease({ id: 'closed:3:assistant:1', phase: 'running', ...live }),
			lease({ id: 'closed:3:assistant:1', phase: 'ended', reason: 'failed', at }),
		]);
		expect(backoff.owed).toMatchObject([{ attempts: 1, notBefore: T0 + 30_000 }]);
		for (const now of [T0, T0 + 29_999, T0 + 30_000]) {
			expect([...liveWork(backoff, now).seats.keys()]).toEqual(['assistant']);
			expect(liveWork(backoff, now).rest).toBe(false);
		}
	});

	it('rests once the room gives up on the draft, because it owes nobody a message', async () => {
		// The cap ends the attempt the room does not make. Nothing is owed after
		// it, so no seat is live and the room rests.
		const abandoned = fold([
			...opened(),
			said(3, 'product', { activationId: 'message:2:product:1' }),
			lease({ id: 'message:2:product:1', phase: 'ended', reason: 'released', at }),
			close({ owner: 'priya', from: 2, through: 3, wakes: ['assistant'] }),
			lease({ id: 'closed:3:assistant:1', phase: 'ended', reason: 'failed', at }),
			lease({ id: 'closed:3:assistant:2', phase: 'ended', reason: 'failed', at }),
			lease({ id: 'closed:3:assistant:3', phase: 'ended', reason: 'failed', at }),
			lease({ id: 'closed:3:assistant:4', phase: 'ended', reason: 'abandoned', at }),
		]);
		expect(abandoned.due).toEqual([]);
		expect(liveWork(abandoned, T0 + 1_000_000)).toMatchObject({ seats: new Map(), rest: true });
	});
});
