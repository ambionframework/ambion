/**
 * The tools of an agent. The core knows ordinary tool composition: a
 * definition flattens its bundles, captures every value, and refuses a bad
 * name or a malformed tool. A package may provide a bundle with tools and
 * guidance; the core does not know what the bundle reaches. A running tool
 * reads its agent, the room, the activation, and the open exchange.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { fromPiTool, type PiOptions, pi, piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	startRoom,
	type ToolBundle,
	type ToolContext,
} from '../src/index.ts';
import { refusal } from './support/errors.ts';
import {
	assistant,
	collect,
	enter,
	messagesOf,
	roomName,
	scriptedAgent,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import { byAgent, callTool, quiet, type Script, scripted, speak } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { memory } from './support/storage.ts';

function tool(name: string, execute: (ctx: ToolContext) => string = () => 'done') {
	return defineTool({
		name,
		description: `Runs ${name}.`,
		parameters: Type.Object({}),
		execute: async (_params, ctx) => execute(ctx),
	});
}

const worker = (options: Partial<PiOptions>) => scriptedAgent('worker', 'Worker.', options);

describe('the definition of agent tools', () => {
	it.each(['reader\n', 'reader\r\n', 12, undefined])(
		'rejects participant names that are not exact lowercase identifiers: %j',
		(name) => {
			const agent = {
				name,
				identity: 'An agent.',
				instructions: 'Read.',
				model: 'scripted/reader',
			};
			const human = { name, identity: 'A person.' };
			expect(() => Reflect.apply(defineAgent, undefined, [agent])).toThrow(
				/Invalid participant name/,
			);
			expect(() => Reflect.apply(defineAgent, undefined, [agent])).toThrow(refusal('invalid_name'));
			expect(() => Reflect.apply(defineHuman, undefined, [human])).toThrow(
				/Invalid participant name/,
			);
		},
	);

	it.each(['lookup_order', 'read', 'flag'])(
		'accepts an ordinary tool named %s without a workspace bundle',
		(name) => {
			expect(() => worker({ tools: [tool(name)] })).not.toThrow();
		},
	);

	it.each([
		['say', { tools: [tool('say')] }, /room supplies it for an activation/],
		['seat', { tools: [tool('seat')] }, /room supplies it for an activation/],
		['unseat', { tools: [tool('unseat')] }, /room supplies it for an activation/],
		[
			'a duplicate after a bundle',
			{ tools: [tool('read')], bundles: [{ tools: [tool('read')] }] },
			/duplicate tools named 'read'/,
		],
	])('refuses a tool named %s', (_name, options: Partial<PiOptions>, message) => {
		expect(() => worker(options)).toThrow(message);
		expect(() => worker(options)).toThrow(refusal('invalid_tool'));
	});

	it('captures caller-owned tool arrays, records, and schemas', () => {
		const parameters = Type.Object({ query: Type.String() });
		const supplied = {
			...defineTool({
				name: 'inspect',
				description: 'Inspects one thing.',
				parameters,
				execute: () => 'first',
			}),
		};
		const tools = [supplied];
		const agent = worker({ tools });

		tools.length = 0;
		supplied.name = 'changed';
		supplied.description = 'Changed after capture.';
		(parameters.properties as Record<string, unknown>).query = Type.Number();

		const captured = agent.executor.tools[0];
		expect(agent.executor.tools).toHaveLength(1);
		expect(captured).toMatchObject({ name: 'inspect', description: 'Inspects one thing.' });
		expect(captured).not.toBe(supplied);
		expect(captured?.parameters).not.toBe(parameters);
		expect(captured?.parameters).toMatchObject({ properties: { query: { type: 'string' } } });
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(agent.executor.tools)).toBe(true);
	});

	it('flattens and captures bundle tools and guidance at definition time', () => {
		const bundle = { tools: [tool('inspect')], guidance: 'Use inspect for this domain.' };
		const bundles = [bundle];
		const agent = worker({ bundles });

		bundles.push({ tools: [tool('later')], guidance: 'Later guidance.' });
		bundle.tools.length = 0;
		bundle.guidance = 'Changed guidance.';
		expect(agent.executor.tools.map((captured) => captured.name)).toEqual(['inspect']);
		expect(agent.executor.guidance).toBe('Use inspect for this domain.');
	});

	it('preserves schema inference while composing heterogeneous tools', () => {
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
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a name.',
			parameters: Type.Object({ name: Type.String() }),
			execute: ({ name }, context) => {
				expectTypeOf(name).toEqualTypeOf<string>();
				expectTypeOf(context.callId).toEqualTypeOf<string>();
				expectTypeOf(context.activation).toEqualTypeOf<string | undefined>();
				expectTypeOf(context.exchange?.from).toEqualTypeOf<number | undefined>();
				expectTypeOf(context.exchange?.owner).toEqualTypeOf<string | undefined>();
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
		expect(worker({ bundles: [bundle] }).executor.tools.map((each) => each.name)).toEqual([
			'lookup',
			'count',
		]);
		expect(worker({ tools: [lookup, fromPiTool(native)] }).executor.tools).toHaveLength(2);

		// These calls are checked by tsc but deliberately never executed.
		const authorPi = { instructions: 'Work.', model: 'scripted/worker' };
		const rejectedInputs = () => {
			// @ts-expect-error A native Pi tool needs an explicit adapter.
			pi({ ...authorPi, tools: [native] });
			// @ts-expect-error A bundle belongs in bundles, not tools.
			pi({ ...authorPi, tools: [bundle] });
			// @ts-expect-error Malformed tool values are not accepted.
			pi({ ...authorPi, tools: [{ name: 'missing-execute' }] });
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
		(input) => {
			expect(() =>
				Reflect.apply(pi, undefined, [
					{ instructions: 'Work.', model: 'scripted/w', tools: [input] },
				]),
			).toThrow();
		},
	);

	it.each([
		{ name: 'bad', description: 'Bad.', parameters: Type.Object({}), execute: 12 },
		{ name: 'bad', description: 'Bad.', parameters: null, execute: () => 'bad' },
	])('rejects malformed authoring options immediately: %j', (options) => {
		expect(() => Reflect.apply(defineTool, undefined, [options])).toThrow();
	});

	it('rejects malformed structural tools before a room writes its journal', async () => {
		const opened = await memory.open();
		const name = roomName('invalid-structural-tool');
		const executor = {
			kind: 'pi',
			instructions: 'Work.',
			model: 'scripted/w',
			tools: [{ name: 'bad' }],
		};
		await expect(
			Reflect.apply(startRoom, undefined, [
				{
					name,
					runtime: createRuntime({ storage: opened.storage }),
					agents: [{ name: 'worker', identity: 'Worker.', executor }],
				},
			]),
		).rejects.toThrow();
		expect(await storedOf(opened.journals, name)).toEqual([]);
		await opened.dispose();
	});
});

/** One room where `worker` has a probe tool; resolves when the room settles. */
async function probeRoom(attention: 'broadcast' | 'presence', script: Script, ask: boolean) {
	const seen: ToolContext[] = [];
	const frozen: boolean[] = [];
	const probe = tool('probe', (ctx) => {
		seen.push(ctx);
		frozen.push(Object.isFrozen(ctx));
		return 'probed';
	});
	const bundle: ToolBundle = {
		tools: [tool('inspect')],
		guidance: 'Backend guidance: inspect records before writing.',
	};
	const room = stopAtEnd(
		await startRoom({
			name: roomName('ordinary-tools'),
			summary: assistant.name,
			seats: { worker: attention, [assistant.name]: 'none' },
			agents: [worker({ tools: [probe], bundles: [bundle] }), assistant],
			execution: piExecution({ sessions: 'memory', stream: scripted(byAgent({ worker: script })) }),
		}),
	);
	const events = collect(room);
	const visit = await enter(room);
	if (ask) await visit.send({ text: 'go' });
	await waitForRoom(room);
	return { room, seen, frozen, events };
}

describe('a running tool', () => {
	it('reads the agent, the call signal, the room, the activation, the open exchange, and the bundle guidance', async () => {
		const prompts: string[] = [];
		const { room, seen, frozen, events } = await probeRoom(
			'broadcast',
			(context, _who, call) => {
				prompts.push(context.systemPrompt ?? '');
				if (call <= 2) return callTool('probe', {});
				return call === 3 ? speak('done') : quiet();
			},
			true,
		);
		const messages = await messagesOf(room);
		const question = messages.find((message) => message.kind === 'said' && message.text === 'go');
		const said = messages.find((message) => message.kind === 'said' && message.from === 'worker');
		const activation = said?.kind === 'said' ? said.activationId : undefined;
		expect(activation).toBeDefined();
		expect(seen).toHaveLength(2);
		for (const ctx of seen) {
			expect(ctx).toMatchObject({
				room: room.name,
				activation,
				exchange: { owner: 'andrei', from: question?.seq },
				agent: { name: 'worker', identity: 'Worker.' },
			});
			expect(ctx.signal).toBeInstanceOf(AbortSignal);
		}
		const starts = events.filter(
			(event) => event.type === 'activation_start' && event.agent === 'worker',
		);
		expect(starts.map((event) => 'activation' in event && event.activation)).toEqual([activation]);
		expect(frozen).toEqual([true, true]);
		expect(prompts[0]).toContain('Backend guidance: inspect records before writing.');
	});

	it('passes no exchange to a tool called in an activation that no question opened', async () => {
		const { room, seen } = await probeRoom(
			'presence',
			(_context, _who, call) => (call === 1 ? callTool('probe', {}) : quiet()),
			false,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.room).toBe(room.name);
		expect(typeof seen[0]?.activation).toBe('string');
		expect(seen[0] !== undefined && 'exchange' in seen[0]).toBe(false);
	});
});
