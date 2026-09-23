/** A native Pi tool adapted by `fromPiTool`, and the argument checks of `defineTool`. */
import { defineTool, startRoom, type ToolContext } from '@ambionframework/ambion';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { enter, roomName, scriptedAgent, waitForRoom } from '../../ambion/test/support/room.ts';
import { callTool, quiet, scripted, toolResultTexts } from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { fromPiTool, piExecution } from '../src/index.ts';

const parameters = Type.Object({ count: Type.Number() });
const context: ToolContext = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'call-1' };

type Details = { count: number };

it('preserves native execution metadata, context, updates, and full results', async () => {
	const calls: unknown[][] = [];
	let fail = false;
	const native: AgentTool<typeof parameters, Details> = {
		name: 'count',
		label: 'Count items',
		description: 'Count items.',
		parameters,
		executionMode: 'sequential',
		execute: async (id, params, signal, onUpdate) => {
			calls.push([id, params, signal, typeof onUpdate]);
			if (fail) throw new Error('native failure');
			onUpdate?.({ content: [], details: params });
			return { content: [{ type: 'text', text: 'done' }], details: params, terminate: true };
		},
	};
	const adapted = fromPiTool(native);
	native.execute = async () => {
		throw new Error('mutated native callback');
	};
	native.label = 'Changed label';
	const signal = new AbortController().signal;
	const updates: AgentToolResult<unknown>[] = [];
	const result = await adapted.invoke(
		{ count: 2 },
		{ ...context, signal, onUpdate: (update) => updates.push(update) },
	);
	expect(adapted).toMatchObject({ label: 'Count items', executionMode: 'sequential' });
	expect(calls).toEqual([['call-1', { count: 2 }, signal, 'function']]);
	expect(updates).toEqual([{ content: [], details: { count: 2 } }]);
	expect(result).toEqual({
		content: [{ type: 'text', text: 'done' }],
		details: { count: 2 },
		terminate: true,
	});
	fail = true;
	await expect(adapted.invoke({ count: 2 }, { ...context, callId: 'call-2' })).rejects.toThrow(
		'native failure',
	);
});

it('prepares native arguments once per call and validates before execution', async () => {
	const executed: Details[] = [];
	let prepared = 0;
	const worker = scriptedAgent('worker', 'Worker.', {
		tools: [
			fromPiTool({
				name: 'count',
				label: 'Count',
				description: 'Count.',
				parameters,
				prepareArguments: (args: unknown) => {
					prepared += 1;
					const count =
						typeof args === 'object' && args !== null && 'count' in args ? args.count : undefined;
					return { count: Number(count) };
				},
				execute: async (_id, params) => {
					executed.push(params);
					return { content: [{ type: 'text', text: `count=${params.count}` }], details: params };
				},
			}),
		],
	});
	const results: string[] = [];
	const room = stopAtEnd(
		await startRoom({
			name: roomName('native-adapter'),
			agents: [worker],
			execution: piExecution({
				stream: scripted((context, _agent, call) => {
					results.splice(0, results.length, ...toolResultTexts(context));
					if (call === 1) return callTool('count', { count: 'invalid' });
					return call === 2 ? callTool('count', { count: '7' }) : quiet();
				}),
			}),
		}),
	);
	const visit = await enter(room);
	await visit.send({ text: 'Count.' });
	await waitForRoom(room);
	expect(prepared).toBe(2);
	expect(executed).toEqual([{ count: 7 }]);
	expect(results.join('\n')).toContain('Validation failed');
	expect(results.join('\n')).toContain('count=7');
});

it('captures the author callback and schema, and checks arguments before the callback runs', async () => {
	const counted: number[] = [];
	const schema = Type.Object({ count: Type.Number() });
	const options = {
		name: 'count',
		description: 'Count.',
		parameters: schema,
		execute: ({ count }: { count: number }) => {
			counted.push(count);
			return String(count);
		},
	};
	const tool = defineTool(options);
	options.execute = () => 'replacement';
	(schema.properties as Record<string, unknown>).count = Type.String();
	await expect(async () => tool.invoke({ count: 'bad' }, context)).rejects.toThrow();
	await expect(async () => tool.invoke({ count: '3' }, context)).rejects.toThrow();
	expect(counted).toEqual([]);
	expect(await tool.invoke({ count: 3 }, context)).toBe('3');
	expect(counted).toEqual([3]);
});

it('accepts a native JSON Schema without private TypeBox markers', async () => {
	let executed = 0;
	const tool = fromPiTool({
		name: 'json',
		label: 'JSON',
		description: 'JSON schema.',
		parameters: {
			type: 'object',
			properties: { count: { type: 'number' } },
			required: ['count'],
		},
		execute: async () => {
			executed += 1;
			return { content: [], details: {} };
		},
	});
	await tool.invoke({ count: 2 }, context);
	await expect(async () => tool.invoke({ count: 'bad' }, context)).rejects.toThrow();
	expect(executed).toBe(1);
});
