import { describe, expect, it } from 'vitest';
import { defineAgent } from '../src/define.ts';
import type { Entry, Kind } from '../src/journal/journal.ts';
import { activationSpec } from '../src/room/activation.ts';
import { foldRoom } from '../src/room/fold.ts';
import { decide, evolve, type RoomDecision } from '../src/room/transition.ts';
import { viewOf } from '../src/room/view.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };
const composition: Entry = {
	kind: 'composition',
	body: {
		agents: [{ name: 'product', identity: 'Product.', attention: 'broadcast' }],
		available: [],
		at,
	},
	seq: 1,
};
const arrived: Entry = {
	kind: 'message',
	body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' },
	seq: 2,
};

const said = (seq: number, from = 'priya'): Entry => ({
	kind: 'message',
	body: { kind: 'said', at, from, text: 'Question.', wakes: ['product'] },
	seq,
});

const event = (decision: RoomDecision<Kind>, seq: number): Entry => {
	if (!('event' in decision) || decision.event === undefined) throw new Error('Expected an event.');
	return { ...decision.event, seq };
};

describe('room transition', () => {
	it('keeps an observed close from moving the exchange fence', () => {
		const question: Extract<Entry, { kind: 'message' }> = {
			kind: 'message',
			seq: 3,
			body: { kind: 'said', at, from: 'priya', text: 'First.' },
		};
		const state = foldRoom([composition, arrived, question], options);
		const reconcile = {
			type: 'reconcile' as const,
			options: {
				resend: 5_000,
				attempts: 3,
				sent: new Map<string, number>(),
				stopped: false,
			},
		};
		const observed = decide(state, reconcile, now).events[0];
		if (observed?.kind !== 'close') throw new Error('Expected an observed close.');
		const later = evolve(
			state,
			{ kind: 'message', seq: 4, body: { kind: 'said', at, from: 'priya', text: 'Second.' } },
			options,
		);
		expect(decide(later, { type: 'close', close: observed.body }, now)).toMatchObject({
			event: undefined,
		});
		const next = decide(later, reconcile, now).events[0];
		if (next?.kind !== 'close') throw new Error('Expected the next close.');
		expect(next.body).toMatchObject({ from: 3, through: 4 });
		const settled = evolve(later, { ...next, seq: 5 }, options);
		expect(decide(settled, reconcile, now).events).toEqual([]);
	});

	it('matches replay, retains the prior projection, and routes a delivery', () => {
		const before = foldRoom([composition, arrived], options);
		const decision = decide(before, { type: 'deliver', from: 'priya', text: 'Hello.' }, now);
		if (!('event' in decision) || decision.event === undefined)
			throw new Error('Expected a delivery.');
		const committed: Entry = { ...decision.event, seq: 3 };
		const live = evolve(before, committed, options);
		const replayed = foldRoom([composition, arrived, committed], options);
		expect(live).toEqual(replayed);
		expect(before.messages).toHaveLength(1);
		expect(live.messages).toHaveLength(2);
		expect(live.messages[1]?.wakes).toEqual(['product']);
	});

	it('refuses a stale claim without changing the room', () => {
		const state = foldRoom([composition], options);
		expect(
			decide(
				state,
				{ type: 'claim', id: 'message:2:product:1', expiry: 60_000, deadline: 600_000 },
				now,
			),
		).toMatchObject({
			refusal: { category: 'stale' },
		});
	});

	it('accepts only a designated, seated, quiet assistant', () => {
		const agents = [
			{ name: 'assistant', identity: 'Writes.', attention: 'none' as const },
			{ name: 'product', identity: 'Answers.', attention: 'broadcast' as const },
		];
		for (const composition of [
			{ assistant: 'missing', agents, available: [], at },
			{
				assistant: 'assistant',
				agents: [{ ...agents[0], attention: 'broadcast' as const }, agents[1]],
				available: [],
				at,
			},
			{
				assistant: 'assistant',
				agents: [agents[1]],
				available: [agents[0]],
				at,
			},
		]) {
			expect(
				decide(foldRoom([], options), { type: 'compose', composition: composition as never }, now),
			).toMatchObject({
				refusal: { category: 'refused' },
			});
		}
		expect(
			decide(
				foldRoom([], options),
				{ type: 'compose', composition: { assistant: 'assistant', agents, available: [], at } },
				now,
			),
		).toMatchObject({ event: { kind: 'composition', body: { assistant: 'assistant' } } });
		expect(
			decide(
				foldRoom([], options),
				{ type: 'compose', composition: { agents, available: [], at } },
				now,
			),
		).toMatchObject({ event: { kind: 'composition' } });
	});

	it('gives only the assistant its recorded opening and closing authority', () => {
		const assistantComposition: Entry = {
			kind: 'composition',
			seq: 1,
			body: {
				assistant: 'assistant',
				agents: [
					{ name: 'assistant', identity: 'Writes.', attention: 'none' },
					{ name: 'product', identity: 'Answers.', attention: 'broadcast' },
				],
				available: [],
				at,
			},
		};
		const opened = foldRoom(
			[
				assistantComposition,
				arrived,
				{
					kind: 'message',
					seq: 3,
					body: { kind: 'said', at, from: 'priya', text: 'Question.', wakes: ['assistant'] },
				},
			],
			options,
		);
		expect(activationSpec('message:3:assistant:1', opened)).toBeUndefined();
		expect(activationSpec('message:3:product:1', opened)).toMatchObject({ grant: { kind: 'say' } });
		expect(activationSpec('opened:3:product:1', opened)).toBeUndefined();
		expect(activationSpec('opened:3:assistant:1', opened)).toMatchObject({
			opening: { limit: 0 },
			grant: { kind: 'seat' },
		});
		const closed = foldRoom(
			[
				assistantComposition,
				arrived,
				{ kind: 'message', seq: 3, body: { kind: 'said', at, from: 'priya', text: 'Question.' } },
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, wakes: ['assistant'] },
				},
			],
			options,
		);
		expect(activationSpec('closed:3:product:1', closed)).toBeUndefined();
		expect(activationSpec('closed:3:assistant:1', closed)).toMatchObject({
			grant: { kind: 'summary' },
			closing: { person: 'priya', from: 3, through: 3 },
		});
	});

	it('caps a renewal at its nondefault deadline and ignores its old expiry', () => {
		const due = foldRoom([composition, arrived, said(3)], options);
		const claim = event(
			decide(due, { type: 'claim', id: 'message:3:product:1', expiry: 10, deadline: 25 }, now),
			4,
		);
		const held = evolve(due, { ...claim, seq: 4 }, options);
		const renewed = event(
			decide(
				held,
				{ type: 'claim', id: 'message:3:product:1', expiry: 100, deadline: 25 },
				now + 9,
			),
			5,
		);
		expect(renewed.body).toMatchObject({ expiresAt: now + 25 });
		const live = evolve(held, { ...renewed, seq: 5 }, options);
		expect(
			decide(
				live,
				{ type: 'end', id: 'message:3:product:1', reason: 'expired', readThrough: 0 },
				now + 10,
			),
		).toEqual({ event: undefined });
	});

	it('classifies stale, missed, and refused commits', () => {
		const state = foldRoom([composition, arrived, said(3)], options);
		expect(
			decide(
				state,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'a',
						intent: { kind: 'said', text: 'x' },
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'stale' } });
		const lease: Entry = {
			kind: 'lease',
			body: {
				id: 'message:3:product:1',
				phase: 'running',
				expiresAt: now + 100,
				at,
				readThrough: 0,
			},
			seq: 4,
		};
		const held = foldRoom([composition, arrived, said(3), lease, said(5)], options);
		expect(
			decide(
				held,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'b',
						readThrough: 3,
						intent: { kind: 'said', text: 'x' },
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'missed' } });
		expect(
			decide(
				foldRoom([composition, arrived, said(3), lease], options),
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'c',
						intent: { kind: 'said', to: 'product', text: 'x' },
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('accepts only the grant and a current safe speech boundary', () => {
		const lease: Entry = {
			kind: 'lease',
			body: {
				id: 'message:3:product:1',
				phase: 'running',
				expiresAt: now + 100,
				at,
				readThrough: 0,
			},
			seq: 4,
		};
		const state = foldRoom([composition, arrived, said(3), lease], options);
		const commit = (readThrough: unknown, intent: unknown) =>
			decide(
				state,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'custom',
						...(readThrough === undefined ? {} : { readThrough }),
						intent,
					} as never,
				},
				now,
			);
		for (const readThrough of [undefined, -1, 1.5, Number.NaN, 99]) {
			expect(commit(readThrough, { kind: 'said', text: 'x' })).toMatchObject({
				refusal: { category: 'refused' },
			});
		}
		expect(commit(2, { kind: 'said', text: 'x' })).toMatchObject({
			refusal: { category: 'missed' },
		});
		expect(
			commit(3, { kind: 'summary', to: 'priya', text: 'x', covers: { from: 3, through: 3 } }),
		).toMatchObject({
			refusal: { category: 'refused' },
		});
		expect(commit(3, { kind: 'seated', name: 'product' })).toMatchObject({
			refusal: { category: 'refused' },
		});
	});

	it('denies built-in intents outside each activation grant', () => {
		const assistantComposition: Entry = {
			kind: 'composition',
			seq: 1,
			body: {
				assistant: 'assistant',
				agents: [
					{
						name: 'assistant',
						identity: 'A.',
						attention: 'none',
					},
				],
				available: [{ name: 'product', identity: 'P.', attention: 'broadcast' }],
				at,
			},
		};
		const close = { owner: 'priya', from: 2, through: 2, at, wakes: ['assistant'] };
		const state = foldRoom(
			[
				assistantComposition,
				said(2),
				{ kind: 'close', body: close, seq: 3 },
				{
					kind: 'lease',
					body: {
						id: 'closed:2:assistant:1',
						phase: 'running',
						expiresAt: now + 100,
						at,
						readThrough: 0,
					},
					seq: 4,
				},
				{
					kind: 'lease',
					body: {
						id: 'opened:2:assistant:1',
						phase: 'running',
						expiresAt: now + 100,
						at,
						readThrough: 0,
					},
					seq: 5,
				},
			],
			options,
		);
		const denied = (activation: string, intent: unknown) =>
			decide(
				state,
				{
					type: 'commit',
					commit: { activation, key: activation, readThrough: 2, intent } as never,
				},
				now,
			);
		for (const [activation, intent] of [
			['closed:2:assistant:1', { kind: 'said', text: 'x' }],
			['closed:2:assistant:1', { kind: 'seated', name: 'product' }],
			['opened:2:assistant:1', { kind: 'said', text: 'x' }],
			[
				'opened:2:assistant:1',
				{ kind: 'summary', to: 'priya', text: 'x', covers: { from: 2, through: 2 } },
			],
			['opened:2:assistant:1', { kind: 'unknown' }],
		] as const)
			expect(denied(activation, intent)).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('keeps a closed assistant grant fixed and removes it after redesignation', () => {
		const writerComposition: Entry = {
			kind: 'composition',
			seq: 1,
			body: {
				assistant: 'writer',
				agents: [
					{
						name: 'writer',
						identity: 'W.',
						attention: 'none',
					},
				],
				available: [],
				at,
			},
		};
		const close = { owner: 'priya', from: 2, through: 2, at, wakes: ['writer'] };
		const live = foldRoom(
			[
				writerComposition,
				said(2),
				{ kind: 'close', body: close, seq: 3 },
				{ kind: 'message', body: { kind: 'said', at, from: 'sam', text: 'Later.' }, seq: 4 },
				{
					kind: 'lease',
					body: {
						id: 'closed:2:writer:1',
						phase: 'running',
						expiresAt: now + 100,
						at,
						readThrough: 0,
					},
					seq: 5,
				},
			],
			options,
		);
		const spec = activationSpec('closed:2:writer:1', live);
		if (spec === undefined) throw new Error('Expected an assistant summary grant.');
		expect(spec.through).toBe(2);
		const view = viewOf(
			spec,
			defineAgent({ name: 'writer', identity: 'W.', instructions: '.', model: 'm' }),
			{
				name: 'room',
				now,
				state: live,
				live: new Map(),
				unseen: () => 0,
			},
		);
		expect(view.context).not.toContain('Later.');
		const obsolete = foldRoom(
			[
				writerComposition,
				said(2),
				{ kind: 'close', body: close, seq: 3 },
				{
					kind: 'composition',
					body: {
						agents: [{ name: 'writer', identity: 'W.', attention: 'none' }],
						available: [],
						at,
					},
					seq: 4,
				},
				{
					kind: 'lease',
					body: {
						id: 'closed:2:writer:1',
						phase: 'running',
						expiresAt: now + 100,
						at,
						readThrough: 0,
					},
					seq: 5,
				},
			],
			options,
		);
		expect(activationSpec('closed:2:writer:1', obsolete)).toBeUndefined();
	});

	it('accepts only the closed activation and its fixed summary range', () => {
		const close = { owner: 'priya', from: 2, through: 2, at, wakes: ['assistant'] };
		const assistantComposition: Entry = {
			kind: 'composition',
			seq: 1,
			body: {
				assistant: 'assistant',
				agents: [
					{
						name: 'assistant',
						identity: 'Writes results.',
						attention: 'none',
					},
					{ name: 'product', identity: 'Answers questions.', attention: 'broadcast' },
				],
				available: [],
				at,
			},
		};
		const lease: Entry = {
			kind: 'lease',
			seq: 4,
			body: {
				id: 'closed:2:assistant:1',
				phase: 'running',
				expiresAt: now + 100,
				at,
				readThrough: 0,
			},
		};
		const forgedLease: Entry = {
			kind: 'lease',
			seq: 5,
			body: {
				id: 'opened:2:assistant:1',
				phase: 'running',
				expiresAt: now + 100,
				at,
				readThrough: 0,
			},
		};
		const wrongWriterLease: Entry = {
			kind: 'lease',
			seq: 6,
			body: {
				id: 'closed:2:product:1',
				phase: 'running',
				expiresAt: now + 100,
				at,
				readThrough: 0,
			},
		};
		const later = said(7, 'sam');
		const state = foldRoom(
			[
				assistantComposition,
				said(2),
				{ kind: 'close', body: close, seq: 3 },
				lease,
				forgedLease,
				wrongWriterLease,
				later,
			],
			options,
		);
		const commit = (activation: string, to = 'priya', covers = { from: 2, through: 2 }) =>
			decide(
				state,
				{
					type: 'commit',
					commit: {
						activation,
						key: 'summary',
						readThrough: 2,
						intent: { kind: 'summary', to, text: 'The answer.', covers },
					},
				},
				now,
			);
		expect(commit('closed:2:assistant:1')).toMatchObject({ event: { kind: 'message' } });
		expect(commit('opened:2:assistant:1')).toMatchObject({ refusal: { category: 'refused' } });
		expect(commit('closed:2:product:1')).toMatchObject({ refusal: { category: 'refused' } });
		expect(commit('closed:2:assistant:1', 'sam')).toMatchObject({
			refusal: { category: 'refused' },
		});
		expect(commit('closed:2:assistant:1', 'priya', { from: 1, through: 2 })).toMatchObject({
			refusal: { category: 'refused' },
		});
		expect(commit('closed:2:assistant:1', 'priya', { from: 2, through: 5 })).toMatchObject({
			refusal: { category: 'refused' },
		});
		const accepted = event(commit('closed:2:assistant:1'), 8);
		const after = evolve(state, accepted, options);
		expect(
			decide(
				after,
				{
					type: 'commit',
					commit: {
						activation: 'closed:2:assistant:1',
						key: 'other-token',
						intent: {
							kind: 'summary',
							to: 'priya',
							text: 'A duplicate.',
							covers: { from: 2, through: 2 },
						},
					},
				},
				now,
			),
		).toMatchObject({ refusal: { category: 'refused' } });
	});
});
