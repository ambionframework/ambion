import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { expect, expectTypeOf, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineTool,
	fromPiTool,
	pi,
	startRoom,
	type ToolBundle,
} from '../src/index.ts';
import { roomName, storedOf } from './support/room.ts';
import { memory } from './support/storage.ts';

const author = { name: 'worker', identity: 'Worker.' };
const authorPi = { instructions: 'Work.', model: 'scripted/worker' };
const parameters = Type.Object({ count: Type.Number() });
const native: AgentTool<typeof parameters, { count: number }> = {
	name: 'count',
	label: 'Count',
	description: 'Count items.',
	parameters,
	execute: async (_id, params) => ({
		content: [{ type: 'text', text: String(params.count) }],
		details: params,
	}),
};

it('preserves schema inference while composing heterogeneous tools', () => {
	const lookup = defineTool({
		name: 'lookup',
		description: 'Look up a name.',
		parameters: Type.Object({ name: Type.String() }),
		execute: ({ name }, context) => {
			expectTypeOf(name).toEqualTypeOf<string>();
			expectTypeOf(context.callId).toEqualTypeOf<string>();
			return name;
		},
	});
	const count = defineTool({
		name: 'count',
		description: 'Count items.',
		parameters,
		execute: ({ count }) => {
			expectTypeOf(count).toEqualTypeOf<number>();
			return String(count);
		},
	});
	const bundle: ToolBundle = { tools: [lookup, count] };
	expect(
		defineAgent({
			...author,
			executor: pi({ ...authorPi, bundles: [bundle] }),
		}).executor.tools.map((tool) => tool.name),
	).toEqual(['lookup', 'count']);
	expect(
		defineAgent({ ...author, executor: pi({ ...authorPi, tools: [lookup, fromPiTool(native)] }) })
			.executor.tools,
	).toHaveLength(2);

	// These calls are checked by tsc but deliberately never executed.
	const rejectedInputs = () => {
		// @ts-expect-error A native Pi tool needs an explicit adapter.
		defineAgent({ ...author, executor: pi({ ...authorPi, tools: [native] }) });
		// @ts-expect-error A bundle belongs in bundles, not tools.
		defineAgent({ ...author, executor: pi({ ...authorPi, tools: [bundle] }) });
		// @ts-expect-error Malformed tool values are not accepted.
		defineAgent({ ...author, executor: pi({ ...authorPi, tools: [{ name: 'missing-execute' }] }) });
		defineTool({
			name: 'wrong',
			description: 'Wrong callback.',
			parameters,
			// @ts-expect-error Execute parameters must match the schema.
			execute: (_params: { count: string }) => 'wrong',
		});
		defineTool({
			name: 'wrong-prepare',
			description: 'Wrong preparation.',
			parameters,
			// @ts-expect-error Prepared arguments must match the schema.
			prepareArguments: () => ({ count: 'wrong' }),
			execute: () => 'wrong',
		});
	};
	expectTypeOf(rejectedInputs).returns.toBeVoid();
});

it.each([null, 12, {}, { name: 'missing-execute' }, { tools: [] }])(
	'rejects malformed tool input at definition time: %j',
	(tool) => {
		expect(() => Reflect.apply(pi, undefined, [{ ...authorPi, tools: [tool] }])).toThrow();
	},
);

it('rejects malformed structural tools before a room writes its journal', async () => {
	const opened = await memory.open();
	const name = roomName('invalid-structural-tool');
	try {
		await expect(
			Reflect.apply(startRoom, undefined, [
				{
					name,
					runtime: createRuntime({ storage: opened.storage }),
					agents: [{ ...author, executor: { kind: 'pi', ...authorPi, tools: [{ name: 'bad' }] } }],
				},
			]),
		).rejects.toThrow();
		expect(await storedOf(opened.journals, name)).toEqual([]);
	} finally {
		await opened.dispose();
	}
});

it.each([
	{ name: 'bad', description: 'Bad.', parameters, execute: 12 },
	{ name: 'bad', description: 'Bad.', parameters: null, execute: () => 'bad' },
])('rejects malformed authoring options immediately: %j', (options) => {
	expect(() => Reflect.apply(defineTool, undefined, [options])).toThrow();
});
