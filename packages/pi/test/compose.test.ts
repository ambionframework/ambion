/**
 * The `compose` tool on the Pi executor, in a room on the scripted stream.
 * The seat calls `compose` once, and the script reads the tool result that the
 * model reads. The code runs in the test evaluator of the core.
 */

import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import {
	type ComposeOptions,
	createRuntime,
	defineTool,
	type Step,
	startRoom,
} from '@ambionframework/ambion';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	broken,
	echo,
	gauge,
	later,
	table,
	total,
} from '../../ambion/test/support/compose-tools.ts';
import { functionEvaluator } from '../../ambion/test/support/evaluator.ts';
import { enter, roomName, scriptedAgent, waitForRoom } from '../../ambion/test/support/room.ts';
import {
	callTool,
	quiet,
	say,
	scriptedStream,
	toolResultTexts,
} from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { piExecution } from '../src/index.ts';

interface Call {
	readonly uses: readonly string[];
	readonly code: string;
}

/** One room where the seat calls `compose` once. It returns what the model read and what the trace logged. */
async function composed(tools: AmbionTool[], call: Call, compose: Partial<ComposeOptions> = {}) {
	const logged: Step[] = [];
	const shown: string[] = [];
	const read: string[] = [];
	const seat = scriptedAgent('worker', 'Composes tools.', {
		tools,
		compose: { evaluator: functionEvaluator, ...compose },
	});
	const room = stopAtEnd(
		await startRoom({
			name: roomName('pi-compose'),
			agents: [seat],
			runtime: createRuntime({ logger: (traced) => void logged.push(traced.step) }),
			execution: piExecution({
				sessions: 'memory',
				stream: scriptedStream((context, _seat, request) => {
					if (request === 1) return callTool('compose', { ...call });
					shown.push(JSON.stringify(context.messages));
					read.push(...toolResultTexts(context));
					return request === 2 ? say('done') : quiet();
				}),
			}),
		}),
	);
	await (await enter(room)).send({ text: 'go' });
	await waitForRoom(room);
	return { logged, read: read[0] ?? '', shown: shown.join('') };
}

const nestedOf = (logged: readonly Step[]) => logged.filter((step) => 'parent' in step);

describe('compose on a Pi seat', () => {
	it('binds tools with a declared output, hands the large result on, and shows the model the returned value alone', async () => {
		const seen: ToolContext[] = [];
		const spy = defineTool({
			name: 'spy',
			description: 'Read the context.',
			parameters: Type.Object({}),
			execute: (_params, ctx) => {
				seen.push(ctx);
				return 'seen';
			},
		});
		const { logged, read, shown } = await composed([table, total, spy], {
			uses: ['table', 'total', 'spy'],
			code: `
				const { rows } = await tools.table({ count: 400 });
				await tools.spy({});
				return await tools.total({ ids: rows.map((row) => row.id) });
			`,
		});
		expect(read).toBe('{"sum":79800}');
		expect(shown).not.toContain('row 399');
		const parent = logged.find((step) => step.type === 'tool_call' && step.name === 'compose');
		const compose = parent !== undefined && 'call' in parent ? parent.call : '';
		expect(nestedOf(logged).map((step) => [step.type, 'parent' in step && step.parent])).toEqual(
			Array.from({ length: 6 }, (_, at) => [at % 2 === 0 ? 'tool_call' : 'tool_result', compose]),
		);
		// The nested call keeps its provenance, its deadline, and the signal of the compose call.
		expect(seen[0]).toMatchObject({
			composeCall: compose,
			agent: { name: 'worker' },
			exchange: { person: 'andrei' },
		});
		expect(seen[0]?.callId).toBe(`${compose}.2`);
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.deadline).toBeGreaterThan(Date.now());
	});

	it('binds the room tools: a say in a compose call lands', async () => {
		const { read } = await composed([], {
			uses: ['say'],
			code: `return await tools.say({ to: 'andrei', text: 'Done.' });`,
		});
		expect(JSON.parse(read)).toMatch(/^said #\d+ to andrei$/);
	});

	it.each([
		{
			name: 'an error',
			tools: [echo, broken],
			call: {
				uses: ['echo', 'broken'],
				code: `await tools.echo({ text: 'a' }); await tools.broken({});`,
			},
			compose: {},
			read: [
				'The compose call failed at call ',
				': The archive is closed.\nCalls, in the order that the code made them:\n',
				': completed\n',
				': failed',
			],
		},
		{
			name: 'a limit',
			tools: [echo],
			call: {
				uses: ['echo'],
				code: `for (let i = 0; i < 3; i++) await tools.echo({ text: 'a' });`,
			},
			compose: { limits: { calls: 2 } },
			read: [
				'The compose call failed: The compose call passed compose.limits.calls (2).',
				'echo: completed',
			],
		},
		{
			name: 'a denial',
			tools: [echo],
			call: { uses: ['echo'], code: `await tools.echo({ text: 'a' });` },
			compose: { approve: () => 'deny' as const },
			read: [
				'The compose call failed: The approval refused this compose call. No code ran.\nNo call started.',
			],
		},
		{
			name: 'a name that the catalog lacks',
			tools: [echo],
			call: { uses: ['nothing'], code: '' },
			compose: {},
			read: [
				"The compose call failed: The catalog holds no tool named 'nothing'.\nNo call started.",
			],
		},
	])(
		'gives the model the status and the ledger of $name as a tool error',
		async ({ tools, call, compose, read }) => {
			const ran = await composed(tools, call, compose);
			for (const part of read) expect(ran.read).toContain(part);
			// A nested call that never started leaves no step.
			const errors = ran.logged.filter(
				(step) => step.type === 'tool_result' && step.error !== undefined,
			);
			expect(errors.length).toBeGreaterThan(0);
		},
	);

	it('keeps the result of a call that outlives the code, and names that call', async () => {
		const { read } = await composed([later('later', false)], {
			uses: ['later'],
			code: `tools.later({}); return 'sent';`,
		});
		expect(read).toMatch(/^"sent"\nCall \S+ \(later\) completed after the code returned\.$/);
	});

	it('runs the cap of calls together, one call at a time for a sequential tool, and settles the siblings of a failed call', async () => {
		const wide = gauge('wide');
		const narrow = gauge('narrow', 'sequential');
		const ran = await composed(
			[wide.tool, narrow.tool, broken, later('slow', false)],
			{
				uses: ['wide', 'narrow', 'broken', 'slow'],
				code: `
				await Promise.all([
					...Array.from({ length: 6 }, () => tools.wide({})),
					...Array.from({ length: 3 }, () => tools.narrow({})),
				]);
				await Promise.all([tools.slow({}), tools.broken({})]);
			`,
			},
			{ limits: { concurrent: 3 } },
		);
		expect(wide.seen.most).toBeLessThanOrEqual(3);
		expect(wide.seen.most).toBeGreaterThan(1);
		expect(narrow.seen).toMatchObject({ most: 1, calls: 3 });
		expect(ran.read).toContain('slow: completed');
		expect(ran.read).toContain('broken: failed');
	});
});
