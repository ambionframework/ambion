/**
 * The room tools and the agent's own tools reach the model through the
 * stdio room tools server and the socket of the bridge. Each test runs the
 * server as a subprocess over a real socket. A ref names one absolute URI
 * with a scheme: the room refuses a bare path.
 */
import { defineTool } from '@ambionframework/ambion';
import type { CommitRequest, CommitResult } from '@ambionframework/ambion/hosting';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
import { refOf } from '../src/tools.ts';
import { type Connected, connect, lands, roomOf, seat, textOf, until, viewOf } from './support.ts';

let live: Connected | undefined;
afterEach(async () => {
	await live?.close();
	live = undefined;
});

const say = (text = 'The pour is Saturday.') => ({ name: 'say', arguments: { text } });

async function on(
	answer: (request: CommitRequest) => CommitResult,
	view = viewOf(),
	definition = seat(),
) {
	const { room, commits } = roomOf(answer);
	live = await connect(room, view, definition);
	return { ...live, commits };
}

describe('the tool list and domain tools', () => {
	it('lists the room tools with JSON Schema beside the agent tools, runs each agent tool with provenance or an error result, and answers an unknown tool and a resource request with an error', async () => {
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
		const { client } = await on(lands, viewOf(), seat({ tools: [lookup, broken] }));
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'broken',
			'lookup',
			'say',
			'seat',
			'unseat',
		]);
		const found = tools.find((tool) => tool.name === 'lookup');
		expect(found?.inputSchema.required).toEqual(['id']);
		expect(found?.inputSchema.properties?.id).toMatchObject({ description: 'The record id.' });

		expect(textOf(await client.callTool({ name: 'lookup', arguments: { id: 'r1' } }))).toBe(
			'found r1',
		);
		expect(seen).toEqual([
			{
				params: { id: 'r1' },
				agent: { name: 'gpt', identity: 'Answers what is asked.' },
				signal: expect.any(AbortSignal),
				callId: 'lookup:0',
				room: 'lab',
				activation: 'message:1:gpt:1',
				exchange: { owner: 'priya', from: 1 },
			},
		]);
		const failed = await client.callTool({ name: 'broken', arguments: {} });
		expect(failed.isError).toBe(true);
		expect(textOf(failed)).toBe('The archive is closed.');
		expect((await client.callTool({ name: 'nothing', arguments: {} })).isError).toBe(true);
		// The server offers no resource: a resource request gets Method not found.
		await expect(client.readResource({ uri: 'file:///etc/hosts' })).rejects.toMatchObject({
			code: -32601,
		});
		await expect(client.listResources()).rejects.toMatchObject({ code: -32601 });
		await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: -32601 });
	});

	it('serves only say, with the summary description, to a closing activation', async () => {
		const closing = viewOf({
			kind: 'summarize',
			exchange: 1,
			person: 'priya',
			people: ['priya'],
			through: 1,
		});
		const { client } = await on(lands, closing);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(['say']);
		expect(tools[0]?.description).toContain('priya');
	});
});

describe('say, seat and unseat', () => {
	it('delivers a say, confirms the read position, and cites the paths that Codex changed, once', async () => {
		const { client, commits, acknowledged, bridge } = await on(lands);
		bridge.note(['/work/plan.md', '/work/plan.md']);
		const result = await client.callTool({
			name: 'say',
			arguments: { text: 'Done.', refs: ['room://lab', '/work/plan.md'] },
		});
		expect(textOf(result)).toBe('delivered');
		expect(acknowledged).toEqual([2]);
		await client.callTool(say('Again.'));
		expect(commits).toMatchObject([
			{ activation: 'message:1:gpt:1', readThrough: 1, intent: { kind: 'said' } },
			{ intent: { kind: 'said' } },
		]);
		expect(commits[0]?.intent).toMatchObject({ refs: ['room://lab', 'file:///work/plan.md'] });
		expect(commits[1]?.intent).not.toHaveProperty('refs');
	});

	it('answers unchanged as delivered, and commits a seated intent', async () => {
		const { client, commits } = await on(() => ({ unchanged: { kind: 'seated', name: 'ada' } }));
		expect(textOf(await client.callTool(say()))).toBe('delivered');
		const result = await client.callTool({ name: 'seat', arguments: { name: ' ada ' } });
		expect(textOf(result)).toBe('delivered');
		expect(commits[1]?.intent).toEqual({ kind: 'seated', name: 'ada' });
	});

	it('gives the model a refusal as an error result, and keeps the changed paths for the next say', async () => {
		const { client, commits, bridge } = await on(() => ({ refused: 'You may not say that.' }));
		bridge.note(['/work/plan.md']);
		for (const result of [await client.callTool(say()), await client.callTool(say())]) {
			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe('You may not say that.');
		}
		const unseat = await client.callTool({ name: 'unseat', arguments: { name: 'writer' } });
		expect(unseat.isError).toBe(true);
		expect(textOf(unseat)).toBe('You may not say that.');
		const [first, second, third] = commits.map((commit) => commit.intent);
		expect([first, second]).toMatchObject([
			{ refs: ['file:///work/plan.md'] },
			{ refs: ['file:///work/plan.md'] },
		]);
		expect(third).toEqual({ kind: 'unseated', name: 'writer' });
	});

	it('ends the turn on a stale answer, and refuses a call after the activation was cut', async () => {
		const { client, commits, aborted } = await on(() => ({ stale: 'the lease ended' }));
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('the lease ended');
		expect(aborted()).toBe(true);
		await until(aborted, 'the cut');
		expect((await client.callTool(say())).isError).toBe(true);
		expect(commits).toHaveLength(1);
	});

	it('ends the turn on an unknown answer', async () => {
		const { client, aborted } = await on(() => ({ unknown: 'no confirmation' }));
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('may already hold it');
		expect(aborted()).toBe(true);
	});

	it('moves the read position to the last missed line, and gives the model those lines', async () => {
		const line = (seq: number, text: string) => ({
			kind: 'said' as const,
			seq,
			at: new Date(0).toISOString(),
			from: 'priya',
			text,
		});
		const { client, acknowledged } = await on(() => ({
			missed: [line(2, 'Bring forms.'), line(3, 'And six.')],
		}));
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('Bring forms.');
		expect(textOf(result)).toContain('And six.');
		expect(acknowledged).toEqual([3]);
	});
});

it.each([
	['turns an absolute path into a file URI', '/tmp/a/note.txt', 'file:///tmp/a/note.txt'],
	['encodes what a URI cannot hold', '/tmp/a b/note #1.txt', 'file:///tmp/a%20b/note%20%231.txt'],
	['leaves a URI as it is, and trims it', '  ambion://room/lab  ', 'ambion://room/lab'],
	['leaves a URI as it is', 'https://example.com/plan', 'https://example.com/plan'],
])('refOf %s', (_what, path, ref) => {
	expect(refOf(path)).toBe(ref);
});
