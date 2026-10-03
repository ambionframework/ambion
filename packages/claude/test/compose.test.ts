/**
 * The `compose` tool on the Claude executor, over the fake executable. The
 * tool is one tool of the room server, so the model reads its content alone:
 * the returned value, or the error and the ledger as an error result.
 */
import {
	type AmbionTool,
	COMPOSE_GUIDANCE,
	type ComposeOptions,
	defineTool,
	type ToolContext,
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
import { claude } from '../src/index.ts';
import { open, seat, viewOf } from './support.ts';

interface Call {
	readonly uses: readonly string[];
	readonly code: string;
}

/** One pass where the fake calls the tools in order. It returns what the model read, and the steps. */
async function composed(
	tools: AmbionTool[],
	calls: { tool: string; args: unknown }[],
	compose: Partial<ComposeOptions> = {},
) {
	const run = open(
		{ passes: [calls.map((call) => ({ call }))] },
		seat({ tools, compose: { evaluator: functionEvaluator, ...compose } }),
	);
	await run.session.pass({ kind: 'view', view: viewOf() });
	run.session.close?.();
	const results = run
		.log()
		.flatMap((line) =>
			'tool_result' in line
				? [line.tool_result as { tool: string; content: { text: string }[]; isError: boolean }]
				: [],
		);
	return {
		steps: run.steps,
		results,
		read: results.map((result) => result.content.map((part) => part.text).join('')),
	};
}

const compose = (call: Call) => ({ tool: 'compose', args: call });

describe('compose on a Claude seat', () => {
	const own: ComposeOptions = { evaluator: functionEvaluator, guidance: 'Own guidance.' };

	it.each([
		['absent', undefined, ['compose'], COMPOSE_GUIDANCE],
		['false', false as const, [], undefined],
		['an object', own, ['compose'], 'Own guidance.'],
	])('gives the tool list of the seat for compose %s', (_name, compose, names, guidance) => {
		const executor = claude({
			instructions: 'Work.',
			model: 'claude-fake',
			...(compose === undefined ? {} : { compose }),
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual(names);
		expect(executor.guidance).toBe(guidance);
	});

	it('binds tools with a declared output, and shows the model the returned value alone', async () => {
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
		const ran = await composed(
			[table, total, spy],
			[
				compose({
					uses: ['table', 'total', 'spy'],
					code: `
					const { rows } = await tools.table({ count: 400 });
					await tools.spy({});
					return await tools.total({ ids: rows.map((row) => row.id) });
				`,
				}),
			],
		);
		expect(ran.read).toEqual(['{"sum":79800}']);
		expect(ran.results[0]?.isError).toBe(false);
		const parent = ran.steps.find((step) => step.type === 'tool_call' && step.name === 'compose');
		const call = parent !== undefined && 'call' in parent ? parent.call : '';
		const nested = ran.steps.filter((step) => 'parent' in step);
		expect(nested).toHaveLength(6);
		expect(nested.every((step) => 'parent' in step && step.parent === call)).toBe(true);
		expect(JSON.stringify(ran.read)).not.toContain('row 399');
		expect(seen[0]).toMatchObject({
			composeCall: call,
			callId: `${call}.2`,
			agent: { name: 'sonnet' },
			room: 'lab',
			exchange: { person: 'priya', from: 1 },
		});
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it('gives a direct call of the same tool its own id, and delivers no nested call', async () => {
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
		const ran = await composed(
			[spy],
			[compose({ uses: ['spy'], code: `return await tools.spy({});` }), { tool: 'spy', args: {} }],
		);
		const direct = ran.steps.find(
			(step) => step.type === 'tool_call' && step.name === 'spy' && step.parent === undefined,
		);
		expect(direct !== undefined && 'call' in direct).toBe(true);
		expect(seen).toHaveLength(2);
		expect(seen[0]?.composeCall).toBeDefined();
		expect(seen[1]?.composeCall).toBeUndefined();
		expect(seen[1]?.callId).toBe(direct !== undefined && 'call' in direct ? direct.call : '');
	});

	it.each([
		{
			name: 'an error',
			tools: [echo, broken],
			call: {
				uses: ['echo', 'broken'],
				code: `await tools.echo({ text: 'a' }); await tools.broken({});`,
			},
			options: {},
			read: [
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
			options: { limits: { calls: 2 } },
			read: ['The compose call passed compose.limits.calls (2).', 'echo: completed'],
		},
		{
			name: 'a denial',
			tools: [echo],
			call: { uses: ['echo'], code: `await tools.echo({ text: 'a' });` },
			options: { approve: () => 'deny' as const },
			read: ['The approval refused this compose call. No code ran.\nNo call started.'],
		},
		{
			name: 'a name that the catalog lacks',
			tools: [echo],
			call: { uses: ['nothing'], code: '' },
			options: {},
			read: ["The catalog holds no tool named 'nothing'.\nNo call started."],
		},
	])(
		'gives the model the status and the ledger of $name as an error result',
		async ({ tools, call, options, read }) => {
			const ran = await composed(tools, [compose(call)], options);
			expect(ran.results[0]?.isError).toBe(true);
			for (const part of read) expect(ran.read[0]).toContain(part);
		},
	);

	it('keeps the result of a call that outlives the code, and names that call', async () => {
		const ran = await composed(
			[later('later', false)],
			[compose({ uses: ['later'], code: `tools.later({}); return 'sent';` })],
		);
		expect(ran.read[0]).toMatch(/^"sent"\nCall \S+ \(later\) completed after the code returned\.$/);
	});

	it('runs the cap of calls together, one call at a time for a sequential tool, and settles the siblings of a failed call', async () => {
		const wide = gauge('wide');
		const narrow = gauge('narrow', 'sequential');
		const ran = await composed(
			[wide.tool, narrow.tool, broken, later('slow', false)],
			[
				compose({
					uses: ['wide', 'narrow', 'broken', 'slow'],
					code: `
						await Promise.all([
							...Array.from({ length: 6 }, () => tools.wide({})),
							...Array.from({ length: 3 }, () => tools.narrow({})),
						]);
						await Promise.all([tools.slow({}), tools.broken({})]);
					`,
				}),
			],
			{ limits: { concurrent: 3 } },
		);
		expect(wide.seen.most).toBeLessThanOrEqual(3);
		expect(wide.seen.most).toBeGreaterThan(1);
		expect(narrow.seen).toMatchObject({ most: 1, calls: 3 });
		expect(ran.read[0]).toContain('slow: completed');
		expect(ran.read[0]).toContain('broken: failed');
	});
});
