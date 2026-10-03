/**
 * The `compose` tool, run through the `invoke` that `describeExecutor` appends:
 * the catalog, the approval, the ledger, the limits, the nested context, the
 * declared output check, and the result and the error that the model reads.
 * The code runs in the evaluator of `test/support`.
 */
import { type TSchema, Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { AmbionTool, ToolContext } from '../src/bundle.ts';
import { ComposeFailure } from '../src/compose.ts';
import type { RoomCall } from '../src/compose-tool.ts';
import { describeExecutor } from '../src/define.ts';
import { invokeTool } from '../src/hosting.ts';
import {
	type ComposeOptions,
	type ComposeResult,
	createRuntime,
	defineAgent,
	defineTool,
	type Evaluator,
	type Step,
	startRoom,
} from '../src/index.ts';
import { callTool, quiet, say, scripted, settled } from '../src/testing.ts';
import {
	broken,
	echo,
	gauge,
	held,
	later,
	pause,
	table,
	text,
	total,
} from './support/compose-tools.ts';
import { functionEvaluator } from './support/evaluator.ts';
import { andrei, collect, messagesOf, participantsOf, roomName } from './support/room.ts';
import { stopAtEnd } from './support/stop.ts';

const hidden = defineTool({
	name: 'hidden',
	description: 'Stays out of compose.',
	parameters: Type.Object({}),
	compose: false,
	execute: () => 'hidden',
});

/** An evaluator that counts its runs. A refused compose call never reaches it. */
function neverRuns() {
	let runs = 0;
	const evaluator: Evaluator = {
		evaluate: async () => {
			runs += 1;
			return undefined;
		},
	};
	return { evaluator, evaluated: () => runs };
}

interface Ran {
	readonly result: ComposeResult;
	/** What the model reads: the content of a result, or the message of the error. */
	readonly read: string;
	readonly steps: Step[];
	readonly raw: unknown;
}

interface RunOptions {
	readonly compose?: Partial<ComposeOptions>;
	readonly ctx?: Partial<ToolContext>;
	readonly record?: boolean;
}

function composeOf(
	tools: readonly AmbionTool[],
	options: Partial<ComposeOptions> = {},
): AmbionTool {
	const executor = describeExecutor({
		kind: 'test',
		instructions: 'Test.',
		tools,
		compose: { evaluator: functionEvaluator, ...options },
	});
	const tool = executor.tools.find((one) => one.name === 'compose');
	if (tool === undefined) throw new Error('The executor has no compose tool.');
	return tool;
}

/** Run one compose call, and read the result whether it completed or failed. */
async function run(
	tools: readonly AmbionTool[],
	args: { readonly uses: readonly string[]; readonly code: string },
	options: RunOptions = {},
): Promise<Ran> {
	const steps: Step[] = [];
	const ctx: ToolContext = {
		agent: { name: 'worker', identity: 'Worker.' },
		callId: 'c1',
		room: 'lab',
		activation: 'message:1:worker:1',
		exchange: { person: 'priya', from: 1 },
		deadline: Date.now() + 60_000,
		...options.ctx,
	};
	const tool = composeOf(tools, options.compose);
	try {
		const sink = options.record === false ? undefined : (step: Step) => void steps.push(step);
		const raw = await invokeTool(tool, args, ctx, sink);
		if (typeof raw === 'string') throw new Error('compose returned a string.');
		return {
			result: raw.details as ComposeResult,
			read: raw.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
			steps,
			raw,
		};
	} catch (error) {
		if (!(error instanceof ComposeFailure)) throw error;
		return { result: error.details, read: error.message, steps, raw: error };
	}
}

const ledgerOf = (ran: Ran) => ran.result.calls.map((call) => [call.call, call.tool, call.status]);

describe('a completed compose call', () => {
	it('passes a large result between tools, keeps it out of the content, and records the nested steps', async () => {
		const probe: ToolContext[] = [];
		const spy = defineTool({
			name: 'spy',
			description: 'Read the context.',
			parameters: Type.Object({}),
			execute: (_params, ctx) => {
				probe.push(ctx);
				return 'seen';
			},
		});
		const ran = await run([table, total, spy, hidden], {
			uses: ['table', 'total', 'spy'],
			code: `
				const { rows } = await tools.table({ count: 500 });
				const { sum } = await tools.total({ ids: rows.map((row) => row.id) });
				await tools.spy({});
				return { count: rows.length, sum };
			`,
		});
		expect(ran.result).toEqual({
			status: 'completed',
			value: { count: 500, sum: 124750 },
			calls: [
				{ call: 'c1.1', tool: 'table', status: 'completed' },
				{ call: 'c1.2', tool: 'total', status: 'completed' },
				{ call: 'c1.3', tool: 'spy', status: 'completed' },
			],
		});
		expect(ran.read).toBe('{"count":500,"sum":124750}');
		expect(ran.raw).not.toHaveProperty('terminate');
		// The data stays in the steps of the nested calls, and each step names its parent.
		expect(ran.steps.map((step) => [step.type, 'call' in step ? step.call : ''])).toEqual([
			['tool_call', 'c1.1'],
			['tool_result', 'c1.1'],
			['tool_call', 'c1.2'],
			['tool_result', 'c1.2'],
			['tool_call', 'c1.3'],
			['tool_result', 'c1.3'],
		]);
		expect(ran.steps.every((step) => 'parent' in step && step.parent === 'c1')).toBe(true);
		expect(ran.steps[1]).toMatchObject({ output: { details: { rows: expect.any(Array) } } });
		// The nested call keeps the provenance of the compose call, and has an id of its own.
		expect(probe[0]).toMatchObject({
			agent: { name: 'worker', identity: 'Worker.' },
			room: 'lab',
			activation: 'message:1:worker:1',
			exchange: { person: 'priya', from: 1 },
			callId: 'c1.3',
			composeCall: 'c1',
		});
		expect(probe[0]?.deadline).toBeGreaterThan(Date.now());
		expect(probe[0]?.signal).toBeUndefined();
		expect(Object.isFrozen(probe[0])).toBe(true);
		// The nested context holds no sink: no value of it is a function.
		expect(Object.values(probe[0] ?? {}).filter((value) => typeof value === 'function')).toEqual(
			[],
		);
	});

	it('gives the text of an undeclared tool, the details of a declared one, and no value for no return', async () => {
		const parts = defineTool({
			name: 'parts',
			description: 'Two text parts and an image.',
			parameters: Type.Object({}),
			execute: () => ({
				content: [
					...text('first'),
					{ type: 'image' as const, data: 'AA==', mimeType: 'image/png' },
					...text('second'),
				],
				details: { hidden: true },
			}),
		});
		const ran = await run([parts, total], {
			uses: ['parts', 'total'],
			code: `return [await tools.parts({}), await tools.total({ ids: [1, 2] })];`,
		});
		expect(ran.result.value).toEqual(['first\nsecond', { sum: 3 }]);
		const none = await run([echo], { uses: [], code: 'const x = 1;' });
		expect(none.result).toEqual({ status: 'completed', calls: [] });
		expect(none.read).toBe('The compose call completed with no value.');
	});

	it('prepares the arguments of a nested call, and ignores a terminate flag', async () => {
		const ends = defineTool({
			name: 'ends',
			description: 'Ends the batch.',
			parameters: Type.Object({ text: Type.String() }),
			prepareArguments: (args) => (typeof args === 'string' ? { text: args } : (args as never)),
			execute: ({ text: value }) => ({ content: text(value), details: null, terminate: true }),
		});
		const ran = await run([ends], { uses: ['ends'], code: `return await tools.ends('hi');` });
		expect(ran.result.value).toBe('hi');
		expect(ran.raw).not.toHaveProperty('terminate');
	});

	it('records no nested step when the call has no step sink', async () => {
		const ran = await run(
			[echo],
			{
				uses: ['echo'],
				code: `return await tools.echo({ text: 'x' });`,
			},
			{ record: false },
		);
		expect(ran.result.value).toBe('x');
		expect(ran.steps).toEqual([]);
	});

	it('runs through the invoke of the tool with no sink', async () => {
		const tool = composeOf([echo]);
		const ctx: ToolContext = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'c1' };
		const raw = await tool.invoke(
			{ uses: ['echo'], code: `return await tools.echo({ text: 'y' });` },
			ctx,
		);
		expect(typeof raw === 'string' ? raw : raw.details).toMatchObject({
			status: 'completed',
			value: 'y',
		});
	});

	it.each([
		['a call that succeeds', later('echo', false), 'completed'],
		['a call that fails', later('broken', true), 'failed'],
	])(
		'keeps the result when %s outlives the code, and names that call in the content',
		async (_name, tool, status) => {
			const ran = await run([tool], {
				uses: [tool.name],
				code: `tools.${tool.name}({}); return 'done';`,
			});
			expect(ran.result).toMatchObject({ status: 'completed', value: 'done' });
			expect(ledgerOf(ran)[0]?.[2]).toBe(status);
			expect(ran.read).toBe(
				`"done"\nCall c1.1 (${ledgerOf(ran)[0]?.[1]}) ${status} after the code returned.`,
			);
		},
	);
});

describe('a failed compose call', () => {
	it('names the call that raised the error, and renders the ledger', async () => {
		const ran = await run([echo, broken], {
			uses: ['echo', 'broken'],
			code: `await tools.echo({ text: 'a' }); await tools.broken({});`,
		});
		expect(ran.result).toEqual({
			status: 'failed',
			error: { message: 'The archive is closed.', call: 'c1.2' },
			calls: [
				{ call: 'c1.1', tool: 'echo', status: 'completed' },
				{ call: 'c1.2', tool: 'broken', status: 'failed' },
			],
		});
		expect(ran.read).toBe(
			[
				'The compose call failed at call c1.2: The archive is closed.',
				'Calls, in the order that the code made them:',
				'- c1.1 echo: completed',
				'  result: "a"',
				'- c1.2 broken: failed',
			].join('\n'),
		);
		expect(ran.steps.at(-1)).toMatchObject({
			type: 'tool_result',
			call: 'c1.2',
			error: 'The archive is closed.',
			parent: 'c1',
		});
	});

	it('shows the result of each completed call, cut to a bound that it names', async () => {
		const ran = await run([echo, broken], {
			uses: ['echo', 'broken'],
			code: `
				await tools.echo({ text: 'a'.repeat(5000) });
				await tools.echo({ text: 'é'.repeat(3000) });
				await tools.broken({});
			`,
		});
		const lines = ran.read.split('\n');
		const first = lines.find((line) =>
			line.startsWith('  result: cut to at most 4096 of 5002 bytes: '),
		);
		expect(first?.length).toBe('  result: cut to at most 4096 of 5002 bytes: '.length + 4096);
		// A character is never split: the second value cuts at a whole 'é' of two bytes.
		const second = lines.find((line) =>
			line.startsWith('  result: cut to at most 4096 of 6002 bytes: '),
		);
		expect(second?.endsWith('é')).toBe(true);
		expect(ran.read).toContain('- c1.3 broken: failed');
	});

	it('holds the results of a failed call to the byte limit of the return value', async () => {
		const ran = await run(
			[echo, broken],
			{
				uses: ['echo', 'broken'],
				code: `
				await tools.echo({ text: 'a'.repeat(3000) });
				await tools.echo({ text: 'b'.repeat(3000) });
				await tools.echo({ text: 'c' });
				await tools.broken({});
			`,
			},
			{ compose: { limits: { bytes: 4000 } } },
		);
		expect(ran.read).toContain('  result: cut to at most 998 of 3002 bytes: ');
		expect(ran.read).toContain('  result: omitted, because the results above fill 4000 bytes.');
	});

	it('shows the results of the calls that finished before a cut and before the time limit', async () => {
		const stuck = held('stuck');
		const ran = await run(
			[echo, stuck.tool],
			{ uses: ['echo', 'stuck'], code: `await tools.echo({ text: 'p1' }); await tools.stuck({});` },
			{ compose: { limits: { time: 30 } } },
		);
		expect(ran.read).toBe(
			[
				'The compose call failed: The compose call passed compose.limits.time (30 ms).',
				'Calls, in the order that the code made them:',
				'- c1.1 echo: completed',
				'  result: "p1"',
				'- c1.2 stuck: pending',
				'A pending call did not settle, and its effect can still happen.',
			].join('\n'),
		);
		stuck.open();
	});

	it('tells the evaluator which tools of the seat the call leaves unbound', async () => {
		const seen: (readonly string[] | undefined)[] = [];
		const evaluator: Evaluator = {
			evaluate: async (input) => {
				seen.push(input.unlisted);
				return undefined;
			},
		};
		await run([echo, table, hidden], { uses: ['echo'], code: '' }, { compose: { evaluator } });
		// The room tools of the seat are in the catalog, and a tool with compose: false is not.
		expect(seen[0]).toContain('table');
		expect(seen[0]).not.toContain('echo');
		expect(seen[0]).not.toContain('hidden');
	});

	it('gives the code the details of a failed call, so it can return a partial value', async () => {
		const ran = await run([echo, broken], {
			uses: ['echo', 'broken'],
			code: `
				const done = [await tools.echo({ text: 'a' })];
				try { await tools.broken({}); } catch (error) { return { done, status: error.details.status }; }
			`,
		});
		expect(ran.result).toMatchObject({ status: 'completed', value: { done: ['a'], status: 3 } });
		expect(ledgerOf(ran).map((call) => call[2])).toEqual(['completed', 'failed']);
	});

	it('fails with no call named when the code throws by itself', async () => {
		const ran = await run([echo], {
			uses: ['echo'],
			code: `throw new Error('The code gave up.');`,
		});
		expect(ran.result).toEqual({
			status: 'failed',
			error: { message: 'The code gave up.' },
			calls: [],
		});
		expect(ran.read).toBe('The compose call failed: The code gave up.\nNo call started.');
	});

	it('leaves its siblings to settle when Promise.all rejects, and lists the outcome of each', async () => {
		let settled = false;
		const slow = defineTool({
			name: 'slow',
			description: 'Settle later.',
			parameters: Type.Object({}),
			execute: async () => {
				await pause(30);
				settled = true;
				return 'slow';
			},
		});
		const ran = await run([slow, broken], {
			uses: ['slow', 'broken'],
			code: `await Promise.all([tools.slow({}), tools.broken({})]);`,
		});
		expect(ran.result.status).toBe('failed');
		expect(settled).toBe(true);
		expect(ledgerOf(ran)).toEqual([
			['c1.1', 'slow', 'completed'],
			['c1.2', 'broken', 'failed'],
		]);
	});

	it('refuses further calls after the first uncaught error, and lets the code catch a refused call', async () => {
		const ran = await run([echo], {
			uses: ['echo'],
			code: `
				const calls = [];
				try { await tools.echo({ text: 3 }); } catch (error) { calls.push(error.message); }
				try { await tools.other({}); } catch (error) { calls.push(error.message); }
				return calls;
			`,
		});
		expect(ran.result.value).toEqual([
			"Invalid arguments for tool 'echo': text must be string.",
			"The compose call binds no tool 'other'.",
		]);
		// A refused call has no id, no ledger entry, and no step.
		expect(ran.result.calls).toEqual([]);
		expect(ran.steps).toEqual([]);
	});

	it.each([
		['a function', `return () => 1;`, 'The returned value is not JSON: it holds a function.'],
		['a bigint', `return 10n;`, 'The returned value is not JSON: it holds a bigint.'],
		['NaN', `return { n: NaN };`, 'The returned value.n is not JSON: it holds the number NaN.'],
		[
			'a cycle',
			`const a = {}; a.a = a; return a;`,
			'The returned value.a is not JSON: it holds a cycle.',
		],
		['a map', `return new Map();`, 'The returned value is not JSON: it holds a Map.'],
		['a hole', `return [undefined];`, 'The returned value[0] is not JSON: it holds undefined.'],
	])('fails and names the problem when the code returns %s', async (_name, code, message) => {
		const ran = await run([echo], { uses: [], code });
		expect(ran.result).toEqual({ status: 'failed', error: { message }, calls: [] });
	});

	it('fails the call that carries a value that JSON cannot hold', async () => {
		const ran = await run([echo], {
			uses: ['echo'],
			code: `try { await tools.echo({ text: 1n }); } catch (error) { return error.message; }`,
		});
		expect(ran.result.value).toBe(
			'The arguments of tools.echo.text is not JSON: it holds a bigint.',
		);
	});
});

describe('the limits of a compose call', () => {
	it.each([
		{
			name: 'calls',
			limits: { calls: 2 },
			code: `for (let i = 0; i < 3; i++) await tools.echo({ text: 'x' });`,
			message: 'The compose call passed compose.limits.calls (2).',
			ledger: ['completed', 'completed'],
		},
		{
			name: 'bytes',
			limits: { bytes: 10 },
			code: `return 'x'.repeat(20);`,
			message: 'The returned value is 22 bytes, over compose.limits.bytes (10). Return less.',
			ledger: [],
		},
		{
			name: 'time',
			limits: { time: 30 },
			code: `await tools.stuck({});`,
			message: 'The compose call passed compose.limits.time (30 ms).',
			ledger: ['pending'],
		},
	])(
		'fails on the limit of $name, names it, and never cuts a value',
		async ({ limits, code, message, ledger }) => {
			const stuck = held('stuck');
			const ran = await run(
				[echo, stuck.tool],
				{ uses: ['echo', 'stuck'], code },
				{ compose: { limits } },
			);
			expect(ran.result.status).toBe('failed');
			expect(ran.result.error).toMatchObject({ message });
			expect(ran.result).not.toHaveProperty('value');
			expect(ran.result.calls.map((call) => call.status)).toEqual(ledger);
			stuck.open();
		},
	);

	it('ends at the deadline of the activation when it comes before the time limit, and runs no code past it', async () => {
		const stuck = held('stuck');
		const near = await run(
			[stuck.tool],
			{ uses: ['stuck'], code: `await tools.stuck({});` },
			{
				ctx: { deadline: Date.now() + 30 },
			},
		);
		expect(near.result.error?.message).toBe(
			'The compose call reached the deadline of the activation.',
		);
		expect(ledgerOf(near)).toEqual([['c1.1', 'stuck', 'pending']]);
		const past = await run(
			[stuck.tool],
			{ uses: ['stuck'], code: `await tools.stuck({});` },
			{
				ctx: { deadline: Date.now() - 1 },
			},
		);
		expect(past.result).toMatchObject({ status: 'failed', calls: [] });
		expect(stuck.seen.calls).toBe(1);
		stuck.open();
	});

	it.each([
		{ limit: 2, count: 6, most: 2 },
		{ limit: undefined, count: 12, most: 8 },
	])(
		'runs at most $most calls together for a cap of $limit, and lists the calls in the order made',
		async ({ limit, count, most }) => {
			const one = gauge('one');
			const ran = await run(
				[one.tool],
				{
					uses: ['one'],
					code: `return (await Promise.all(Array.from({ length: ${count} }, () => tools.one({})))).length;`,
				},
				{ compose: limit === undefined ? {} : { limits: { concurrent: limit } } },
			);
			expect(ran.result.value).toBe(count);
			expect(one.seen.most).toBe(most);
			expect(ran.result.calls.map((call) => call.call)).toEqual(
				Array.from({ length: count }, (_, at) => `c1.${at + 1}`),
			);
			expect(ran.result.calls.every((call) => call.status === 'completed')).toBe(true);
		},
	);

	it('runs the calls of a sequential tool one at a time, beside the calls of other tools', async () => {
		const sequential = gauge('turn', 'sequential');
		const parallel = gauge('side');
		const ran = await run([sequential.tool, parallel.tool], {
			uses: ['turn', 'side'],
			code: `
				await Promise.all([
					tools.turn({}), tools.side({}), tools.turn({}), tools.side({}), tools.turn({}), tools.side({}),
				]);
			`,
		});
		expect(ran.result.status).toBe('completed');
		expect(sequential.seen).toMatchObject({ most: 1, calls: 3 });
		expect(parallel.seen.most).toBeGreaterThan(1);
		expect(ledgerOf(ran).map((call) => call[1])).toEqual([
			'turn',
			'side',
			'turn',
			'side',
			'turn',
			'side',
		]);
	});
});

describe('the cut of a compose call', () => {
	it('cancels the call, starts no queued call, and marks a started call pending', async () => {
		const stuck = held('stuck');
		const controller = new AbortController();
		const running = run(
			[stuck.tool],
			{
				uses: ['stuck'],
				code: `await Promise.all([tools.stuck({}), tools.stuck({}), tools.stuck({})]);`,
			},
			{ compose: { limits: { concurrent: 1 } }, ctx: { signal: controller.signal } },
		);
		await pause(20);
		controller.abort();
		const ran = await running;
		expect(ran.result).toEqual({
			status: 'cancelled',
			error: { message: 'The compose call was cut.' },
			calls: [{ call: 'c1.1', tool: 'stuck', status: 'pending' }],
		});
		expect(ran.read).toContain('The compose call was cancelled: The compose call was cut.');
		expect(ran.read).toContain('A pending call did not settle, and its effect can still happen.');
		stuck.open();
		await pause(10);
		expect(stuck.seen.calls).toBe(1);
	});

	it('runs no code for a call that was cut before it started', async () => {
		const controller = new AbortController();
		controller.abort();
		const never = neverRuns();
		const ran = await run(
			[echo],
			{ uses: [], code: '' },
			{
				compose: { evaluator: never.evaluator },
				ctx: { signal: controller.signal },
			},
		);
		expect(ran.result.status).toBe('cancelled');
		expect(never.evaluated()).toBe(0);
	});
});

describe('the checks before the code runs', () => {
	it('refuses a name that the catalog lacks, with no ledger, no approval, and no code', async () => {
		const never = neverRuns();
		let asked = 0;
		const ran = await run(
			[echo, hidden],
			{ uses: ['echo', 'hidden', 'compose', 'nothing'], code: '' },
			{
				compose: {
					evaluator: never.evaluator,
					approve: () => {
						asked += 1;
						return 'allow';
					},
				},
			},
		);
		expect(ran.result).toEqual({
			status: 'failed',
			error: { message: "The catalog holds no tool named 'hidden', 'compose', 'nothing'." },
			calls: [],
		});
		expect([never.evaluated(), asked, ran.steps]).toEqual([0, 0, []]);
	});

	it('refuses arguments that break the schema of compose', async () => {
		await expect(run([echo], { uses: 'echo', code: 1 } as never)).rejects.toThrow(
			"Invalid arguments for tool 'compose': uses must be array; code must be string.",
		);
	});

	it('asks the approval with the uses, the code, and a context with no sink, then records the answer', async () => {
		const asked: unknown[] = [];
		const ran = await run(
			[echo],
			{ uses: ['echo', 'echo'], code: `return 1;` },
			{
				compose: {
					approve: async (request, ctx): Promise<'allow'> => {
						asked.push({ request, ctx });
						return 'allow';
					},
				},
			},
		);
		expect(ran.result.value).toBe(1);
		expect(asked).toEqual([
			{
				request: { uses: ['echo'], code: 'return 1;' },
				ctx: expect.objectContaining({ callId: 'c1', room: 'lab', agent: expect.any(Object) }),
			},
		]);
		expect(asked[0]).toHaveProperty('ctx.callId');
		const ctx = (asked[0] as { ctx: object }).ctx;
		expect(Object.values(ctx).filter((value) => typeof value === 'function')).toEqual([]);
		expect(ran.steps).toEqual([{ type: 'approval', call: 'c1', answer: 'allow' }]);
	});

	it.each([
		['a denial', (): 'deny' => 'deny', 'The approval refused this compose call. No code ran.'],
		[
			'a hook that throws',
			(): 'allow' => {
				throw new Error('The policy is down.');
			},
			'The approval failed: The policy is down.',
		],
	])('refuses the call on %s, with no ledger and no effect', async (_name, approve, message) => {
		const never = neverRuns();
		const ran = await run(
			[echo],
			{ uses: ['echo'], code: `await tools.echo({ text: 'x' });` },
			{
				compose: { evaluator: never.evaluator, approve },
			},
		);
		expect(ran.result).toEqual({ status: 'failed', error: { message }, calls: [] });
		expect(never.evaluated()).toBe(0);
		expect(ran.steps).toEqual([{ type: 'approval', call: 'c1', answer: 'deny' }]);
	});
});

describe('the declared output of a tool', () => {
	const liar = defineTool({
		name: 'liar',
		description: 'Declares an integer and gives text.',
		parameters: Type.Object({}),
		compose: { output: Type.Object({ n: Type.Integer() }) },
		execute: () => ({ content: text('x'), details: { n: 'x' } as never }),
	});

	it('rejects the binding with the tool, the call, and the failing paths, and marks the call completed', async () => {
		const caught = await run([liar], {
			uses: ['liar'],
			code: `try { await tools.liar({}); } catch (error) { return error.message; }`,
		});
		expect(caught.result.value).toBe(
			"The details of call c1.1 of tool 'liar' break its declared output: n must be integer. The call completed, and its effect stands.",
		);
		expect(ledgerOf(caught)).toEqual([['c1.1', 'liar', 'completed']]);
		const uncaught = await run([liar], { uses: ['liar'], code: `await tools.liar({});` });
		expect(uncaught.result.status).toBe('failed');
		expect(uncaught.result.error?.call).toBe('c1.1');
		expect(uncaught.read).toContain('- c1.1 liar: completed');
	});
});

describe('the compose tool of an executor', () => {
	it('describes itself with its uses, the limits of the seat, and the catalog', () => {
		const tool = composeOf([echo, table, hidden], { limits: { calls: 32, time: 90_000 } });
		expect(tool.description).toBe(
			[
				'Run JavaScript in one call. It joins your tools: code calls them as tools.<name>. Code with no tools also calculates and transforms data. You read only the value that the code returns.',
				'',
				'Limits of this seat: at most 32 nested calls, 8 at a time. The return value holds at most 65536 bytes of JSON. The call lasts at most 90 seconds, and the end of your activation cuts it sooner.',
				'A binding rejects with an Error when its tool fails. error.details holds the details of the tool when it gives them. A rejection cancels no other call.',
				'A compose call cannot start a compose call. Image parts of a result do not reach the code.',
				'',
				'declare const tools: {',
				'  /** Return the text. */',
				'  echo(args: { text: string }): Promise<string>;',
				'  /** Give a count of rows. */',
				'  table(args: { count: number }): Promise<{ rows: { id: number; label: string }[] }>;',
				'  /** Speak on the record. Omit `to` to address the room; set `to` to address a participant directly. Put the URI of anything the message cites in `refs`. To come back to your work later, call `schedule`. */',
				'  say(args: {',
				'    /** A participant name from the roster. */',
				'    to?: string;',
				'    /** What you say, as the record shows it. */',
				'    text: string;',
				'    refs?: string[];',
				'  }): Promise<string>;',
				'  /** Schedule a message to yourself. After `delaySeconds` seconds, the room wakes you with this text, for the person of the current exchange. Use it to check a long process or to continue your work later. The result names the seq of the message; `dismiss` drops it. */',
				'  schedule(args: {',
				'    /** Seconds until the room wakes you with this message. */',
				'    delaySeconds: number;',
				'    /** What to do when the room wakes you. */',
				'    text: string;',
				'    refs?: string[];',
				'  }): Promise<string>;',
				'  /** Read messages of this room by seq, as #12, or by URI, ambion://room/<room>/message/<seq>: a message that your context leaves out or that a summary folds, or one that a say cites. The result gives one line for each ref. */',
				'  recall(args: { refs: string[] }): Promise<string>;',
				'  /** Seat one agent from the reserve. It joins the room and reads the record. */',
				'  seat(args: {',
				'    /** An agent name from the reserve. */',
				'    name: string;',
				'  }): Promise<string>;',
				"  /** Remove one seated agent from the room. A fixed seat, such as the summary writer's, stays. */",
				'  unseat(args: {',
				'    /** A seated agent name. */',
				'    name: string;',
				'  }): Promise<string>;',
				'  /** Drop a message you scheduled, by its seq. The room does not wake you with it. */',
				'  dismiss(args: {',
				'    /** The seq of the scheduled message, as the record shows it: 41 for #41. */',
				'    message: number;',
				'  }): Promise<string>;',
				'};',
			].join('\n'),
		);
	});

	/** The catalog of one tool, without the room tools that every catalog lists after it. */
	const catalogOf = (tool: AmbionTool) => {
		const text = composeOf([tool]).description.split('\n\n').slice(2).join('\n\n');
		return `${text.slice(0, text.indexOf('  /** Speak on the record.'))}};`;
	};

	it.each<[string, TSchema, string]>([
		[
			'an optional property',
			Type.Object({ a: Type.String(), b: Type.Optional(Type.Number()) }),
			'{ a: string; b?: number }',
		],
		['an empty object', Type.Object({}), '{}'],
		[
			'a nested array of unions',
			Type.Array(Type.Union([Type.String(), Type.Integer()])),
			'(string | number)[]',
		],
		[
			'literals',
			Type.Union([Type.Literal('open'), Type.Literal(2), Type.Literal(true), Type.Null()]),
			'"open" | 2 | true | null',
		],
		['an enum', Type.Enum(['a', 'b']), '"a" | "b"'],
		['a record', Type.Record(Type.String(), Type.Boolean()), 'Record<string, boolean>'],
		['a property that needs quotes', Type.Object({ 'a-b': Type.String() }), '{ "a-b": string }'],
		['an unknown value', Type.Unknown(), 'unknown'],
		['a tuple', Type.Tuple([Type.String()]), 'unknown[]'],
		[
			'an intersection',
			Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]),
			'unknown',
		],
		['a union with an unknown member', Type.Union([Type.String(), Type.Unknown()]), 'unknown'],
	])('renders %s as TypeScript', (_name, schema, expected) => {
		const declared = defineTool({
			name: 'shape',
			description: 'Give a shape.',
			parameters: Type.Object({ value: schema }),
			compose: { output: schema },
			execute: () => ({ content: [], details: null }),
		});
		expect(catalogOf(declared)).toContain(
			`shape(args: { value: ${expected} }): Promise<${expected}>;`,
		);
	});

	it('writes a many-line description as a doc comment, and keeps a comment end out of it', () => {
		const tool = defineTool({
			name: 'note-pad',
			description: 'First line.\n\nSecond line */ ends.',
			parameters: Type.Object({}),
			execute: () => '',
		});
		expect(catalogOf(tool)).toBe(
			[
				'declare const tools: {',
				'  /**',
				'   * First line.',
				'   *',
				'   * Second line *\\/ ends.',
				'   */',
				'  "note-pad"(args: {}): Promise<string>;',
				'};',
			].join('\n'),
		);
	});

	it('writes the description of a field as a doc comment, nested in the block of its tool', () => {
		const tool = defineTool({
			name: 'find',
			description: 'Find rows.',
			parameters: Type.Object({
				query: Type.String({ description: 'The search text.' }),
				page: Type.Optional(Type.Number()),
				filter: Type.Object({ tag: Type.String({ description: 'A tag */ name.' }) }),
			}),
			compose: {
				output: Type.Object({
					rows: Type.Array(Type.Object({ n: Type.Number({ description: 'Row count.' }) })),
				}),
			},
			execute: () => ({ content: [], details: { rows: [] } }),
		});
		expect(catalogOf(tool)).toBe(
			[
				'declare const tools: {',
				'  /** Find rows. */',
				'  find(args: {',
				'    /** The search text. */',
				'    query: string;',
				'    page?: number;',
				'    filter: {',
				'      /** A tag *\\/ name. */',
				'      tag: string;',
				'    };',
				'  }): Promise<{',
				'    rows: {',
				'      /** Row count. */',
				'      n: number;',
				'    }[];',
				'  }>;',
				'};',
			].join('\n'),
		);
	});

	it('renders a schema with an $id once, as a type before the tools', () => {
		const Point = Type.Object(
			{ x: Type.Number({ description: 'East.' }), y: Type.Number() },
			{ $id: 'Point', description: 'A place.' },
		);
		const tool = defineTool({
			name: 'move',
			description: 'Move.',
			parameters: Type.Object({ to: Point }),
			compose: { output: Type.Object({ path: Type.Array(Point), at: Point }) },
			execute: () => ({ content: [], details: { path: [], at: { x: 0, y: 0 } } }),
		});
		expect(catalogOf(tool)).toBe(
			[
				'/** A place. */',
				'type Point = {',
				'  /** East. */',
				'  x: number;',
				'  y: number;',
				'};',
				'declare const tools: {',
				'  /** Move. */',
				'  move(args: { to: Point }): Promise<{ path: Point[]; at: Point }>;',
				'};',
			].join('\n'),
		);
	});

	it('renders a second, different schema with a taken $id inline', () => {
		const tool = defineTool({
			name: 'clash',
			description: 'Clash.',
			parameters: Type.Object({
				a: Type.Object({ x: Type.String() }, { $id: 'Box' }),
				b: Type.Object({ y: Type.String() }, { $id: 'Box' }),
			}),
			execute: () => '',
		});
		expect(catalogOf(tool)).toContain(
			'clash(args: { a: Box; b: { y: string } }): Promise<string>;',
		);
		expect(catalogOf(tool)).toContain('type Box = { x: string };');
	});

	it('renders a schema whose $id is no identifier inline', () => {
		const tool = defineTool({
			name: 'urn',
			description: 'Urn.',
			parameters: Type.Object({ a: Type.Object({ x: Type.String() }, { $id: 'urn:x' }) }),
			execute: () => '',
		});
		expect(catalogOf(tool)).toBe(
			[
				'declare const tools: {',
				'  /** Urn. */',
				'  urn(args: { a: { x: string } }): Promise<string>;',
				'};',
			].join('\n'),
		);
	});

	it('lists the room tools after its own tools, and no compose tool', () => {
		const names = (tool: AmbionTool) =>
			[...tool.description.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
		expect(names(composeOf([echo, hidden]))).toEqual([
			'echo',
			'say',
			'schedule',
			'recall',
			'seat',
			'unseat',
			'dismiss',
		]);
	});
});

describe('a compose call in a room', () => {
	it('gives the model the returned value and the late calls alone, and logs the nested calls with their parent', async () => {
		const seat = defineAgent({
			name: 'worker',
			identity: 'Works with tables.',
			executor: describeExecutor({
				kind: 'scripted',
				instructions: 'Compose.',
				tools: [table, total, later('later', false)],
				compose: { evaluator: functionEvaluator },
			}),
		});
		const logged: Step[] = [];
		const read: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-room'),
				agents: [seat],
				runtime: createRuntime({ logger: (traced) => void logged.push(traced.step) }),
				execution: scripted((step, _seat, request) => {
					if (request === 1)
						return callTool('compose', {
							uses: ['table', 'total'],
							code: `const { rows } = await tools.table({ count: 300 });
								return await tools.total({ ids: rows.map((row) => row.id) });`,
						});
					if (request === 2)
						return callTool('compose', {
							uses: ['later'],
							code: `tools.later({}); return 'sent';`,
						});
					read.push(...step.results.map((result) => result.text));
					return request === 3
						? say(step.results.map((result) => result.text).join(' | '))
						: quiet();
				}),
			}),
		);
		const events = collect(room);
		await (await room.visit(andrei)).send({ text: 'Total the rows.' });
		await settled(room);
		// The model reads the value, and the late call by its content. It never reads a row.
		expect(read[0]).toBe('{"sum":44850}');
		expect(read[1]).toMatch(/^"sent"\nCall \S+ \(later\) completed after the code returned\.$/);
		expect(read.join('')).not.toContain('row 299');
		const nested = logged.filter((step) => 'parent' in step);
		expect(nested.map((step) => step.type)).toEqual([
			'tool_call',
			'tool_result',
			'tool_call',
			'tool_result',
			'tool_call',
			'tool_result',
		]);
		const parents = logged.filter((step) => step.type === 'tool_call' && step.name === 'compose');
		expect(parents).toHaveLength(2);
		expect(nested[0]).toMatchObject({
			parent: parents[0] && 'call' in parents[0] ? parents[0].call : '',
		});
		// The core raises a tool event for each nested call beside the compose call.
		expect(
			events
				.filter((event) => event.type === 'tool_call')
				.map((event) => 'name' in event && event.name),
		).toEqual(['compose', 'table', 'total', 'compose', 'later']);
	});
});

/** A seat that composes over `tools` and the room tools. Its script runs on the scripted executor. */
function composer(name: string, tools: readonly AmbionTool[] = []) {
	return defineAgent({
		name,
		identity: `${name}.`,
		executor: describeExecutor({
			kind: 'scripted',
			instructions: 'Compose.',
			tools,
			compose: { evaluator: functionEvaluator },
		}),
	});
}

const quietAgent = (name: string) =>
	defineAgent({
		name,
		identity: `${name}.`,
		executor: describeExecutor({ kind: 'scripted', instructions: 'Wait.' }),
	});

describe('a compose call over the room tools', () => {
	it('says to each of three participants one after another, in the order of the code', async () => {
		const read: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-say'),
				agents: [composer('worker'), quietAgent('ana'), quietAgent('ben')],
				seats: { worker: 'broadcast', ana: 'named', ben: 'named' },
				execution: scripted((step, seat, request) => {
					if (seat !== 'worker') return quiet();
					if (request === 1)
						return callTool('compose', {
							uses: ['say'],
							code: `return await Promise.all(
								['ana', 'ben', 'andrei'].map((to) => tools.say({ to, text: 'Hello ' + to })),
							);`,
						});
					read.push(...step.results.map((result) => result.text));
					return quiet();
				}),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Greet everyone.' });
		await settled(room);
		const said = (await messagesOf(room)).filter(
			(message) => message.kind === 'said' && message.from === 'worker',
		);
		expect(said.map((message) => (message.kind === 'said' ? message.to : ''))).toEqual([
			'ana',
			'ben',
			'andrei',
		]);
		const seqs = said.map((message) => message.seq);
		expect(JSON.parse(read[0] ?? '[]')).toEqual([
			`said #${seqs[0]} to ana`,
			`said #${seqs[1]} to ben`,
			`said #${seqs[2]} to andrei`,
		]);
	});

	it('rejects a say that the room refuses as missed, shows the missed lines in the result, and counts them read', async () => {
		const gate = held('gate');
		const read: string[] = [];
		let passes = 0;
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-missed'),
				agents: [composer('worker', [gate.tool])],
				seats: { worker: 'broadcast' },
				execution: scripted((step, _seat, request) => {
					passes += 1;
					if (request === 1)
						return callTool('compose', {
							uses: ['gate', 'say'],
							code: `await tools.gate({});
								try {
									await tools.say({ text: 'Done.' });
									return 'said';
								} catch (error) {
									return 'refused: ' + error.message.slice(0, 40);
								}`,
						});
					read.push(...step.results.map((result) => result.text));
					return quiet();
				}),
			}),
		);
		const visit = await room.visit(andrei);
		await visit.send({ text: 'Start.' });
		while (gate.seen.calls === 0) await pause(2);
		await visit.send({ text: 'Wait, check Q3 first.' });
		gate.open();
		await settled(room);
		const result = read[0] ?? '';
		expect(result).toContain('"refused: Not delivered');
		expect(result).toContain('Room tools reported:');
		expect(result).toMatch(/Call \S+\.2 \(say\): Not delivered/);
		expect(result).toContain('Wait, check Q3 first.');
		// The compose result holds the lines, so the activation reads them once: no pass repeats them.
		expect(read).toHaveLength(1);
		expect(passes).toBe(2);
		const lines = (await messagesOf(room)).filter((message) => message.kind === 'said');
		expect(lines.some((message) => message.from === 'worker')).toBe(false);
	});

	it('returns the error of a failed compose call to the script, keeps its say, and makes no retry', async () => {
		const read: string[] = [];
		let requests = 0;
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-error'),
				agents: [composer('worker')],
				seats: { worker: 'broadcast' },
				execution: scripted((step, _seat, request) => {
					requests = request;
					if (request === 1)
						return callTool('compose', {
							uses: ['say'],
							code: `await tools.say({ text: 'Done.' }); throw new Error('stop');`,
						});
					read.push(...step.results.map((result) => result.text));
					return quiet();
				}),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Say it, then fail.' });
		await settled(room);
		const said = (await messagesOf(room)).filter(
			(message) => message.kind === 'said' && message.from === 'worker',
		);
		expect(said).toHaveLength(1);
		expect(read[0]).toMatch(/say: completed/);
		expect(read[0]).toContain('The compose call failed: stop');
		// The error reaches the script as a result, so the activation does not fail and the room retries nothing.
		expect(requests).toBe(2);
	});

	it('seats two agents and recalls a message in one compose call', async () => {
		const read: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-seat'),
				agents: [composer('worker'), quietAgent('ana'), quietAgent('ben')],
				seats: { worker: 'broadcast' },
				execution: scripted((step, seat, request) => {
					if (seat !== 'worker') return quiet();
					if (request === 1)
						return callTool('compose', {
							uses: ['seat', 'recall'],
							code: `const seated = await Promise.all([
									tools.seat({ name: 'ana' }),
									tools.seat({ name: 'ben' }),
								]);
								return { seated, first: await tools.recall({ refs: ['#4'] }) };`,
						});
					read.push(...step.results.map((result) => result.text));
					return quiet();
				}),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Bring in ana and ben.' });
		await settled(room);
		const value = JSON.parse((read[0] ?? '').split('\n')[0] ?? '{}');
		expect(value.seated).toEqual([
			expect.stringMatching(/^seated ana \(#\d+\)$/),
			expect.stringMatching(/^seated ben \(#\d+\)$/),
		]);
		expect(value.first).toMatch(/^#4 /);
		const names = (await participantsOf(room)).map((one) => one.name);
		expect(names).toEqual(expect.arrayContaining(['ana', 'ben']));
	});

	it('says to an agent that it seated in the same compose call', async () => {
		const read: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-seat-say'),
				agents: [composer('worker'), quietAgent('ana')],
				seats: { worker: 'broadcast' },
				execution: scripted((step, seat, request) => {
					if (seat !== 'worker') return quiet();
					if (request === 1)
						return callTool('compose', {
							uses: ['seat', 'say'],
							code: `await tools.seat({ name: 'ana' });
								return await tools.say({ to: 'ana', text: 'Welcome.' });`,
						});
					read.push(...step.results.map((result) => result.text));
					return quiet();
				}),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Bring in ana.' });
		await settled(room);
		expect(JSON.parse(read[0] ?? '')).toMatch(/^said #\d+ to ana$/);
		expect(read[0]).not.toContain('Room tools reported');
		const said = (await messagesOf(room)).filter(
			(message) => message.kind === 'said' && message.from === 'worker',
		);
		expect(said).toHaveLength(1);
	});

	it('records the steps of a nested room tool under the compose call, and shows the names to the approval', async () => {
		const logged: Step[] = [];
		const requests: unknown[] = [];
		const seat = defineAgent({
			name: 'worker',
			identity: 'worker.',
			executor: describeExecutor({
				kind: 'scripted',
				instructions: 'Compose.',
				compose: {
					evaluator: functionEvaluator,
					approve: (request) => {
						requests.push(request);
						return 'allow';
					},
				},
			}),
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName('compose-trace'),
				agents: [seat],
				runtime: createRuntime({ logger: (traced) => void logged.push(traced.step) }),
				execution: scripted((_step, _seat, request) =>
					request === 1
						? callTool('compose', {
								uses: ['recall'],
								code: `return await tools.recall({ refs: ['#4'] });`,
							})
						: quiet(),
				),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Recall.' });
		await settled(room);
		expect(requests).toEqual([{ uses: ['recall'], code: expect.any(String) }]);
		const parent = logged.find((step) => step.type === 'tool_call' && step.name === 'compose');
		const nested = logged.filter((step) => 'parent' in step);
		expect(nested.map((step) => step.type)).toEqual(['tool_call', 'tool_result']);
		const owner = parent !== undefined && 'call' in parent ? parent.call : undefined;
		expect(nested.map((step) => ('parent' in step ? step.parent : undefined))).toEqual([
			owner,
			owner,
		]);
	});

	it('shows the result of a room tool once in a failed call, under the room notes', async () => {
		const room: RoomCall = {
			name: 'say',
			run: async () => ({ content: text('said #9 to ana. Missed: #8 ben'), carriesRecord: true }),
		};
		const tool = composeOf([echo]);
		const ctx: ToolContext = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'c1' };
		const error = await invokeTool(
			tool,
			{
				uses: ['echo', 'say'],
				code: `await tools.echo({ text: 'a' }); await tools.say({ text: 'Hi.' }); throw new Error('stop');`,
			},
			ctx,
			() => {},
			[room],
		).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(ComposeFailure);
		const message = (error as ComposeFailure).message;
		expect(message).toContain('- c1.1 echo: completed\n  result: "a"\n- c1.2 say: completed');
		expect(message).toContain(
			'Room tools reported:\nCall c1.2 (say): said #9 to ana. Missed: #8 ben',
		);
		// The room tool shows no result line: its text appears once, under the notes.
		expect(message.split('said #9 to ana').length).toBe(2);
	});

	it('refuses a room tool in a direct invoke, at call time, with no code run', async () => {
		const { evaluator, evaluated } = neverRuns();
		const ran = await run([echo], { uses: ['say'], code: `return 1;` }, { compose: { evaluator } });
		expect(ran.read).toContain("The room tools 'say' need an activation");
		expect(ran.result).toMatchObject({ status: 'failed', calls: [] });
		expect(evaluated()).toBe(0);
		const clean = await run([echo], {
			uses: ['echo'],
			code: `return await tools.echo({ text: 'x' });`,
		});
		expect(clean.result.status).toBe('completed');
	});
});
