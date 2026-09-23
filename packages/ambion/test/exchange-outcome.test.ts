/**
 * Pure folds over a written record: the outcome a read reports for each
 * exchange, the summary completion of a close, and what a cancellation
 * does to leases and summaries.
 */
import { describe, expect, it } from 'vitest';
import type { Close } from '../src/journal/events.ts';
import type { Entry } from '../src/journal/journal.ts';
import { validateRoomBody } from '../src/journal/validate.ts';
import { summaryCompletion } from '../src/room/exchange.ts';
import { foldRoom } from '../src/room/fold.ts';
import type { LeaseHold } from '../src/room/lease.ts';
import { pendingFor, readView } from '../src/room/read.ts';
import type { ExchangeView, Message, RoomRead, SummaryMessage } from '../src/types.ts';
import { evolve } from './support/evolve.ts';

const at = '2026-01-01T09:00:00.000Z';
const cancelledAt = '2026-01-01T09:01:00.000Z';
const retry = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		agents: [{ name: 'worker', identity: 'Worker.', attention: 'broadcast' }],
		available: [{ name: 'writer', identity: 'Writer.', attention: 'broadcast' }],
		at,
	},
};
const arrival = (seq: number, name: string): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'arrived', at, from: name, subject: name, identity: 'Person.' },
});
const said = (seq: number, from: string, to?: string): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'said', at, from, text: `Message ${seq}.`, ...(to === undefined ? {} : { to }) },
});
const summary = (seq: number, to: string, from: number, through: number): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'summary', at, from: 'worker', to, text: `For ${to}.`, covers: { from, through } },
});
const closeBody = (from: number, through: number, writer?: string): Close => ({
	owner: 'priya',
	from,
	through,
	at,
	...(writer === undefined ? {} : { summary: writer }),
});
const close = (seq: number, from: number, through: number, writer?: string): Entry => ({
	kind: 'close',
	seq,
	body: closeBody(from, through, writer),
});
const ended = (seq: number, id: string, reason: 'abandoned' | 'released' | 'revoked'): Entry => ({
	kind: 'lease',
	seq,
	body: {
		id,
		phase: 'ended',
		reason,
		at,
		readThrough: 0,
		...(reason === 'abandoned' ? { cause: 'permanent' } : {}),
	},
});
const running = (seq: number, id: string): Entry => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'running', expiresAt: Date.parse(cancelledAt) - 1, at, readThrough: 2 },
});
const cancel = (seq: number, closes?: Close): Entry => ({
	kind: 'cancel',
	seq,
	body: { at: cancelledAt, ...(closes === undefined ? {} : { close: closes }) },
});

describe('exchange outcomes', () => {
	const room = [composition, arrival(2, 'priya'), arrival(3, 'sam')];
	const readOf = (entries: readonly Entry[]): RoomRead =>
		readView('room', foldRoom(entries, retry), 0, entries.length, false);
	const closed = (read: RoomRead) =>
		read.exchanges.filter(
			(exchange): exchange is Extract<ExchangeView, { status: 'closed' }> =>
				exchange.status === 'closed',
		);
	const outcomes = (entries: readonly Entry[]) =>
		closed(readOf(entries)).map((exchange) => exchange.outcome);
	const asked = [...room, said(4, 'priya')];

	it.each([
		['complete', 'a reply to the owner', [said(5, 'worker', 'priya'), close(6, 4, 5)]],
		['complete', 'a reply to an agent', [said(5, 'worker', 'worker'), close(6, 4, 5)]],
		[
			'complete',
			'an abandoned summary',
			[close(5, 4, 4), ended(6, 'closed:4:worker:1', 'abandoned')],
		],
		[
			'awaiting',
			'a reply to a person who has said nothing since',
			[said(5, 'worker', 'sam'), close(6, 4, 5)],
		],
		[
			'complete',
			'a reply to a person who spoke again',
			[said(5, 'worker', 'sam'), close(6, 4, 5), said(7, 'sam')],
		],
		[
			'exhausted',
			'an abandoned response activation',
			[ended(5, 'message:4:worker:1', 'abandoned'), close(6, 4, 4)],
		],
		[
			'exhausted',
			'an abandoned response and an awaited person',
			[said(5, 'worker', 'sam'), ended(6, 'message:4:worker:1', 'abandoned'), close(7, 4, 5)],
		],
		[
			'cancelled',
			'a cancellation after an abandoned response',
			[
				said(5, 'worker', 'sam'),
				ended(6, 'message:4:worker:1', 'abandoned'),
				cancel(7, closeBody(4, 5)),
			],
		],
	] as const)('reads %s after %s', (kind, _case, tail) => {
		const entries = [...asked, ...tail];
		const [outcome] = outcomes(entries);
		expect(outcome?.kind).toBe(kind);
		const awaited = outcome?.kind === 'awaiting' ? outcome.person : undefined;
		expect(awaited).toBe(kind === 'awaiting' ? 'sam' : undefined);
		for (const person of ['priya', 'sam'])
			expect(pendingFor(readOf(entries), person).map((exchange) => exchange.from)).toEqual(
				person === awaited ? [4] : [],
			);
	});

	it('reads complete for a normal close that a later cancellation follows', () => {
		const entries = [...asked, close(5, 4, 4), said(6, 'priya'), cancel(7, closeBody(6, 6))];
		expect(outcomes(entries).map((outcome) => outcome.kind)).toEqual(['complete', 'cancelled']);
	});

	it('lists one summary for each person who spoke, and none for a person who did not', () => {
		const both = [
			...asked,
			said(5, 'sam'),
			close(6, 4, 5),
			summary(7, 'sam', 4, 5),
			summary(8, 'priya', 4, 5),
		];
		expect(closed(readOf(both))[0]?.summaries?.map((message) => message.to)).toEqual([
			'priya',
			'sam',
		]);
		const silent = [...asked, close(5, 4, 4), summary(6, 'sam', 4, 4)];
		expect(closed(readOf(silent))[0]?.summaries).toBeUndefined();
	});

	it('reads the same outcomes from the incremental state as from the fold', () => {
		const entries = [
			...asked,
			said(5, 'worker', 'sam'),
			close(6, 4, 5),
			said(7, 'priya'),
			cancel(8, closeBody(7, 7)),
		];
		let state = foldRoom(entries.slice(0, 3), retry);
		for (const entry of entries.slice(3)) state = evolve(state, entry, retry);
		expect(readView('room', state, 0, 8, false)).toEqual(readOf(entries));
	});
});

describe('summary completion query', () => {
	const owed = closeBody(2, 5, 'assistant');
	const unassigned = closeBody(2, 5);
	const written: SummaryMessage = {
		kind: 'summary',
		seq: 6,
		at,
		from: 'assistant',
		to: 'priya',
		text: 'Done.',
		covers: { from: 2, through: 5 },
	};
	const hold = (
		reason?: Extract<LeaseHold, { phase: 'ended' }>['reason'],
		id = 'closed:5:assistant:1',
	): LeaseHold =>
		reason === undefined
			? {
					id,
					phase: 'running',
					expiresAt: Date.parse(cancelledAt),
					at,
					claimedAt: at,
					since: 3,
					readThrough: 0,
				}
			: { id, phase: 'ended', reason, at, claimedAt: at, since: 3, until: 7, readThrough: 0 };
	const pending = { status: 'pending', writer: 'assistant' };
	const covering = (covers: { from: number; through: number }) => ({ ...written, covers });

	it.each<[string, Close, Message[], LeaseHold[], object]>([
		[
			'a matching summary before any terminal lease',
			owed,
			[written],
			[hold('abandoned')],
			{ status: 'published', summary: written },
		],
		[
			'a summary over a wider range',
			owed,
			[covering({ from: 1, through: 6 })],
			[],
			{ status: 'published', summary: covering({ from: 1, through: 6 }) },
		],
		['a summary from another writer', owed, [{ ...written, from: 'another-agent' }], [], pending],
		['a summary to another person', owed, [{ ...written, to: 'sam' }], [], pending],
		['a summary that starts late', owed, [covering({ from: 3, through: 5 })], [], pending],
		['a summary that stops early', owed, [covering({ from: 2, through: 4 })], [], pending],
		['a summary on a close with no writer', unassigned, [written], [], { status: 'silent' }],
		['no draft on a close with no writer', unassigned, [], [], { status: 'silent' }],
		['a running draft on a close with no writer', unassigned, [], [hold()], { status: 'silent' }],
		[
			'a failed draft on a close with no writer',
			unassigned,
			[],
			[hold('failed')],
			{ status: 'silent' },
		],
		['no draft yet', owed, [], [], pending],
		['a running draft', owed, [], [hold()], pending],
		[
			'a running retry after a released draft',
			owed,
			[],
			[hold(), hold('released', 'closed:5:assistant:2')],
			{ status: 'pending' },
		],
		['a released draft', owed, [], [hold('released')], { status: 'silent' }],
		['a revoked draft', owed, [], [hold('revoked')], { status: 'failed' }],
		['an abandoned draft', owed, [], [hold('abandoned')], { status: 'failed' }],
		['a failed draft', owed, [], [hold('failed')], pending],
		['an expired draft', owed, [], [hold('expired')], pending],
		[
			'a failed draft of a historical writer',
			closeBody(2, 5, 'historical-assistant'),
			[],
			[hold('failed')],
			{ status: 'pending', writer: 'historical-assistant' },
		],
		[
			'an abandoned draft from another seat',
			owed,
			[],
			[hold('abandoned', 'closed:5:other-seat:1')],
			pending,
		],
		[
			'an abandoned draft at another close',
			owed,
			[],
			[hold('abandoned', 'closed:9:assistant:1')],
			pending,
		],
		[
			'an abandoned response activation',
			owed,
			[],
			[hold('abandoned', 'message:5:assistant:1')],
			pending,
		],
	])('reads %s', (_name, closes, messages, holds, expected) => {
		expect(summaryCompletion(closes, messages, new Map(holds.map((h) => [h.id, h])))).toEqual(
			expected,
		);
	});
});

describe('cancellation fold', () => {
	const question: Entry = {
		kind: 'message',
		seq: 3,
		body: { kind: 'said', at, from: 'priya', text: 'Question?', wakes: ['worker'] },
	};
	const asked = [composition, arrival(2, 'priya'), question];
	const worked = [...asked, running(4, 'message:3:worker:1')];
	const completion = (entries: readonly Entry[], closes: Close) => {
		const state = foldRoom(entries, retry);
		return summaryCompletion(closes, state.messages, state.leases, state.cancelledAt);
	};

	it('matches replay and incremental evolution before and after a fresh prompt', () => {
		const prompt: Entry = {
			kind: 'message',
			seq: 6,
			body: { kind: 'said', at: cancelledAt, from: 'priya', text: 'New?', wakes: ['worker'] },
		};
		const entries = [...worked, cancel(5, { ...closeBody(3, 3), at: cancelledAt }), prompt];
		const replayed = foldRoom(entries, retry);
		const prior = foldRoom(entries.slice(0, 4), retry);
		const retained = structuredClone(prior);
		let incremental = prior;
		for (const entry of entries.slice(4)) incremental = evolve(incremental, entry, retry);
		expect(incremental).toEqual(replayed);
		expect(prior).toEqual(retained);
		expect(replayed.exchange?.from).toBe(6);
		expect(replayed.pending).toMatchObject([{ id: 'message:6:worker:1' }]);
	});

	it('revokes an expired lease once, keeping its context and the first terminal time', () => {
		const once = foldRoom([...worked, cancel(5)], retry).leases.get('message:3:worker:1');
		expect(once).toMatchObject({ phase: 'ended', reason: 'revoked', readThrough: 2, until: 5 });
		const repeated = foldRoom(
			[...worked, cancel(5, { ...closeBody(3, 3), at: cancelledAt }), cancel(6)],
			retry,
		).leases.get('message:3:worker:1');
		expect(repeated).toMatchObject({
			phase: 'ended',
			reason: 'revoked',
			until: 5,
			at: cancelledAt,
		});
	});

	it('preserves published and silent summary outcomes after cancellation', () => {
		const published: Entry = {
			kind: 'message',
			seq: 5,
			body: {
				kind: 'summary',
				at: cancelledAt,
				from: 'writer',
				to: 'priya',
				text: 'Done.',
				covers: { from: 3, through: 3 },
			},
		};
		const entries = [...asked, close(4, 3, 3, 'writer'), published, close(6, 2, 2), cancel(8)];
		const state = foldRoom(entries, retry);
		expect(completion(entries, closeBody(3, 3, 'writer'))).toEqual({
			status: 'published',
			summary: state.messages.find((message) => message.kind === 'summary'),
		});
		expect(completion(entries, closeBody(2, 2))).toEqual({ status: 'silent' });
		expect(state.owed).toEqual([]);
	});

	it.each([
		[
			'fails a released and a cancelled draft, across a repeat marker',
			[running(7, 'closed:3:writer:2'), cancel(8), cancel(9)],
			'failed',
		],
		[
			'keeps a released and a revoked draft silent',
			[ended(7, 'closed:3:writer:2', 'revoked'), cancel(8)],
			'silent',
		],
	] as const)('%s', (_name, tail, status) => {
		const entries = [
			...asked,
			close(5, 3, 3, 'writer'),
			ended(6, 'closed:3:writer:1', 'released'),
			...tail,
		];
		expect(completion(entries, closeBody(3, 3, 'writer'))).toEqual({ status });
	});

	it('rejects a summary field inside a cancellation close', () => {
		expect(() =>
			validateRoomBody('cancel', {
				at: cancelledAt,
				close: { ...closeBody(3, 3, 'writer'), at: cancelledAt },
			}),
		).toThrow();
	});
});
