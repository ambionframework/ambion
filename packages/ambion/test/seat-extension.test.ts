/**
 * A seat extension adds tools and guidance to a seat. An activation tool is
 * the one kind of tool whose entry receives the access of an activation:
 * the room tools, a `nested` call that records its steps, and an `approved`
 * record.
 */
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { AmbionTool, ToolContext } from '../src/bundle.ts';
import { ROOM_TOOL_NAMES } from '../src/define.ts';
import {
	type ActivationAccess,
	activationTool,
	describeExecutor,
	invokeChecked,
	invokeTool,
	type RoomCall,
	type RoomSpec,
	type SeatExtension,
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

/** An extension that adds one tool and one line of guidance, and reports what it read. */
function extension(name: string, reads: unknown[] = []): SeatExtension {
	return (seat) => {
		reads.push({
			tools: seat.tools.map((tool) => tool.name),
			bundles: seat.bundles.length,
			room: seat.room.map((spec) => spec.name),
		});
		return { tools: [own(name)], guidance: `Use ${name}.` };
	};
}

describe('a seat extension', () => {
	it('appends its tools and its guidance after the tools and the bundles, in order', () => {
		const reads: unknown[] = [];
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			tools: [own('lookup')],
			bundles: [{ tools: [own('inspect')], guidance: 'Use inspect.' }],
			extensions: [extension('first', reads), extension('second', reads)],
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual([
			'lookup',
			'inspect',
			'first',
			'second',
		]);
		expect(executor.guidance).toBe('Use inspect.\n\nUse first.\n\nUse second.');
		expect(executor).not.toHaveProperty('extensions');
		expect(Object.isFrozen(executor.tools[2])).toBe(true);
		// Each extension reads the tools of the seat before any extension, the bundles, and the room tools.
		const read = { tools: ['lookup', 'inspect'], bundles: 1, room: ROOM_TOOL_NAMES };
		expect(reads).toEqual([read, read]);
	});

	it('adds no tool and no guidance when an extension adds none, and when there is none', () => {
		const silent: SeatExtension = () => ({ tools: [], guidance: ' \n ' });
		for (const extensions of [undefined, [], [silent]]) {
			const executor = describeExecutor({
				kind: 'test',
				instructions: 'Test.',
				tools: [own('lookup')],
				...(extensions === undefined ? {} : { extensions }),
			});
			expect(executor.tools.map((tool) => tool.name)).toEqual(['lookup']);
			expect(executor).not.toHaveProperty('guidance');
		}
	});

	it.each([
		['a function', () => ({ tools: [] })],
		['a list with a value that is no function', [{}]],
		['null', null],
	])('refuses extensions that are %s', (_name, extensions) => {
		expect(() =>
			describeExecutor({ kind: 'test', instructions: 'Test.', extensions: extensions as never }),
		).toThrow('Agent extensions must be an array of functions.');
	});

	it('hands the tools of the seat, the bundles, and the room tools as values that it cannot change', () => {
		const seen: { tools: readonly AmbionTool[]; room: readonly RoomSpec[] }[] = [];
		const bundle = { tools: [own('inspect')] };
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			tools: [own('lookup')],
			bundles: [bundle],
			extensions: [
				(seat) => {
					seen.push(seat);
					expect(seat.bundles).toEqual([bundle]);
					return { tools: [] };
				},
			],
		});
		const { tools, room } = seen[0] ?? { tools: [], room: [] };
		expect(Object.isFrozen(tools)).toBe(true);
		expect(tools.every((tool) => Object.isFrozen(tool))).toBe(true);
		expect(Object.isFrozen(room)).toBe(true);
		expect(room.every((spec) => Object.isFrozen(spec))).toBe(true);
		expect(() => (tools as AmbionTool[]).push(own('extra'))).toThrow(TypeError);
		expect(executor.tools.map((tool) => tool.name)).toEqual(['lookup', 'inspect']);
		expect(room.find((spec) => spec.name === 'say')?.executionMode).toBe('sequential');
		expect(room.filter((spec) => spec.optional === true).map((spec) => spec.name)).toEqual([
			'seat',
			'unseat',
		]);
	});
});

describe('an activation tool', () => {
	const steps: Step[] = [];
	const record = (step: Step): void => void steps.push(step);
	const room: readonly RoomCall[] = [{ name: 'say', run: async () => ({ content: [] }) }];
	const nestedCtx: ToolContext = Object.freeze({ ...ctx, callId: 'a/0.1' });
	let access: ActivationAccess | undefined;
	const accessed = (): ActivationAccess | undefined => access;

	/** An activation tool that keeps its access, calls `inner` as a nested call, and records an approval. */
	const nest = (inner: AmbionTool) =>
		activationTool(
			{ name: 'nest', description: 'Nests.', parameters: Type.Object({}), label: 'nest' },
			async (_params, _ctx, given) => {
				access = given;
				given.approved('allow');
				const result = await given.nested(inner, { a: 1 }, { a: 1 }, nestedCtx);
				return typeof result === 'string' ? result : 'nested';
			},
		);
	const inner = own('inner');

	it('receives the room tools, and records the steps of a nested call with itself as parent', async () => {
		steps.length = 0;
		const tool = nest(inner);
		expect(Object.isFrozen(tool)).toBe(true);
		for (const run of [invokeTool, invokeChecked]) {
			steps.length = 0;
			await run(tool, {}, ctx, record, room);
			expect(accessed()?.room).toBe(room);
			expect(steps).toEqual([
				{ type: 'approval', call: 'a/0', answer: 'allow' },
				{ type: 'tool_call', call: 'a/0.1', name: 'inner', input: { a: 1 }, parent: 'a/0' },
				{
					type: 'tool_result',
					call: 'a/0.1',
					output: { content: [{ type: 'text', text: 'inner' }] },
					parent: 'a/0',
				},
			]);
		}
	});

	it('records an error step for a nested call that throws, and rethrows', async () => {
		steps.length = 0;
		const failing = defineTool({
			name: 'failing',
			description: 'Fails.',
			parameters: Type.Object({}),
			execute: () => {
				throw new Error('broken');
			},
		});
		await expect(invokeTool(nest(failing), {}, ctx, record, room)).rejects.toThrow('broken');
		expect(steps.map((step) => step.type)).toEqual(['approval', 'tool_call', 'tool_result']);
		expect(steps[2]).toMatchObject({ error: 'broken', parent: 'a/0' });
	});

	it('records no step and holds no room tool through invoke, or through invokeTool with no sink', async () => {
		const tool = nest(inner);
		for (const run of [
			() => tool.invoke({}, ctx),
			() => invokeTool(tool, {}, ctx),
			() => invokeTool(tool, {}, ctx, undefined, room),
		]) {
			steps.length = 0;
			access = undefined;
			expect(await run()).toBe('inner');
			expect(accessed()?.room).toBeUndefined();
			expect(steps).toEqual([]);
		}
	});

	it('keeps the entry through the capture of a tool of an extension', async () => {
		steps.length = 0;
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			extensions: [() => ({ tools: [nest(inner)] })],
		});
		const added = executor.tools.find((one) => one.name === 'nest');
		if (added === undefined) throw new Error('The extension tool is missing.');
		await invokeTool(added, {}, ctx, record, room);
		expect(steps.map((step) => step.type)).toEqual(['approval', 'tool_call', 'tool_result']);
	});

	it('loses the entry when a wrapper replaces its invoke', async () => {
		steps.length = 0;
		access = undefined;
		const tool = nest(inner);
		const wrapped: AmbionTool = {
			...tool,
			invoke: (params, context) => tool.invoke(params, context),
		};
		await invokeTool(wrapped, {}, ctx, record, room);
		expect(accessed()?.room).toBeUndefined();
		expect(steps).toEqual([]);
	});

	it('is the only kind of tool that gets an access: a plain tool runs with its arguments and context alone', async () => {
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
