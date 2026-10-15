import { memoryJournals } from '@ambionframework/journal';
/**
 * The `compose` tool on the Pi executor, in a room on the scripted stream.
 * The seat calls `compose` once, and the script reads the tool result that the
 * model reads. The code runs in the test runtime of the core.
 */

import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import {
	createRuntime,
	defineAgent,
	defineTool,
	type Step,
	startRoom,
} from '@ambionframework/ambion';
import { COMPOSE_GUIDANCE, type ComposeOptions, composeExtension } from '@ambionframework/compose';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { enter, roomName, scriptedAgent, waitForRoom } from '../../ambion/test/support/room.ts';
import {
	callTool,
	quiet,
	say,
	scriptedStream,
	toolResultTexts,
} from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { functionRuntime } from '../../compose/test/support/compose-runtime.ts';
import { broken, echo, table, total } from '../../compose/test/support/compose-tools.ts';
import { pi, piExecution } from '../src/index.ts';

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
		compose: { runtime: functionRuntime, ...compose },
	});
	const room = stopAtEnd(
		await startRoom({
			name: roomName('pi-compose'),
			agents: [seat],
			runtime: createRuntime({
				storage: memoryJournals(),
				logger: (traced) => void logged.push(traced.step),
			}),
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
	const own: ComposeOptions = { runtime: functionRuntime, guidance: 'Own guidance.' };

	it.each([
		['absent', undefined, ['compose', 'describe'], COMPOSE_GUIDANCE],
		['an object', own, ['compose', 'describe'], 'Own guidance.'],
	])('gives the tool list of the seat for compose %s', (_name, compose, names, guidance) => {
		const executor = pi({
			instructions: 'Work.',
			model: 'scripted/worker',
			...(compose === undefined ? {} : { compose }),
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual(names);
		expect(executor.guidance).toBe(guidance);
	});

	it('refuses a malformed compose option', () => {
		expect(() =>
			pi({ instructions: 'Work.', model: 'scripted/worker', compose: {} as never }),
		).toThrow(/Agent compose/);
	});

	it('runs the extensions of the options before compose, which does not bind their tools', () => {
		const executor = pi({
			instructions: 'Work.',
			model: 'scripted/worker',
			extensions: [
				() => ({
					tools: [
						defineTool({
							name: 'extra',
							description: 'Extra.',
							parameters: Type.Object({}),
							execute: () => 'extra',
						}),
					],
					guidance: 'Use extra.',
				}),
			],
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual(['extra', 'compose', 'describe']);
		expect(executor.guidance).toBe(`Use extra.\n\n${COMPOSE_GUIDANCE}`);
		expect(executor).not.toHaveProperty('compose');
	});

	it('refuses a second compose extension when the agent is defined', () => {
		const executor = pi({
			instructions: 'Work.',
			model: 'scripted/worker',
			extensions: [composeExtension({ runtime: functionRuntime })],
		});
		expect(() => defineAgent({ name: 'twin', identity: 'Twin.', executor })).toThrow(
			"brings duplicate tools named 'compose'",
		);
	});

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
});
