/**
 * The room tools and the agent's own tools reach the model as the dynamic
 * tools of the thread. Each test runs a real core activation over a fake
 * app-server whose turn calls the tools, as the model does.
 */
import { defineTool } from '@ambionframework/ambion';
import type { CommitRequest, CommitResult } from '@ambionframework/ambion/hosting';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { DynamicToolSpec } from '../src/protocol.ts';
import type { TurnContext } from './fake.ts';
import { lands, open, seat, textOf, viewOf } from './support.ts';

/** One say of the model. */
const say = (text = 'The pour is Saturday.') => ['say', { text }] as const;

/** Run one pass whose turn runs `body`. It gives the room, the state, and the tools the thread listed. */
async function on(
	answer: (request: CommitRequest) => CommitResult,
	body: (turn: TurnContext) => Promise<void>,
	view = viewOf(),
	definition = seat(),
) {
	const room = open(
		[
			async (turn) => {
				await body(turn);
				return undefined;
			},
		],
		definition,
		answer,
	);
	const state = room.activate();
	await state.pass({ kind: 'view', view });
	state.close?.();
	const [start] = room.fake.requestsOf('thread/start') as { dynamicTools: DynamicToolSpec[] }[];
	return { ...room, state, tools: start?.dynamicTools ?? [] };
}

describe('the tool list and domain tools', () => {
	it('lists the room tools with JSON Schema beside the agent tools, and runs each agent tool with provenance or an error result', async () => {
		const seen: unknown[] = [];
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up one record.',
			parameters: Type.Object({
				id: Type.String({ description: 'The record id.' }),
				depth: Type.Optional(Type.Number()),
			}),
			execute: (params, context) => {
				seen.push({ params, ...context });
				return 'found r1';
			},
		});
		const broken = defineTool({
			name: 'broken',
			description: 'Always fails.',
			parameters: Type.Object({}),
			execute: () => {
				throw new Error('The archive is closed.');
			},
		});
		const results: Awaited<ReturnType<TurnContext['call']>>[] = [];
		const { tools } = await on(
			lands,
			async (turn) => {
				results.push(await turn.call('lookup', { id: 'r1' }));
				results.push(await turn.call('broken', {}));
				results.push(await turn.call('nothing', {}));
			},
			viewOf(),
			seat({ tools: [lookup, broken] }),
		);
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'broken',
			'dismiss',
			'lookup',
			'recall',
			'say',
			'schedule',
			'seat',
			'unseat',
		]);
		expect(tools.every((tool) => tool.type === 'function')).toBe(true);
		const found = tools.find((tool) => tool.name === 'lookup');
		expect(found?.inputSchema.required).toEqual(['id']);
		expect(found?.inputSchema.properties).toMatchObject({ id: { description: 'The record id.' } });

		expect(textOf(results[0] ?? { contentItems: [], success: false })).toBe('found r1');
		expect(results[0]?.success).toBe(true);
		expect(seen).toEqual([
			{
				params: { id: 'r1' },
				agent: { name: 'gpt', identity: 'Answers what is asked.' },
				signal: expect.any(AbortSignal),
				callId: expect.stringMatching(/^message:1:gpt:1:turn-1:call_1$/),
				room: 'lab',
				activation: 'message:1:gpt:1',
				exchange: { person: 'priya', from: 1 },
			},
		]);
		expect(results[1]?.success).toBe(false);
		expect(textOf(results[1] ?? { contentItems: [], success: true })).toBe(
			'The archive is closed.',
		);
		expect(results[2]?.success).toBe(false);
		expect(textOf(results[2] ?? { contentItems: [], success: true })).toContain("'nothing'");
	});

	it('sends the image of a tool result as a data URL beside its text, and keeps the bytes', async () => {
		const look = defineTool({
			name: 'look',
			description: 'Look at one frame.',
			parameters: Type.Object({}),
			execute: () => ({
				content: [
					{ type: 'text', text: 'frame at t=1' },
					{ type: 'image', data: 'AAAA', mimeType: 'image/png' },
				],
				details: {},
			}),
		});
		let result: Awaited<ReturnType<TurnContext['call']>> | undefined;
		const { steps } = await on(
			lands,
			async (turn) => {
				result = await turn.call('look', {});
			},
			viewOf(),
			seat({ tools: [look] }),
		);
		expect(result?.contentItems).toEqual([
			{ type: 'inputText', text: 'frame at t=1' },
			{ type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
		]);
		// The trace holds the shape of the tool content, with the bytes in place for the sink to count.
		expect(steps).toContainEqual(
			expect.objectContaining({
				type: 'tool_result',
				output: [
					{ type: 'text', text: 'frame at t=1' },
					{ type: 'image', mimeType: 'image/png', data: 'AAAA' },
				],
			}),
		);
	});

	it('serves only say, with the summary description, to a summary activation', async () => {
		const closing = viewOf({
			kind: 'summarize',
			exchange: 1,
			person: 'priya',
			people: ['priya'],
			through: 1,
		});
		const { tools } = await on(lands, async () => {}, closing);
		expect(tools.map((tool) => tool.name)).toEqual(['say']);
		expect(tools[0]?.description).toContain('priya');
	});
});

describe('say, seat and unseat', () => {
	it('delivers a say with its refs, and confirms the read position', async () => {
		const results: string[] = [];
		const { commits, state } = await on(lands, async (turn) => {
			const first = await turn.call('say', {
				text: 'Done.',
				refs: ['room://lab', ' file:///work/plan.md '],
			});
			results.push(textOf(first));
			await turn.call(...say('Again.'));
		});
		expect(results).toEqual(['said #2']);
		expect(state.readThrough).toBe(2);
		expect(commits).toMatchObject([
			{ activation: 'message:1:gpt:1', readThrough: 1, intent: { kind: 'said' } },
			{ intent: { kind: 'said' } },
		]);
		expect(commits[0]?.intent).toMatchObject({ refs: ['room://lab', 'file:///work/plan.md'] });
		expect(commits[1]?.intent).not.toHaveProperty('refs');
	});

	it('answers an unchanged seating with the fact, and commits a seated intent', async () => {
		const results: string[] = [];
		const { commits } = await on(
			() => ({ unchanged: { kind: 'seated', name: 'ada' } }),
			async (turn) => {
				results.push(textOf(await turn.call(...say())));
				results.push(textOf(await turn.call('seat', { name: ' ada ' })));
			},
		);
		expect(results).toEqual(
			Array(2).fill(
				'ada is already seated. Seating it again does not activate it. To give it the request, call say with to set to ada.',
			),
		);
		expect(commits[1]?.intent).toEqual({ kind: 'seated', name: 'ada' });
	});

	it('gives the model a refusal as an error result', async () => {
		const results: Awaited<ReturnType<TurnContext['call']>>[] = [];
		const { commits } = await on(
			() => ({ refused: 'You may not say that.' }),
			async (turn) => {
				results.push(await turn.call(...say()), await turn.call(...say()));
				results.push(await turn.call('unseat', { name: 'writer' }));
			},
		);
		for (const result of results) {
			expect(result.success).toBe(false);
			expect(textOf(result)).toBe('You may not say that.');
		}
		expect(commits.map((commit) => commit.intent.kind)).toEqual(['said', 'said', 'unseated']);
		expect(commits[2]?.intent).toEqual({ kind: 'unseated', name: 'writer' });
	});

	it('ends the turn on a stale answer, and refuses a call after the activation was cut', async () => {
		const results: Awaited<ReturnType<TurnContext['call']>>[] = [];
		const { commits, state } = await on(
			() => ({ stale: 'the lease ended' }),
			async (turn) => {
				results.push(await turn.call(...say()));
				results.push(await turn.call(...say()));
			},
		);
		expect(results.map((result) => result.success)).toEqual([false, false]);
		expect(textOf(results[0] ?? { contentItems: [], success: true })).toContain('the lease ended');
		expect(textOf(results[1] ?? { contentItems: [], success: true })).toContain('was cut');
		expect(state.isCut).toBe(true);
		expect(commits).toHaveLength(1);
	});

	it('ends the turn on an unknown answer', async () => {
		const results: Awaited<ReturnType<TurnContext['call']>>[] = [];
		const { state } = await on(
			() => ({ unknown: 'no confirmation' }),
			async (turn) => {
				results.push(await turn.call(...say()));
			},
		);
		expect(results[0]?.success).toBe(false);
		expect(textOf(results[0] ?? { contentItems: [], success: true })).toContain(
			'may already hold it',
		);
		expect(state.isCut).toBe(true);
	});

	it('moves the read position to the last missed line, and gives the model those lines', async () => {
		const line = (seq: number, text: string) => ({
			kind: 'said' as const,
			seq,
			at: new Date(0).toISOString(),
			from: 'priya',
			text,
		});
		const results: Awaited<ReturnType<TurnContext['call']>>[] = [];
		const { state } = await on(
			() => ({ missed: [line(2, 'Bring forms.'), line(3, 'And six.')] }),
			async (turn) => {
				results.push(await turn.call(...say()));
			},
		);
		expect(results[0]?.success).toBe(false);
		expect(textOf(results[0] ?? { contentItems: [], success: true })).toContain('Bring forms.');
		expect(textOf(results[0] ?? { contentItems: [], success: true })).toContain('And six.');
		expect(state.readThrough).toBe(3);
	});
});
