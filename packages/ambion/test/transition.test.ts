import { describe, expect, it } from 'vitest';
import type { Entry, Kind } from '../src/journal/journal.ts';
import { activationSpec } from '../src/room/activation.ts';
import { foldRoom } from '../src/room/fold.ts';
import { decide, evolve, type RoomDecision } from '../src/room/transition.ts';
import { viewOf } from '../src/room/view.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };

const composition = (summary?: string): Entry => ({
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		...(summary === undefined ? {} : { summary }),
		agents: [
			{ name: 'product', identity: 'Product.', attention: 'broadcast' },
			{ name: 'writer', identity: 'Writer.', attention: 'broadcast' },
		],
		available: [{ name: 'reserve', identity: 'Reserve.', attention: 'broadcast' }],
		at,
	},
});

const person = (seq = 2, name = 'priya'): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'arrived', at, from: name, subject: name, identity: 'Person.' },
});

const question = (seq = 3, from = 'priya'): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'said', at, from, text: 'Question.' },
});

const lease = (id: string, seq: number): Entry => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'running', expiresAt: now + 60_000, at, readThrough: 0 },
});

const event = (decision: RoomDecision<Kind>, seq: number): Entry => {
	if (!('event' in decision) || decision.event === undefined) throw new Error('Expected an event.');
	return { ...decision.event, seq };
};

describe('room transition', () => {
	it('accepts version 2 compositions and rejects old histories explicitly', () => {
		const empty = foldRoom([], options);
		expect(
			decide(
				empty,
				{ type: 'compose', composition: { version: 1, agents: [], available: [], at } as never },
				now,
			),
		).toMatchObject({ refusal: { category: 'refused' } });
		expect(
			decide(empty, { type: 'compose', composition: composition().body as never }, now),
		).toMatchObject({
			event: { kind: 'composition', body: { version: 2 } },
		});
	});

	it('requires a recorded present human before accepting a delivery', () => {
		const absent = foldRoom(
			[
				composition(),
				person(),
				{
					kind: 'message',
					seq: 3,
					body: { kind: 'left', at, from: 'priya', subject: 'priya' },
				},
			],
			options,
		);
		const decision = decide(absent, { type: 'deliver', from: 'priya', text: 'Orphan.' }, now);
		expect(decision).toMatchObject({ refusal: { category: 'not_present' } });
		const unknown = decide(absent, { type: 'deliver', from: 'ghost', text: 'Unknown.' }, now);
		expect(unknown).toMatchObject({ refusal: { category: 'not_present' } });
	});

	it('turns recovered presence retries into no-ops', () => {
		const present = foldRoom([composition(), person()], options);
		expect(
			decide(
				present,
				{
					type: 'presence',
					change: { kind: 'arrived', from: 'priya', subject: 'priya', identity: 'Person.' },
					route: false,
				},
				now,
			),
		).toEqual({ event: undefined });

		const absent = foldRoom(
			[
				composition(),
				person(),
				{
					kind: 'message',
					seq: 3,
					body: { kind: 'left', at, from: 'priya', subject: 'priya' },
				},
			],
			options,
		);
		expect(
			decide(
				absent,
				{
					type: 'presence',
					change: { kind: 'left', from: 'priya', subject: 'priya' },
					route: false,
				},
				now,
			),
		).toEqual({ event: undefined });

		const seated = foldRoom([composition()], options);
		expect(
			decide(
				seated,
				{
					type: 'presence',
					change: {
						kind: 'seated',
						subject: 'product',
						identity: 'Product.',
						attention: 'broadcast',
					},
					route: false,
				},
				now,
			),
		).toEqual({ event: undefined });
		expect(
			decide(
				seated,
				{
					type: 'presence',
					change: { kind: 'unseated', subject: 'reserve' },
					route: false,
				},
				now,
			),
		).toEqual({ event: undefined });
	});

	it('grants ordinary response to any seated agent and only summary work to the writer', () => {
		const open = foldRoom(
			[composition('writer'), person(), question(), lease('message:3:product:1', 4)],
			options,
		);
		const response = activationSpec('message:3:product:1', open);
		expect(response).toMatchObject({ purpose: { kind: 'respond', message: 3 } });
		expect(activationSpec('opened:3:product:1', open)).toBeUndefined();

		const closed = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
				},
				lease('closed:3:writer:1', 5),
			],
			options,
		);
		expect(activationSpec('closed:3:writer:1', closed)).toMatchObject({
			purpose: { kind: 'summarize', exchange: 3, person: 'priya', through: 3 },
		});
		expect(activationSpec('closed:3:product:1', closed)).toBeUndefined();
	});

	it('normalizes a closing said into a room-owned summary and skips freshness', () => {
		const state = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
				},
				lease('closed:3:writer:1', 5),
			],
			options,
		);
		const result = decide(
			state,
			{
				type: 'commit',
				commit: {
					activation: 'closed:3:writer:1',
					key: 'summary',
					intent: { kind: 'said', text: 'Done.' },
				},
			},
			now,
		);
		expect(result).toMatchObject({
			event: {
				kind: 'message',
				body: {
					kind: 'summary',
					from: 'writer',
					to: 'priya',
					text: 'Done.',
					covers: { from: 3, through: 3 },
					activationId: 'closed:3:writer:1',
				},
			},
		});
		const addressed = decide(
			state,
			{
				type: 'commit',
				commit: {
					activation: 'closed:3:writer:1',
					key: 'other',
					intent: { kind: 'said', to: 'sam', text: 'No.' },
				},
			},
			now,
		);
		expect(addressed).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('requires current context for ordinary speech and refuses unknown recipients', () => {
		const state = foldRoom(
			[composition(), person(), question(), lease('message:3:product:1', 4)],
			options,
		);
		const commit = (readThrough: number | undefined, to?: string) =>
			decide(
				state,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'say',
						...(readThrough === undefined ? {} : { readThrough }),
						intent: { kind: 'said', ...(to === undefined ? {} : { to }), text: 'Answer.' },
					},
				},
				now,
			);
		expect(commit(undefined)).toMatchObject({ refusal: { category: 'refused' } });
		expect(commit(0)).toMatchObject({ refusal: { category: 'missed' } });
		expect(commit(3, 'nobody')).toMatchObject({ refusal: { category: 'unknown_participant' } });
		expect(commit(3)).toMatchObject({ event: { body: { kind: 'said', from: 'product' } } });
	});

	it('returns durable membership no-ops without writing another event', () => {
		const seated = foldRoom(
			[composition(), person(), question(), lease('message:3:product:1', 4)],
			options,
		);
		const alreadySeated = decide(
			seated,
			{
				type: 'commit',
				commit: {
					activation: 'message:3:product:1',
					key: 'seat',
					intent: { kind: 'seated', name: 'product' },
				},
			},
			now,
		);
		expect(alreadySeated).toEqual({ unchanged: { kind: 'seated', name: 'product' } });

		const reserve = foldRoom(
			[composition(), person(), question(), lease('message:3:product:1', 4)],
			options,
		);
		const alreadyUnseated = decide(
			reserve,
			{
				type: 'commit',
				commit: {
					activation: 'message:3:product:1',
					key: 'unseat',
					intent: { kind: 'unseated', name: 'reserve' },
				},
			},
			now,
		);
		expect(alreadyUnseated).toEqual({ unchanged: { kind: 'unseated', name: 'reserve' } });
	});

	it('refuses the summary writer unseating itself, because its seat is fixed by default', () => {
		const state = foldRoom(
			[composition('writer'), person(), question(), lease('message:3:writer:1', 4)],
			options,
		);
		const decision = decide(
			state,
			{
				type: 'commit',
				commit: {
					activation: 'message:3:writer:1',
					key: 'leave',
					intent: { kind: 'unseated', name: 'writer' },
				},
			},
			now,
		);
		expect(decision).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('refuses an ordinary seat unseating itself when its seating said fixed: true', () => {
		const fixedComposition: Entry = {
			kind: 'composition',
			seq: 1,
			body: {
				version: 2,
				agents: [{ name: 'product', identity: 'Product.', attention: 'broadcast', fixed: true }],
				available: [],
				at,
			},
		};
		const state = foldRoom(
			[fixedComposition, person(), question(), lease('message:3:product:1', 4)],
			options,
		);
		const decision = decide(
			state,
			{
				type: 'commit',
				commit: {
					activation: 'message:3:product:1',
					key: 'leave',
					intent: { kind: 'unseated', name: 'product' },
				},
			},
			now,
		);
		expect(decision).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('allows the summary writer to unseat itself when its seating said fixed: false, and removes its authority after the event', () => {
		const unfixedWriter: Entry = {
			kind: 'composition',
			seq: 1,
			body: {
				version: 2,
				summary: 'writer',
				agents: [
					{ name: 'product', identity: 'Product.', attention: 'broadcast' },
					{ name: 'writer', identity: 'Writer.', attention: 'broadcast', fixed: false },
				],
				available: [{ name: 'reserve', identity: 'Reserve.', attention: 'broadcast' }],
				at,
			},
		};
		const state = foldRoom(
			[unfixedWriter, person(), question(), lease('message:3:writer:1', 4)],
			options,
		);
		const decision = decide(
			state,
			{
				type: 'commit',
				commit: {
					activation: 'message:3:writer:1',
					key: 'leave',
					intent: { kind: 'unseated', name: 'writer' },
				},
			},
			now,
		);
		expect(decision).toMatchObject({ event: { body: { kind: 'unseated', subject: 'writer' } } });
		const after = evolve(
			evolve(state, event(decision, 5), options),
			{
				kind: 'message',
				seq: 6,
				body: {
					kind: 'seated',
					at,
					subject: 'writer',
					identity: 'Writer.',
					attention: 'broadcast',
				},
			},
			options,
		);
		expect(activationSpec('message:3:writer:1', after)).toBeUndefined();
	});

	it('does not allow a forged intent to override a summary grant', () => {
		const state = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
				},
				lease('closed:3:writer:1', 5),
			],
			options,
		);
		const result = decide(
			state,
			{
				type: 'commit',
				commit: {
					activation: 'closed:3:writer:1',
					key: 'seat',
					intent: { kind: 'seated', name: 'reserve' },
				},
			},
			now,
		);
		expect(result).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('keeps live lease expiry and release decisions independent of message commits', () => {
		const state = foldRoom(
			[composition(), person(), question(), lease('message:3:product:1', 4)],
			options,
		);
		const expired = decide(
			state,
			{ type: 'end', id: 'message:3:product:1', reason: 'expired', readThrough: 0 },
			now,
		);
		expect(expired).toEqual({ event: undefined });
		const ended = decide(
			state,
			{ type: 'end', id: 'message:3:product:1', reason: 'released', readThrough: 0 },
			now,
		);
		expect(ended).toMatchObject({ event: { body: { phase: 'ended', reason: 'released' } } });
	});

	it('allows one active execution per seat across ordinary and closing work', () => {
		const state = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
				},
				lease('closed:3:writer:1', 5),
				{
					kind: 'message',
					seq: 6,
					body: { kind: 'said', at, from: 'priya', text: 'Next.', wakes: ['writer'] },
				},
			],
			options,
		);
		const claim = decide(
			state,
			{ type: 'claim', id: 'message:6:writer:1', expiry: 100, deadline: 1_000 },
			now,
		);
		expect(claim).toMatchObject({ refusal: { category: 'stale' } });
		const released = evolve(
			state,
			{
				kind: 'lease',
				seq: 7,
				body: { id: 'closed:3:writer:1', phase: 'ended', reason: 'released', at, readThrough: 3 },
			},
			options,
		);
		expect(
			decide(
				released,
				{ type: 'claim', id: 'message:6:writer:1', expiry: 100, deadline: 1_000 },
				now,
			),
		).toMatchObject({
			event: { body: { id: 'message:6:writer:1', phase: 'running' } },
		});
	});

	it('preserves the detached summary view range and reserve identities', () => {
		const state = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
				},
				lease('closed:3:writer:1', 5),
			],
			options,
		);
		const spec = activationSpec('closed:3:writer:1', state);
		if (spec === undefined) throw new Error('Expected summary grant.');
		const view = viewOf(spec, {
			name: 'room',
			now,
			state,
			live: new Map(),
			messagesSince: () => 0,
		});
		expect(view.through).toBe(3);
		expect(view.context.reserve).toEqual([{ name: 'reserve', identity: 'Reserve.' }]);
		expect(view.context.messages.map((message) => message.seq)).toEqual([2, 3]);
	});

	it('starts a new summary assignment after reseating before close, and never revives one ended after close', () => {
		const beforeClose = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
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
				{
					kind: 'close',
					seq: 6,
					body: { owner: 'priya', from: 3, through: 5, at, summary: 'writer' },
				},
			],
			options,
		);
		expect(beforeClose.owed).toMatchObject([{ writer: 'writer', through: 5 }]);

		const afterClose = foldRoom(
			[
				composition('writer'),
				person(),
				question(),
				{
					kind: 'close',
					seq: 4,
					body: { owner: 'priya', from: 3, through: 3, at, summary: 'writer' },
				},
				{ kind: 'message', seq: 5, body: { kind: 'unseated', at, subject: 'writer' } },
				{
					kind: 'message',
					seq: 6,
					body: {
						kind: 'seated',
						at,
						subject: 'writer',
						identity: 'Writer.',
						attention: 'broadcast',
					},
				},
			],
			options,
		);
		expect(afterClose.owed).toEqual([]);
	});
});
