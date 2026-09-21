/**
 * The room tools and the agent's own tools reach the model through the
 * stdio room tools server and the socket of the bridge. Each test runs the
 * server as a subprocess over a real socket.
 */
import { defineTool } from '@ambionframework/ambion';
import type { CommitRequest, CommitResult } from '@ambionframework/ambion/hosting';
import { Type } from 'typebox';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('the tool list', () => {
	it('lists the three room tools with JSON Schema, and the tools of the agent beside them', async () => {
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up one record.',
			parameters: Type.Object({
				id: Type.String({ description: 'The record id.' }),
				depth: Type.Optional(Type.Number()),
			}),
			execute: () => 'ok',
		});
		const { client } = await on(lands, viewOf(), seat({ tools: [lookup] }));
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name).sort()).toEqual(['lookup', 'say', 'seat', 'unseat']);
		const found = tools.find((tool) => tool.name === 'lookup');
		expect(found?.inputSchema.required).toEqual(['id']);
		expect(found?.inputSchema.properties?.id).toMatchObject({ description: 'The record id.' });
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

describe('say', () => {
	it('delivers a say, and confirms the read position', async () => {
		const { client, commits, acknowledged } = await on(lands);
		const result = await client.callTool(say());
		expect(textOf(result)).toBe('delivered');
		expect(commits).toMatchObject([
			{ activation: 'message:1:gpt:1', readThrough: 1, intent: { kind: 'said' } },
		]);
		expect(acknowledged).toEqual([2]);
	});

	it('answers unchanged as delivered', async () => {
		const { client } = await on(() => ({ unchanged: { kind: 'seated', name: 'x' } }));
		expect(textOf(await client.callTool(say()))).toBe('delivered');
	});

	it('gives the model a refusal as an error result', async () => {
		const { client } = await on(() => ({ refused: 'You may not say that.' }));
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe('You may not say that.');
	});

	it('ends the turn on a stale answer', async () => {
		const { client, aborted } = await on(() => ({ stale: 'the lease ended' }));
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('the lease ended');
		expect(aborted()).toBe(true);
	});

	it('ends the turn on an unknown answer', async () => {
		const { client, aborted } = await on(() => ({ unknown: 'no confirmation' }));
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('may already hold it');
		expect(aborted()).toBe(true);
	});

	it('moves the read position to the last missed line, and gives the model those lines', async () => {
		const missed: CommitResult = {
			missed: [
				{
					kind: 'said',
					seq: 2,
					at: new Date(0).toISOString(),
					from: 'priya',
					text: 'Bring forms.',
				},
				{ kind: 'said', seq: 3, at: new Date(0).toISOString(), from: 'priya', text: 'And six.' },
			],
		};
		const { client, acknowledged } = await on(() => missed);
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain('Bring forms.');
		expect(textOf(result)).toContain('And six.');
		expect(acknowledged).toEqual([3]);
	});

	it('cites the paths that Codex changed, once', async () => {
		const { client, commits, bridge } = await on(lands);
		bridge.note(['/work/plan.md', '/work/plan.md']);
		await client.callTool({
			name: 'say',
			arguments: { text: 'Done.', refs: ['room://lab', '/work/plan.md'] },
		});
		await client.callTool(say('Again.'));
		expect(commits[0]?.intent).toMatchObject({ refs: ['room://lab', 'file:///work/plan.md'] });
		expect(commits[1]?.intent).not.toHaveProperty('refs');
	});

	it('keeps the changed paths for the next say when the room refused this one', async () => {
		const { client, commits, bridge } = await on(() => ({ refused: 'No.' }));
		bridge.note(['/work/plan.md']);
		await client.callTool(say());
		await client.callTool(say());
		expect(commits.map((commit) => commit.intent)).toMatchObject([
			{ refs: ['file:///work/plan.md'] },
			{ refs: ['file:///work/plan.md'] },
		]);
	});
});

describe('seat and unseat', () => {
	it('commits a seated intent and reports it', async () => {
		const { client, commits } = await on(() => ({ unchanged: { kind: 'seated', name: 'ada' } }));
		const result = await client.callTool({ name: 'seat', arguments: { name: ' ada ' } });
		expect(textOf(result)).toBe('delivered');
		expect(commits[0]?.intent).toEqual({ kind: 'seated', name: 'ada' });
	});

	it('gives the model the refusal of an unseat', async () => {
		const { client, commits } = await on(() => ({ refused: 'A fixed seat stays.' }));
		const result = await client.callTool({ name: 'unseat', arguments: { name: 'writer' } });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe('A fixed seat stays.');
		expect(commits[0]?.intent).toEqual({ kind: 'unseated', name: 'writer' });
	});
});

describe('domain tools', () => {
	it('runs an agent tool with provenance: the agent, the room, the activation and the call', async () => {
		const seen: unknown[] = [];
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up one record.',
			parameters: Type.Object({ id: Type.String() }),
			execute: (params, context) => {
				seen.push({ params, ...context });
				return 'found r1';
			},
		});
		const { client } = await on(lands, viewOf(), seat({ tools: [lookup] }));
		const result = await client.callTool({ name: 'lookup', arguments: { id: 'r1' } });
		expect(textOf(result)).toBe('found r1');
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
	});

	it('gives the model a tool error as an error result', async () => {
		const broken = defineTool({
			name: 'broken',
			description: 'Always fails.',
			parameters: Type.Object({}),
			execute: () => {
				throw new Error('The archive is closed.');
			},
		});
		const { client } = await on(lands, viewOf(), seat({ tools: [broken] }));
		const result = await client.callTool({ name: 'broken', arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe('The archive is closed.');
	});
});

describe('the bridge', () => {
	it('answers an unknown tool with an error result', async () => {
		const { client } = await on(lands);
		const result = await client.callTool({ name: 'nothing', arguments: {} });
		expect(result.isError).toBe(true);
	});

	it('refuses a call after the activation was cut', async () => {
		const { client, commits, aborted } = await on(() => ({ stale: 'the lease ended' }));
		await client.callTool(say());
		await until(aborted, 'the cut');
		const result = await client.callTool(say());
		expect(result.isError).toBe(true);
		expect(commits).toHaveLength(1);
	});
});

describe('resources', () => {
	it('offers none: a resource request gets Method not found', async () => {
		const { client } = await on(lands);
		await expect(client.readResource({ uri: 'file:///etc/hosts' })).rejects.toMatchObject({
			code: -32601,
		});
		await expect(client.listResources()).rejects.toMatchObject({ code: -32601 });
		await expect(client.listResourceTemplates()).rejects.toMatchObject({ code: -32601 });
	});
});
