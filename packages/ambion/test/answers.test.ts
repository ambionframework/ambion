import { describe, expect, it } from 'vitest';
import { type Answering, answerLease } from '../src/answers.ts';
import type { Entry } from '../src/journal/journal.ts';
import type { LeaseRequest } from '../src/protocol.ts';
import { foldRoom } from '../src/room/fold.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		summary: 'assistant',
		agents: [{ name: 'assistant', identity: 'Writes.', attention: 'none' }],
		available: [],
		at,
	},
};

const close: Entry = {
	kind: 'close',
	seq: 3,
	body: { owner: 'priya', from: 2, through: 2, at, summary: 'assistant' },
};

const question: Entry = {
	kind: 'message',
	seq: 2,
	body: { kind: 'said', from: 'priya', text: 'Question.', at },
};

function fakeRoom(state: ReturnType<typeof foldRoom>, ended: string[]): Answering {
	return {
		name: 'release-test',
		now: () => now,
		gone: () => false,
		ready: Promise.resolve(),
		state: () => state,
		live: () => new Map(),
		emit: () => {},
		write: async () => {
			throw new Error('Unexpected message write.');
		},
		claim: async () => ({ stale: 'unused' }),
		renew: async () => ({ stale: 'unused' }),
		reconcile: async () => {},
		end: async (id: string) => {
			ended.push(id);
			return true;
		},
	};
}

describe('seat lease answers', () => {
	it('rejects an unclaimed designated summary activation', async () => {
		const state = foldRoom([composition, question, close], options);
		const ended: string[] = [];
		const request: LeaseRequest = {
			activation: 'closed:2:assistant:99',
			operation: 'release',
			reason: 'abandoned',
			readThrough: 0,
		};

		expect(await answerLease(fakeRoom(state, ended), request)).toEqual({
			stale: 'the lease ended',
		});
		expect(ended).toEqual([]);
	});

	it('allows a live activation to release normally', async () => {
		const state = foldRoom(
			[
				composition,
				question,
				close,
				{
					kind: 'lease',
					seq: 4,
					body: {
						id: 'closed:2:assistant:1',
						phase: 'running',
						expiresAt: now + 100,
						at,
						readThrough: 0,
					},
				},
			],
			options,
		);
		const ended: string[] = [];

		expect(
			await answerLease(fakeRoom(state, ended), {
				activation: 'closed:2:assistant:1',
				operation: 'release',
				reason: 'released',
				readThrough: 0,
			}),
		).toMatchObject({ ok: {} });
		expect(ended).toEqual(['closed:2:assistant:1']);
	});
});
