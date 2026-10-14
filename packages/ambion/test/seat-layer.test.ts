/**
 * A layer adds tools and guidance to a seat, and an activation tool is the
 * one kind of tool that receives the step sink and the room tools of an
 * activation.
 */
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { AmbionTool, ToolContext } from '../src/bundle.ts';
import { ROOM_TOOL_NAMES } from '../src/define.ts';
import {
	activationTool,
	describeExecutor,
	invokeChecked,
	invokeTool,
	type RoomCall,
	type RoomSpec,
	type SeatLayer,
} from '../src/hosting.ts';
import { defineTool } from '../src/index.ts';
import type { Step } from '../src/types.ts';

const ctx: ToolContext = Object.freeze({
	agent: { name: 'worker', identity: 'Works.' },
	callId: 'a/0',
	signal: undefined,
});

const own = (name: string): AmbionTool =>
	defineTool({
		name,
		description: `The tool ${name}.`,
		parameters: Type.Object({}),
		execute: () => name,
	});

/** A layer that adds one tool and one line of guidance, and reports what it read. */
function layer(name: string, reads: unknown[] = []): SeatLayer {
	return (seat) => {
		reads.push({
			tools: seat.tools.map((tool) => tool.name),
			bundles: seat.bundles.length,
			room: seat.room.map((spec) => spec.name),
		});
		return { tools: [own(name)], guidance: `Use ${name}.` };
	};
}

describe('a seat layer', () => {
	it('appends its tools and its guidance after the tools and the bundles, in layer order', () => {
		const reads: unknown[] = [];
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			tools: [own('lookup')],
			bundles: [{ tools: [own('inspect')], guidance: 'Use inspect.' }],
			layers: [layer('first', reads), layer('second', reads)],
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual([
			'lookup',
			'inspect',
			'first',
			'second',
		]);
		expect(executor.guidance).toBe('Use inspect.\n\nUse first.\n\nUse second.');
		expect(Object.isFrozen(executor.tools[2])).toBe(true);
		// Each layer reads the tools of the seat before any layer, the bundles, and the room tools.
		const read = { tools: ['lookup', 'inspect'], bundles: 1, room: ROOM_TOOL_NAMES };
		expect(reads).toEqual([read, read]);
	});

	it('adds no tool and no guidance when a layer adds none, and when there is no layer', () => {
		const silent: SeatLayer = () => ({ tools: [] });
		for (const layers of [undefined, [], [silent]]) {
			const executor = describeExecutor({
				kind: 'test',
				instructions: 'Test.',
				tools: [own('lookup')],
				...(layers === undefined ? {} : { layers }),
			});
			expect(executor.tools.map((tool) => tool.name)).toEqual(['lookup']);
			expect(executor).not.toHaveProperty('guidance');
		}
	});

	it('hands the room tools to a layer as specs, and marks say as sequential', () => {
		let room: readonly RoomSpec[] = [];
		describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			layers: [
				(seat) => {
					room = seat.room;
					return { tools: [] };
				},
			],
		});
		expect(room.find((spec) => spec.name === 'say')?.executionMode).toBe('sequential');
		expect(room.filter((spec) => spec.optional === true).map((spec) => spec.name)).toEqual([
			'seat',
			'unseat',
		]);
	});
});

describe('an activation tool', () => {
	const seen: { record: unknown; room: unknown }[] = [];
	const tool = activationTool(
		{
			name: 'nest',
			description: 'Takes the activation.',
			parameters: Type.Object({}),
			label: 'nest',
		},
		(_params, _ctx, record, room) => {
			seen.push({ record, room });
			return 'nested';
		},
	);
	const record = (_step: Step): void => {};
	const room: readonly RoomCall[] = [{ name: 'say', run: async () => ({ content: [] }) }];

	it('receives the sink and the room tools through invokeTool and invokeChecked', async () => {
		seen.length = 0;
		await invokeTool(tool, {}, ctx, record, room);
		await invokeChecked(tool, {}, ctx, record, room);
		expect(seen).toEqual([
			{ record, room },
			{ record, room },
		]);
		expect(Object.isFrozen(tool)).toBe(true);
	});

	it('receives neither through invoke, or through invokeTool with no sink', async () => {
		seen.length = 0;
		await tool.invoke({}, ctx);
		await invokeTool(tool, {}, ctx);
		await invokeTool(tool, {}, ctx, undefined, room);
		expect(seen).toEqual([
			{ record: undefined, room: undefined },
			{ record: undefined, room: undefined },
			{ record: undefined, room: undefined },
		]);
	});

	it('keeps the entry through the capture of a layer tool', async () => {
		seen.length = 0;
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			layers: [() => ({ tools: [tool] })],
		});
		const added = executor.tools.find((one) => one.name === 'nest');
		expect(added).not.toBe(tool);
		if (added === undefined) throw new Error('The layer tool is missing.');
		await invokeTool(added, {}, ctx, record, room);
		expect(seen).toEqual([{ record, room }]);
	});

	it('is the only kind of tool that gets the sink: a plain tool runs with the context alone', async () => {
		const args: unknown[][] = [];
		const plain: AmbionTool = {
			name: 'plain',
			description: 'Plain.',
			parameters: Type.Object({}),
			label: 'plain',
			invoke: (...rest: unknown[]) => {
				args.push(rest);
				return 'plain';
			},
		};
		await invokeTool(plain, {}, ctx, record, room);
		expect(args).toEqual([[{}, ctx]]);
	});
});

describe('a tool built by hand', () => {
	it('copies no entry when a wrapper replaces its invoke', async () => {
		const seen: unknown[] = [];
		const tool = activationTool(
			{ name: 'nest', description: 'Nests.', parameters: Type.Object({}), label: 'nest' },
			(_params, _ctx, record) => {
				seen.push(record);
				return 'nested';
			},
		);
		const wrapped: AmbionTool = {
			...tool,
			invoke: (params, context) => tool.invoke(params, context),
		};
		await invokeTool(wrapped, {}, ctx, (_step: Step) => {}, []);
		expect(seen).toEqual([undefined]);
	});
});
