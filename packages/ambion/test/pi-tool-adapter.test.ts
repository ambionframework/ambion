import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';
import { defineAgent, defineTool, fromPiTool, pi, startRoom } from '../src/index.ts';
import { enter, roomName, waitForRoom } from './support/room.ts';
import { callTool, quiet, scripted, toolResultTexts } from './support/scripted.ts';

const parameters = Type.Object({ count: Type.Number() });

it('preserves native execution metadata, context, updates, and full results', async () => {
	const execute = vi.fn(
		async (
			_id: string,
			params: { count: number },
			_signal?: AbortSignal,
			onUpdate?: (result: { content: []; details: { count: number } }) => void,
		) => {
			onUpdate?.({ content: [], details: params });
			return {
				content: [{ type: 'text' as const, text: 'done' }],
				details: params,
				terminate: true,
			};
		},
	);
	const native: AgentTool<typeof parameters, { count: number }> = {
		name: 'count',
		label: 'Count items',
		description: 'Count items.',
		parameters,
		executionMode: 'sequential',
		execute,
	};
	const adapted = fromPiTool(native);
	native.execute = async () => {
		throw new Error('mutated native callback');
	};
	native.label = 'Changed label';
	const signal = new AbortController().signal;
	const onUpdate = vi.fn();
	const result = await adapted.invoke(
		{ count: 2 },
		{
			agent: { name: 'worker', identity: 'Worker.' },
			callId: 'call-1',
			signal,
			onUpdate,
		},
	);
	expect(adapted).toMatchObject({ label: 'Count items', executionMode: 'sequential' });
	expect(execute).toHaveBeenCalledWith('call-1', { count: 2 }, signal, expect.any(Function));
	expect(onUpdate).toHaveBeenCalledWith({ content: [], details: { count: 2 } });
	expect(result).toEqual({
		content: [{ type: 'text', text: 'done' }],
		details: { count: 2 },
		terminate: true,
	});
	execute.mockRejectedValueOnce(new Error('native failure'));
	await expect(
		adapted.invoke(
			{ count: 2 },
			{
				agent: { name: 'worker', identity: 'Worker.' },
				callId: 'call-2',
			},
		),
	).rejects.toThrow('native failure');
});

it('prepares native arguments once per call and validates before execution', async () => {
	const execute = vi.fn(async (_id: string, params: { count: number }) => ({
		content: [{ type: 'text' as const, text: `count=${params.count}` }],
		details: params,
	}));
	const prepareArguments = vi.fn((args: unknown) => {
		const count =
			typeof args === 'object' && args !== null && 'count' in args ? args.count : undefined;
		return { count: Number(count) };
	});
	const worker = defineAgent({
		name: 'worker',
		identity: 'Worker.',
		executor: pi({
			instructions: 'Work.',
			model: 'scripted/worker',
			tools: [
				fromPiTool({
					name: 'count',
					label: 'Count',
					description: 'Count.',
					parameters,
					prepareArguments,
					execute,
				}),
			],
		}),
	});
	const results: string[] = [];
	const room = await startRoom({
		name: roomName('native-adapter'),
		agents: [worker],
		streamFn: scripted((context, _agent, call) => {
			results.splice(0, results.length, ...toolResultTexts(context));
			if (call === 1) return callTool('count', { count: 'invalid' });
			return call === 2 ? callTool('count', { count: '7' }) : quiet();
		}),
	});
	try {
		const visit = await enter(room);
		await visit.send({ text: 'Count.' });
		await waitForRoom(room);
		expect(prepareArguments).toHaveBeenCalledTimes(2);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[1]).toEqual({ count: 7 });
		expect(results.join('\n')).toContain('Validation failed');
		expect(results.join('\n')).toContain('count=7');
	} finally {
		await room.stop();
	}
});

it('checks unknown invocation arguments before calling a typed author callback', async () => {
	const execute = vi.fn(({ count }: { count: number }) => String(count));
	const tool = defineTool({ name: 'count', description: 'Count.', parameters, execute });
	const context = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'call-1' };
	await expect(async () => tool.invoke({ count: 'bad' }, context)).rejects.toThrow();
	expect(execute).not.toHaveBeenCalled();
	expect(await tool.invoke({ count: 2 }, context)).toBe('2');
});

it('captures the author callback and schema before caller mutation', async () => {
	const schema = Type.Object({ count: Type.Number() });
	const options = {
		name: 'count',
		description: 'Count.',
		parameters: schema,
		execute: ({ count }: { count: number }) => String(count),
	};
	const tool = defineTool(options);
	options.execute = () => 'replacement';
	(schema.properties as Record<string, unknown>).count = Type.String();
	const context = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'captured-call' };
	expect(await tool.invoke({ count: 3 }, context)).toBe('3');
	await expect(async () => tool.invoke({ count: '3' }, context)).rejects.toThrow();
});

it('accepts a native JSON Schema without private TypeBox markers', async () => {
	const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };
	const execute = vi.fn(async (_id: string, _params: unknown) => ({ content: [], details: {} }));
	const tool = fromPiTool({
		name: 'json',
		label: 'JSON',
		description: 'JSON schema.',
		parameters: schema,
		execute,
	});
	const context = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'json-call' };
	await tool.invoke({ count: 2 }, context);
	await expect(async () => tool.invoke({ count: 'bad' }, context)).rejects.toThrow();
	expect(execute).toHaveBeenCalledTimes(1);
});
