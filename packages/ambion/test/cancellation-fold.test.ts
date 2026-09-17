import { describe, expect, it } from 'vitest';
import type { Cancellation, Close } from '../src/journal/events.ts';
import type { Body, Entry } from '../src/journal/journal.ts';
import { validateRoomBody } from '../src/journal/validate.ts';
import { summaryCompletion } from '../src/room/exchange.ts';
import { foldRoom, type RoomState } from '../src/room/fold.ts';
import { evolve } from '../src/room/transition.ts';
import type { Message } from '../src/types.ts';

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

const arrived: Entry = {
	kind: 'message',
	seq: 2,
	body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Person.' },
};

const question: Entry = {
	kind: 'message',
	seq: 3,
	body: { kind: 'said', at, from: 'priya', text: 'Question?', wakes: ['worker'] },
};

const running = (id = 'message:3:worker:1', seq = 4): Entry => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'running', expiresAt: Date.parse(cancelledAt) - 1, at, readThrough: 2 },
});

const cancel = (seq: number, close?: Cancellation['close']): Entry => ({
	kind: 'cancel',
	seq,
	body: { at: cancelledAt, ...(close === undefined ? {} : { close }) },
});

const stateAfter = (entries: readonly Entry[]): RoomState => foldRoom(entries, retry);

describe('cancellation fold', () => {
	it('matches replay and incremental evolution before and after a fresh prompt', () => {
		const entries: Entry[] = [
			composition,
			arrived,
			question,
			running(),
			cancel(5, { owner: 'priya', from: 3, through: 3, at: cancelledAt }),
			{
				kind: 'message',
				seq: 6,
				body: {
					kind: 'said',
					at: cancelledAt,
					from: 'priya',
					text: 'New question?',
					wakes: ['worker'],
				},
			},
		];
		const replayed = stateAfter(entries);
		const prior = stateAfter(entries.slice(0, 4));
		const retained = structuredClone(prior);
		let incremental = prior;
		for (const entry of entries.slice(4)) incremental = evolve(incremental, entry, retry);
		expect(incremental).toEqual(replayed);
		expect(prior).toEqual(retained);
		expect(replayed.exchange?.from).toBe(6);
		expect(replayed.pending).toMatchObject([{ id: 'message:6:worker:1' }]);
	});

	it('keeps the first cancellation terminal time and lease timestamp on repeats', () => {
		const state = stateAfter([
			composition,
			arrived,
			question,
			running(),
			cancel(5, { owner: 'priya', from: 3, through: 3, at: cancelledAt }),
			cancel(6),
		]);
		const lease = state.leases.get('message:3:worker:1');
		expect(lease).toMatchObject({ phase: 'ended', reason: 'revoked', until: 5, at: cancelledAt });
	});

	it('preserves published and silent summary outcomes after cancellation', () => {
		const published: Body<Message> = {
			kind: 'summary',
			at: cancelledAt,
			from: 'writer',
			to: 'priya',
			text: 'Done.',
			covers: { from: 3, through: 3 },
		};
		const state = stateAfter([
			composition,
			arrived,
			question,
			{
				kind: 'close',
				seq: 4,
				body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
			},
			{ kind: 'message', seq: 5, body: published },
			{ kind: 'close', seq: 6, body: { owner: 'priya', from: 2, through: 2, at } },
			cancel(8),
		]);
		const recordedSummary = state.messages.find((message) => message.kind === 'summary');
		const publishedClose = state.closes.find((close) => close.summary !== undefined);
		const silentClose = state.closes.find((close) => close.summary === undefined);
		if (recordedSummary === undefined || publishedClose === undefined || silentClose === undefined)
			throw new Error('Expected both summary close outcomes.');
		expect(
			summaryCompletion(publishedClose, state.messages, state.leases, state.cancelledAt),
		).toEqual({ status: 'published', summary: recordedSummary });
		expect(summaryCompletion(silentClose, state.messages, state.leases, state.cancelledAt)).toEqual(
			{
				status: 'silent',
			},
		);
		expect(state.owed).toEqual([]);
	});

	it('fails mixed released and cancelled summary drafts, including after a repeat marker', () => {
		const closeWithSummary: Close = { owner: 'priya', from: 3, through: 3, at, summary: 'writer' };
		const entries = [
			composition,
			arrived,
			question,
			{ kind: 'close' as const, seq: 5, body: closeWithSummary },
			{
				kind: 'lease' as const,
				seq: 6,
				body: {
					id: 'closed:3:writer:1',
					phase: 'ended' as const,
					reason: 'released' as const,
					at,
					readThrough: 3,
				},
			},
			running('closed:3:writer:2', 7),
			cancel(8),
			cancel(9),
		];
		const state = stateAfter(entries);
		expect(
			summaryCompletion(closeWithSummary, state.messages, state.leases, state.cancelledAt),
		).toEqual({
			status: 'failed',
		});
	});

	it('keeps a previously released and revoked summary silent', () => {
		const closeWithSummary: Close = { owner: 'priya', from: 3, through: 3, at, summary: 'writer' };
		const state = stateAfter([
			composition,
			arrived,
			question,
			{ kind: 'close', seq: 5, body: closeWithSummary },
			{
				kind: 'lease',
				seq: 6,
				body: { id: 'closed:3:writer:1', phase: 'ended', reason: 'released', at, readThrough: 3 },
			},
			{
				kind: 'lease',
				seq: 7,
				body: { id: 'closed:3:writer:2', phase: 'ended', reason: 'revoked', at, readThrough: 0 },
			},
			cancel(8),
		]);
		expect(
			summaryCompletion(closeWithSummary, state.messages, state.leases, state.cancelledAt),
		).toEqual({ status: 'silent' });
	});

	it('revokes an expired lease while preserving its acknowledged context', () => {
		const state = stateAfter([composition, arrived, question, running(), cancel(5)]);
		const lease = state.leases.get('message:3:worker:1');
		expect(lease).toMatchObject({ phase: 'ended', reason: 'revoked', readThrough: 2, until: 5 });
	});

	it('rejects a summary field inside a cancellation close', () => {
		expect(() =>
			validateRoomBody('cancel', {
				at: cancelledAt,
				close: { owner: 'priya', from: 3, through: 3, at: cancelledAt, summary: 'writer' },
			}),
		).toThrow();
	});
});
