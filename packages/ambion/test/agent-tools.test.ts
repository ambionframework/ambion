/**
 * The tools of an agent. The core knows ordinary tool composition: a
 * definition flattens its bundles, captures every value, and refuses a bad
 * name or a malformed tool. A package may provide a bundle with tools and
 * guidance; the core does not know what the bundle reaches. A running tool
 * reads its agent, the room, the activation, and the open exchange.
 */
import { Type } from 'typebox';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	fromPiTool,
	type NativePiTool,
	type PiOptions,
	pi,
	piExecution,
} from '../../pi/src/index.ts';
import { COMPOSE_PROCESS_GUIDANCE } from '../src/compose.ts';
import { describeExecutor } from '../src/hosting.ts';
import {
	type AmbionTool,
	COMPOSE_GUIDANCE,
	type ComposeOptions,
	composeMacro,
	createRuntime,
	defineAgent,
	definePerson,
	defineTool,
	type ReminderSeat,
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
import {
	byAgent,
	callTool,
	type PiScript,
	quiet,
	say,
	scriptedStream,
} from './support/scripted.ts';
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
			expect(() => Reflect.apply(definePerson, undefined, [human])).toThrow(
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
		['schedule', { tools: [tool('schedule')] }, /room supplies it for an activation/],
		['recall', { tools: [tool('recall')] }, /room supplies it for an activation/],
		['seat', { tools: [tool('seat')] }, /room supplies it for an activation/],
		['unseat', { tools: [tool('unseat')] }, /room supplies it for an activation/],
		['dismiss', { tools: [tool('dismiss')] }, /room supplies it for an activation/],
		['compose', { tools: [tool('compose')] }, /the compose option reserves the name/],
		['describe', { tools: [tool('describe')] }, /the compose option reserves the name/],
		[
			'compose in a bundle',
			{ bundles: [{ tools: [tool('compose')] }] },
			/A tool of the agent bundle is named 'compose'/,
		],
		[
			'describe in a bundle',
			{ bundles: [{ tools: [tool('describe')] }] },
			/A tool of the agent bundle is named 'describe'/,
		],
		[
			'a duplicate after a bundle',
			{ tools: [tool('read')], bundles: [{ tools: [tool('read')] }] },
			/duplicate tools named 'read'/,
		],
	])('refuses a tool named %s', (_name, options: Partial<PiOptions>, message) => {
		expect(() => worker(options)).toThrow(message);
		expect(() => worker(options)).toThrow(refusal('invalid_tool'));
	});

	it.each([
		['true', true],
		['an empty object', {}],
		['an output that is not a schema', { output: 'x' }],
		['a string', 'yes'],
		['an output that is an array', { output: [] }],
	])('refuses a compose value of %s on a tool and on its options', (_name, compose) => {
		const options = {
			name: 'bad',
			description: 'Bad.',
			parameters: Type.Object({}),
			compose,
			execute: () => 'bad',
		};
		expect(() => Reflect.apply(defineTool, undefined, [options])).toThrow(
			'Tool compose must be false or an object with an output schema.',
		);
		const built = { ...tool('built'), compose };
		expect(() => worker({ tools: [built as never] })).toThrow(
			'Tool compose must be false or an object with an output schema.',
		);
	});

	it('keeps the compose field of a tool, and captures the output schema', () => {
		const output = Type.Object({ count: Type.Number() });
		const declared = defineTool({
			name: 'counted',
			description: 'Counts.',
			parameters: Type.Object({}),
			compose: { output },
			execute: () => ({ content: [], details: { count: 1 } }),
		});
		const hidden = defineTool({
			name: 'hidden',
			description: 'Stays out of compose.',
			parameters: Type.Object({}),
			compose: false,
			execute: () => 'hidden',
		});
		const [kept, left, plain] = worker({ tools: [declared, hidden, tool('plain')] }).executor.tools;
		(output.properties as Record<string, unknown>).count = Type.String();

		expect(declared.compose).toEqual({ output: expect.objectContaining({ type: 'object' }) });
		expect(kept?.compose).toEqual({
			output: expect.objectContaining({
				properties: { count: expect.objectContaining({ type: 'number' }) },
			}),
		});
		expect(kept?.compose).not.toBe(declared.compose);
		expect(Object.isFrozen(kept?.compose)).toBe(true);
		expect(left?.compose).toBe(false);
		expect(plain).not.toHaveProperty('compose');
	});

	const ok = { evaluate: async () => undefined };

	it.each([
		['the value false', false],
		['an option with no runtime', {}],
		['a runtime with no evaluate', { runtime: {} }],
		['an approve that is not a function', { runtime: ok, approve: 'yes' }],
		['guidance that is not a string', { runtime: ok, guidance: 1 }],
		['limits that are not an object', { runtime: ok, limits: 3 }],
		['limits that are an array', { runtime: ok, limits: [] }],
		['a limit of zero', { runtime: ok, limits: { calls: 0 } }],
		['a limit of a fraction', { runtime: ok, limits: { time: 1.5 } }],
		['a limit that has no name', { runtime: ok, limits: { speed: 2 } }],
	])('refuses a compose option with %s', (_name, compose) => {
		expect(() => worker({ compose: compose as never })).toThrow(/Agent compose/);
	});

	it('appends the compose and describe tools after the tools and the bundles, and keeps the option off the frozen executor', () => {
		const compose: ComposeOptions = {
			runtime: { evaluate: async () => undefined },
			approve: () => 'allow',
			limits: { calls: 8 },
		};
		const hidden = defineTool({
			name: 'hidden',
			description: 'Stays out.',
			parameters: Type.Object({}),
			compose: false,
			execute: () => 'x',
		});
		const bundle = { tools: [tool('inspect')], guidance: 'Use inspect.' };
		const agent = worker({ tools: [tool('lookup'), hidden], bundles: [bundle], compose });
		expect(agent.executor).not.toHaveProperty('compose');
		expect(agent.executor.tools.map((one) => one.name)).toEqual([
			'lookup',
			'hidden',
			'inspect',
			'compose',
			'describe',
		]);
		const description = agent.executor.tools.at(-2)?.description ?? '';
		expect(description).toContain('Every tool that code can bind returns text.');
		expect(description).not.toContain('->');
		expect(description).not.toContain('hidden');
		expect(description).not.toContain('compose ->');
		expect(description).not.toContain('describe ->');
		// The guidance of the bundles comes first, and the guidance of compose follows it.
		expect(agent.executor.guidance).toBe(`Use inspect.\n\n${COMPOSE_GUIDANCE}`);
		expect(worker({ compose }).executor.guidance).toBe(COMPOSE_GUIDANCE);
		// The process lines belong to a seat that holds bash, and to no other.
		expect(COMPOSE_GUIDANCE).not.toMatch(/\bbash\b|\bwait\b|handle/);
		expect(worker({ tools: [tool('bash')], compose }).executor.guidance).toBe(
			`${COMPOSE_GUIDANCE}\n\n${COMPOSE_PROCESS_GUIDANCE}`,
		);
		expect(worker({ compose: { ...compose, guidance: 'Compose often.' } }).executor.guidance).toBe(
			'Compose often.',
		);
		expect(worker({ compose: { ...compose, guidance: '  ' } }).executor).not.toHaveProperty(
			'guidance',
		);
		expect(worker({ tools: [tool('lookup')] }).executor.tools.map((one) => one.name)).toEqual([
			'lookup',
			'compose',
			'describe',
		]);
	});

	it('adds no compose tool, no guidance, and no macro check to a bare describeExecutor with no compose option', () => {
		const macro = composeMacro({
			name: 'bundle/orphan',
			description: 'Calls a tool that the catalog lacks.',
			uses: ['missing'],
			code: 'return 1;',
			args: { type: 'object', properties: {} },
			hash: 'orphan',
		});
		const executor = describeExecutor({
			kind: 'scripted',
			instructions: 'Work.',
			tools: [tool('lookup')],
			bundles: [{ tools: [], macros: [macro] }],
		});
		expect(executor.tools.map((one) => one.name)).toEqual(['lookup']);
		expect(executor).not.toHaveProperty('guidance');
	});

	it('refuses a second compose tool in a definition, and treats a hand-built compose tool as an ordinary one', () => {
		const withCompose = worker({ compose: { runtime: { evaluate: async () => undefined } } });
		const duplicate = {
			...withCompose.executor,
			tools: [...withCompose.executor.tools, tool('compose')],
		};
		expect(() => defineAgent({ name: 'twin', identity: 'Twin.', executor: duplicate })).toThrow(
			"brings duplicate tools named 'compose'",
		);
		// With no option, the executor has no compose tool, and a tool that a hand builds binds nothing.
		const own = { kind: 'scripted', instructions: 'Work.', tools: [tool('compose')] };
		expect(() => defineAgent({ name: 'own', identity: 'Own.', executor: own })).not.toThrow();
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
		expect(agent.executor.tools.map((one) => one.name)).toEqual(['inspect', 'compose', 'describe']);
		expect(captured).toMatchObject({ name: 'inspect', description: 'Inspects one thing.' });
		expect(captured).not.toBe(supplied);
		expect(captured?.parameters).not.toBe(parameters);
		expect(captured?.parameters).toMatchObject({ properties: { query: { type: 'string' } } });
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(agent.executor.tools)).toBe(true);
	});

	it('flattens and captures bundle tools, guidance, and reminders at definition time', () => {
		const remind = () => 'Remember.';
		const bundle = { tools: [tool('inspect')], guidance: 'Use inspect for this domain.', remind };
		const bundles: ToolBundle[] = [bundle];
		const agent = worker({ bundles });
		expect(agent.executor.reminders).toEqual([remind]);
		expect(() => worker({ bundles: [{ tools: [], remind: 'late' as never }] })).toThrow(
			'A bundle remind must be a function.',
		);

		bundles.push({ tools: [tool('later')], guidance: 'Later guidance.' });
		bundle.tools.length = 0;
		bundle.guidance = 'Changed guidance.';
		expect(agent.executor.tools.map((captured) => captured.name)).toEqual([
			'inspect',
			'compose',
			'describe',
		]);
		expect(agent.executor.guidance).toBe(`Use inspect for this domain.\n\n${COMPOSE_GUIDANCE}`);
	});

	it('preserves schema inference while composing heterogeneous tools', () => {
		const parameters = Type.Object({ count: Type.Number() });
		const native: NativePiTool<typeof parameters, { count: number }> = {
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
				expectTypeOf(context.exchange?.person).toEqualTypeOf<string | undefined>();
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
			'compose',
			'describe',
		]);
		expect(worker({ tools: [lookup, fromPiTool(native)] }).executor.tools).toHaveLength(4);

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
				execute: () => ({ content: [], details: undefined }),
			});
		};
		expectTypeOf(rejectedInputs).returns.toBeVoid();
	});

	it('ties the details of a declared tool to its output schema', () => {
		const Order = Type.Object({
			id: Type.String(),
			status: Type.Union([Type.Literal('open'), Type.Literal('delayed'), Type.Literal('shipped')]),
			eta: Type.Optional(Type.String()),
		});
		const parameters = Type.Object({ id: Type.String() });
		const text = (value: string) => [{ type: 'text' as const, text: value }];

		// These calls are checked by tsc but deliberately never executed.
		const declarations = () => {
			const matching = defineTool({
				name: 'find_order',
				description: 'Fetch an order by id, as data.',
				parameters,
				compose: { output: Order },
				execute: ({ id }) => ({ content: text(id), details: { id, status: 'open' } }),
			});
			expectTypeOf(matching).toEqualTypeOf<AmbionTool>();
			defineTool({
				name: 'async_order',
				description: 'Fetch an order by id, as data, later.',
				parameters,
				compose: { output: Order },
				execute: async ({ id }) => ({
					content: text(id),
					details: { id, status: 'delayed', eta: 'soon' },
				}),
			});
			defineTool({
				name: 'string_order',
				description: 'Returns a string.',
				parameters,
				compose: { output: Order },
				// @ts-expect-error A declared tool returns a tool result, not a string.
				execute: () => 'open',
			});
			defineTool({
				name: 'wrong_literal',
				description: 'Returns a wrong literal.',
				parameters,
				compose: { output: Order },
				// @ts-expect-error The status is not one of the literals.
				execute: ({ id }) => ({ content: text(id), details: { id, status: 'lost' } }),
			});
			defineTool({
				name: 'missing_field',
				description: 'Returns no status.',
				parameters,
				compose: { output: Order },
				// @ts-expect-error The status is missing.
				execute: ({ id }) => ({ content: text(id), details: { id } }),
			});
			defineTool({
				name: 'undeclared',
				description: 'Returns a string.',
				parameters,
				execute: () => 'open',
			});
			defineTool({
				name: 'hidden',
				description: 'Stays out of compose.',
				parameters,
				compose: false,
				execute: () => 'open',
			});
		};
		expectTypeOf(declarations).returns.toBeVoid();
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

	it.each([
		[{}, 'must have required properties name'],
		[{ name: 'crate', where: { limit: 0 } }, 'where.limit must be >= 1'],
		[{ name: 3, where: {} }, 'name must be string; where must have required properties limit'],
	])('refuses the arguments %j, and names each rule that they break', (params, rules) => {
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a name.',
			parameters: Type.Object({
				name: Type.String(),
				where: Type.Optional(Type.Object({ limit: Type.Number({ minimum: 1 }) })),
			}),
			execute: ({ name }) => name,
		});
		const context = { agent: { name: 'worker', identity: 'Worker.' }, callId: 'call-1' };
		expect(() => lookup.invoke(params, context)).toThrow(
			`Invalid arguments for tool 'lookup': ${rules}.`,
		);
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
async function probeRoom(attention: 'broadcast' | 'presence', script: PiScript, ask: boolean) {
	const seen: ToolContext[] = [];
	const frozen: boolean[] = [];
	const probe = tool('probe', (ctx) => {
		seen.push(ctx);
		frozen.push(Object.isFrozen(ctx));
		return 'probed';
	});
	const reminded: ReminderSeat[] = [];
	const bundle: ToolBundle = {
		tools: [tool('inspect')],
		guidance: 'Backend guidance: inspect records before writing.',
		remind: (seat) => {
			reminded.push(seat);
			return 'Reminder: the probe is warm.';
		},
	};
	const room = stopAtEnd(
		await startRoom({
			name: roomName('ordinary-tools'),
			summaryWriter: assistant.name,
			seats: { worker: attention, [assistant.name]: 'none' },
			agents: [worker({ tools: [probe], bundles: [bundle] }), assistant],
			execution: piExecution({
				sessions: 'memory',
				stream: scriptedStream(byAgent({ worker: script })),
			}),
		}),
	);
	const events = collect(room);
	const visit = await enter(room);
	if (ask) await visit.send({ text: 'go' });
	await waitForRoom(room);
	return { room, seen, frozen, events, reminded };
}

describe('a running tool', () => {
	it('reads the agent, the call signal, the room, the activation, the open exchange, the deadline, the bundle guidance, and the bundle reminder', async () => {
		const before = Date.now();
		const prompts: string[] = [];
		const reads: string[] = [];
		const { room, seen, frozen, events, reminded } = await probeRoom(
			'broadcast',
			(context, _who, request) => {
				prompts.push(context.systemPrompt ?? '');
				reads.push(JSON.stringify(context.messages));
				if (request <= 2) return callTool('probe', {});
				return request === 3 ? say('done') : quiet();
			},
			true,
		);
		const messages = await messagesOf(room);
		const question = messages.find((message) => message.kind === 'said' && message.text === 'go');
		const said = messages.find((message) => message.kind === 'said' && message.from === 'worker');
		const activation = said?.kind === 'said' ? said.activation : undefined;
		expect(activation).toBeDefined();
		expect(seen).toHaveLength(2);
		for (const ctx of seen) {
			expect(ctx).toMatchObject({
				room: room.name,
				activation,
				exchange: { person: 'andrei', from: question?.seq },
				agent: { name: 'worker', identity: 'Worker.' },
			});
			expect(ctx.signal).toBeInstanceOf(AbortSignal);
			// The room ends the activation 600 s after its first claim, the default lease deadline.
			expect(ctx.deadline).toBeGreaterThan(before + 590_000);
			expect(ctx.deadline).toBeLessThanOrEqual(Date.now() + 600_000);
		}
		const starts = events.filter(
			(event) => event.type === 'activation_start' && event.seat === 'worker',
		);
		expect(starts.map((event) => 'activation' in event && event.activation)).toEqual([activation]);
		expect(frozen).toEqual([true, true]);
		expect(prompts[0]).toContain('Backend guidance: inspect records before writing.');
		expect(reads[0]).toContain('Reminder: the probe is warm.');
		expect(reminded).toContainEqual({ agent: 'worker', room: room.name, activation });
	});

	it('passes no exchange to a tool called in an activation that no question opened', async () => {
		const { room, seen } = await probeRoom(
			'presence',
			(_context, _who, request) => (request === 1 ? callTool('probe', {}) : quiet()),
			false,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.room).toBe(room.name);
		expect(typeof seen[0]?.activation).toBe('string');
		expect(seen[0] !== undefined && 'exchange' in seen[0]).toBe(false);
	});
});
