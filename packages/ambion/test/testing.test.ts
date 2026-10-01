/**
 * The `/testing` entry: the scripted executor, the wait, and the clock,
 * proved through a room and through the executor contract. Nothing here
 * imports Pi or a model library; `package.test.ts` holds the entry to that rule.
 */
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { ActivationState } from '../src/execution/activation.ts';
import type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	Pass,
	PassInput,
	PassResult,
} from '../src/execution/executor.ts';
import { PermanentError } from '../src/execution/failure.ts';
import { createRuntime, defineAgent, defineTool, startRoom } from '../src/index.ts';
import type { ActivationView, CommitRequest, CommitResult } from '../src/protocol.ts';
import {
	byAgent,
	callTool,
	fakeClock,
	isClosing,
	later,
	quiet,
	type Script,
	say,
	scripted,
	scriptedExecutor,
	settled,
} from '../src/testing.ts';
import type { ActivationEvent, AgentExecutor, Step } from '../src/types.ts';
import { andrei, collect, roomName } from './support/room.ts';
import { stopAtEnd } from './support/stop.ts';

const echo = defineTool({
	name: 'echo',
	description: 'Returns its input.',
	parameters: Type.Object({}),
	execute: () => 'echoed',
});

const agent = (name: string, tools: AgentExecutor['tools'] = []) =>
	defineAgent({
		name,
		identity: `The ${name} seat.`,
		executor: { kind: 'scripted', instructions: 'answer what is asked', tools },
	});

const open = async (options: Parameters<typeof startRoom>[0]) =>
	stopAtEnd(await startRoom(options));

describe('scripted', () => {
	it('routes on the seat, counts steps per seat, runs a tool, and reads the result of a spoken reply', async () => {
		const seen: string[] = [];
		const results: string[][] = [];
		const record =
			(label: string, then: Script = () => quiet()): Script =>
			(step, seat, call) => {
				seen.push(`${label}:${seat}:${call}`);
				results.push(step.results.map((result) => result.text));
				return then(step, seat, call);
			};
		const room = await open({
			name: roomName('testing-route'),
			agents: [agent('a', [echo]), agent('b')],
			runtime: createRuntime(),
			execution: scripted(
				byAgent({
					a: record('a', (_step, _seat, call) =>
						call === 1 ? callTool('echo') : call === 2 ? say('an answer') : quiet(),
					),
					b: record('b'),
				}),
			),
		});
		const events = collect(room);
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await settled(room);
		expect(seen).toContain('a:a:1');
		expect(seen).toContain('b:b:1');
		expect(seen.every((line) => line.split(':')[0] === line.split(':')[1])).toBe(true);
		const tools = events.filter(
			(event) => event.type === 'tool_call' || event.type === 'tool_result',
		);
		expect(tools.map((event) => event.type)).toEqual(['tool_call', 'tool_result']);
		const { messages } = await room.read();
		expect(messages.filter((m) => m.kind === 'said' && m.from === 'a')).toHaveLength(1);
		expect(results).toContainEqual(['echoed', 'delivered']);
	});

	it('turns a script that throws into a transient error and writes no message', async () => {
		const clock = fakeClock();
		const room = await open({
			name: roomName('testing-throws'),
			agents: [agent('a')],
			runtime: createRuntime({ clock, limits: { activation: { attempts: 1, backoff: () => 0 } } }),
			execution: scripted(() => {
				throw new Error('script failed');
			}),
		});
		const events = collect(room);
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));
		expect(events.find((event) => event.type === 'error')).toMatchObject({
			seat: 'a',
			cause: 'transient',
		});
		const { messages } = await room.read();
		expect(messages.filter((m) => m.kind === 'said' && m.from === 'a')).toEqual([]);
	});
});

describe('isClosing', () => {
	it('is false for an ordinary activation and true for the summary activation', async () => {
		const flags: boolean[] = [];
		const room = await open({
			name: roomName('testing-closing'),
			agents: [agent('product'), agent('writer')],
			summary: 'writer',
			seats: { product: 'broadcast', writer: 'none' },
			runtime: createRuntime(),
			execution: scripted((step, seat, call) => {
				flags.push(isClosing(step.view));
				return call === 1 ? say(seat === 'writer' ? 'the summary' : 'an answer') : quiet();
			}),
		});
		await (await room.visit(andrei)).send({ text: 'Question?' });
		await settled(room);
		expect(flags.filter((flag) => flag).length).toBeGreaterThan(0);
		expect(flags.at(-1)).toBe(true);
		const read = await room.read();
		expect(read.exchanges[0]).toMatchObject({ summary: { kind: 'published' } });
	});
});

describe('settled', () => {
	it('resolves through the read and subscribe of a room alone', async () => {
		const room = await open({
			name: roomName('testing-settled'),
			agents: [agent('a')],
			runtime: createRuntime(),
			execution: scripted((_step, _seat, call) => (call === 1 ? say('an answer') : quiet())),
		});
		let reads = 0;
		await (await room.visit(andrei)).send({ text: 'Question?' });
		const read = await settled({
			name: room.name,
			read: (options) => {
				reads += 1;
				return room.read(options);
			},
			subscribe: room.subscribe.bind(room),
		});
		expect(read.exchange).toBeUndefined();
		expect(read.participants.every((p) => p.kind !== 'agent' || p.status === 'idle')).toBe(true);
		expect(reads).toBeGreaterThan(0);
		// A notification and the first read both find the room settled: it resolves once.
		await expect(
			settled({
				name: room.name,
				read: (options) => room.read(options),
				subscribe: (listener) => {
					listener();
					return () => {};
				},
			}),
		).resolves.toMatchObject({ exchange: undefined });
	});

	it('rejects with the seat named while a backoff runs, and resolves after the clock moves', async () => {
		const clock = fakeClock();
		let failed = false;
		const room = await open({
			name: roomName('testing-backoff'),
			agents: [agent('a')],
			runtime: createRuntime({
				clock,
				limits: { activation: { attempts: 2, backoff: () => 30_000 } },
			}),
			execution: scripted(() => {
				if (failed) return quiet();
				failed = true;
				throw new Error('once');
			}),
		});
		await (await room.visit(andrei)).send({ text: 'Question?' });
		await expect(settled(room, { timeout: 50 })).rejects.toThrow(
			/did not settle within 50 ms: active .*; exchange \d+\./,
		);
		await clock.advance(30_000);
		await expect(settled(room)).resolves.toMatchObject({ exchange: undefined });
	});
});

describe('fakeClock', () => {
	it('fires alarms in time order inside one advance, chained ones included', async () => {
		const clock = fakeClock(1_000);
		const fired: string[] = [];
		clock.alarm(1_300, () => fired.push('c'));
		clock.alarm(1_100, () => {
			fired.push('a');
			clock.alarm(clock.now(), () => fired.push('a-again'));
		});
		clock.alarm(1_200, () => fired.push('b'));
		await clock.advance(500);
		expect(fired).toEqual(['a', 'a-again', 'b', 'c']);
		expect(clock.now()).toBe(1_500);
	});
});

/** The executor contract, driven with no room and no driver. */
describe('scriptedExecutor', () => {
	const view = (through: number, purpose: ActivationView['spec']['purpose']): ActivationView => ({
		spec: { id: 'act-1', seat: 'a', attempt: 1, purpose },
		through,
		context: { name: 'r', now: 0, participants: [], messages: [], reserve: [] },
	});
	const respond = view(3, { kind: 'respond', message: 3 });

	/** The core state of one activation over `executor`, and a room that answers each commit with `commit`. */
	function harness(commit: (request: CommitRequest) => CommitResult) {
		const commits: CommitRequest[] = [];
		const events: ActivationEvent[] = [];
		const open = (executor: Executor) =>
			new ActivationState(executor, {
				id: 'act-1',
				room: {
					view: async () => ({ stale: 'unused' }),
					commit: async (request) => {
						commits.push(request);
						return commit(request);
					},
				},
				definition: agent('a'),
				emit: (event) => events.push(event),
				trace: { record() {} },
			});
		return { open, commits, events };
	}

	const said = (seq: number): CommitResult => ({
		committed: { kind: 'said', seq, from: 'a', text: 'hi', at: new Date(0).toISOString() } as never,
	});
	const input = (v: ActivationView): PassInput => ({ kind: 'view', view: v });

	it('commits a say and a schedule against the position it read and advances readThrough', async () => {
		const { open, commits } = harness(() => said(3 + commits.length));
		const session = open(
			scriptedExecutor(
				(_step, _seat, call) =>
					call === 1 ? say('hi') : call === 2 ? later('Check the build.', 600) : quiet(),
				agent('a'),
			),
		);
		await expect(session.pass(input(respond))).resolves.toEqual({ failed: false });
		expect(commits).toHaveLength(2);
		expect(commits[0]).toMatchObject({ readThrough: 3, intent: { kind: 'said', text: 'hi' } });
		expect(commits[1]).toMatchObject({
			readThrough: 4,
			intent: { kind: 'said', to: 'a', text: 'Check the build.', after: 600 },
		});
		expect(session.readThrough).toBe(5);
		expect(session.shouldRefresh(5)).toBe(false);
		expect(session.shouldRefresh(6)).toBe(true);
	});

	it('takes the messages a refused say missed as read, and lets the script say again', async () => {
		let first = true;
		const { open, commits } = harness(() => {
			if (!first) return said(9);
			first = false;
			return { missed: [{ kind: 'said', seq: 8 } as never] };
		});
		const seen: string[] = [];
		const session = open(
			scriptedExecutor((step) => {
				seen.push(step.results.map((result) => result.text).join(','));
				return step.results.some((r) => r.text === 'delivered') ? quiet() : say('again');
			}, agent('a')),
		);
		await session.pass(input(respond));
		expect(commits.map((c) => c.key)).toHaveLength(2);
		expect(new Set(commits.map((c) => c.key)).size).toBe(2);
		expect(seen).toEqual(['', 'missed', 'missed,delivered']);
		expect(session.readThrough).toBe(9);
	});

	it('stops when the room answers stale, and never asks again', async () => {
		const { open, commits } = harness(() => ({ stale: 'lease ended' }));
		const session = open(scriptedExecutor(() => say('hi'), agent('a')));
		await session.pass(input(respond));
		expect(commits).toHaveLength(1);
		expect(session.cancelled).toBe(true);
		expect(session.shouldRefresh(99)).toBe(false);
	});

	it('fails a pass that calls a room tool the purpose does not grant', async () => {
		const closing = view(5, {
			kind: 'summarize',
			exchange: 1,
			person: 'andrei',
			people: ['andrei'],
			through: 5,
		});
		const { open, commits } = harness(() => said(6));
		const session = open(scriptedExecutor(() => later('Again.', 60), agent('a')));
		await expect(session.pass(input(closing))).resolves.toMatchObject({
			failed: true,
			cause: 'transient',
			message: "The seat has no tool 'schedule'.",
		});
		expect(commits).toEqual([]);
	});

	it('commits a closing say without readThrough and ends the pass', async () => {
		const closing = view(5, {
			kind: 'summarize',
			exchange: 1,
			person: 'andrei',
			people: ['andrei'],
			through: 5,
		});
		const { open, commits } = harness(() => said(6));
		const session = open(scriptedExecutor(() => say('summary'), agent('a')));
		await session.pass(input(closing));
		expect(commits).toHaveLength(1);
		expect(commits[0]).not.toHaveProperty('readThrough');
	});

	it('reports a script that throws as a transient failure and emits the error', async () => {
		const { open, events } = harness(() => said(4));
		const session = open(
			scriptedExecutor(() => {
				throw new Error('broke');
			}, agent('a')),
		);
		await expect(session.pass(input(respond))).resolves.toEqual({
			failed: true,
			cause: 'transient',
			message: 'broke',
			error: new Error('broke'),
		});
		expect(events).toEqual([expect.objectContaining({ type: 'error', cause: 'transient' })]);
	});

	/**
	 * The core state of one activation over an executor whose sessions run
	 * `pass`. The pass gets the state and the activation. The session
	 * takes a steer, has none, throws on it, or reads the line and then
	 * throws. `steered` holds the position of each line it took.
	 */
	function around(
		pass: (
			one: Pass,
			handle: { readonly state: ActivationState; readonly activation: ExecutorActivation },
		) => Promise<PassResult>,
		tools: AgentExecutor['tools'] = [],
		steering: 'takes' | 'none' | 'throws' | 'readsThenThrows' = 'takes',
	) {
		const opened: ExecutorActivation[] = [];
		const passes: Pass[] = [];
		const steered: number[] = [];
		const steps: Step[] = [];
		const events: ActivationEvent[] = [];
		const state: ActivationState = new ActivationState(
			(activation) => {
				opened.push(activation);
				const session: ExecutorSession = {
					pass: (one) => {
						passes.push(one);
						return pass(one, { state, activation });
					},
				};
				if (steering === 'none') return session;
				return {
					...session,
					steer: (after, seq) => {
						if (passes.length === 0) throw new Error('The core steered before the pass.');
						steered.push(seq);
						if (steering === 'readsThenThrows') activation.read({ after, through: seq });
						if (steering !== 'takes') throw new Error('The executor cannot take the line.');
					},
				};
			},
			{
				id: 'act-1',
				room: { view: async () => ({ stale: 'unused' }), commit: async () => said(4) },
				definition: agent('a', tools),
				emit: (event) => events.push(event),
				trace: { record: (step) => void steps.push(step) },
			},
		);
		const activation = opened[0];
		if (activation === undefined) throw new Error('The state opened no session.');
		return { state, activation, passes, steered, steps, events };
	}

	it.each([
		['an error', new Error('lost'), new Error('lost'), 'transient'],
		['a value that is no error', 'gone', new Error('gone'), 'transient'],
		[
			'a permanent error',
			new PermanentError('no model'),
			new PermanentError('no model'),
			'permanent',
		],
		[
			'a permanent error of another copy of the package',
			Object.assign(new Error('no model'), { name: 'PermanentError' }),
			Object.assign(new Error('no model'), { name: 'PermanentError' }),
			'permanent',
		],
	] as const)(
		'reports a pass that throws %s as one failure',
		async (_name, thrown, error, cause) => {
			const { state, events } = around(async () => {
				throw thrown;
			});
			await expect(state.pass(input(respond))).resolves.toEqual({
				failed: true,
				cause,
				message: error.message,
				error,
			});
			expect(events).toEqual([{ type: 'error', seat: 'a', activation: 'act-1', error, cause }]);
		},
	);

	it('refuses a view of another seat, and runs no pass', async () => {
		const { state, passes, events, steps } = around(async () => ({ failed: false }));
		state.steer(3, 4, 'early');
		const other = { ...respond, spec: { ...respond.spec, seat: 'b' } };
		await expect(state.pass(input(other))).resolves.toMatchObject({
			failed: true,
			cause: 'transient',
			message: "Activation names another seat: 'b'.",
		});
		expect(passes).toEqual([]);
		expect(events).toHaveLength(1);
		expect(steps).toEqual([steer(4, false)]);
	});

	it('runs no pass and takes no steer once cut, and the session sees the cut', async () => {
		const { state, activation, passes, steered, steps } = around(async () => ({ failed: false }));
		state.steer(3, 4, 'first');
		state.cancel();
		state.steer(4, 5, 'second');
		await expect(state.pass(input(respond))).resolves.toEqual({ failed: false });
		expect(activation.signal.aborted).toBe(true);
		expect(passes).toEqual([]);
		expect(steered).toEqual([]);
		// The line that landed before the cut waits for the next delta.
		expect(steps).toEqual([steer(4, false)]);
	});

	type Handle = Parameters<Parameters<typeof around>[0]>[1];
	const steer = (seq: number, consumed: boolean): Step => ({ type: 'steer', seq, consumed });

	/**
	 * The core records the steer step of every line. `seen` holds the steps
	 * that stand while the pass runs, and `steps` the steps after the pass.
	 * The view of the pass reads through 3.
	 */
	it.each([
		{
			name: 'a line before the first pass that the first view holds',
			early: [[2, 3]],
			seen: [steer(3, true)],
			steps: [steer(3, true)],
			forwarded: [],
		},
		{
			name: 'a line before the first pass that the executor reads',
			early: [[3, 4]],
			during: ({ activation }: Handle) => activation.read({ after: 3, through: 4 }),
			seen: [steer(4, true)],
			steps: [steer(4, true)],
			forwarded: [4],
		},
		{
			name: 'a line before the first pass that the executor never reads',
			early: [[3, 4]],
			seen: [],
			steps: [steer(4, false)],
			forwarded: [4],
		},
		{
			name: 'a line before the first pass when the executor has no steer',
			steering: 'none',
			early: [[3, 4]],
			seen: [steer(4, false)],
			steps: [steer(4, false)],
			forwarded: [],
		},
		{
			name: 'a line before the first pass when the pass throws before it starts',
			early: [[3, 4]],
			startThrows: true,
			seen: [],
			steps: [steer(4, false)],
			forwarded: [],
			failed: true,
		},
		{
			name: 'a line after a pass',
			late: [[3, 4]],
			seen: [],
			steps: [steer(4, false)],
			forwarded: [],
		},
		{
			name: 'a line that the view of the pass in flight holds',
			during: ({ state }: Handle) => state.steer(2, 3, 'in view'),
			seen: [steer(3, true)],
			steps: [steer(3, true)],
			forwarded: [],
		},
		{
			name: 'a line in flight when the executor has no steer',
			steering: 'none',
			during: ({ state }: Handle) => state.steer(3, 4, 'no steer'),
			seen: [steer(4, false)],
			steps: [steer(4, false)],
			forwarded: [],
		},
		{
			name: 'a line in flight that the executor reads',
			during: ({ state, activation }: Handle) => {
				state.steer(3, 4, 'read');
				activation.read({ after: 3, through: 4 });
			},
			seen: [steer(4, true)],
			steps: [steer(4, true)],
			forwarded: [4],
		},
		{
			name: 'a line in flight that the executor reads under another range',
			during: ({ state, activation }: Handle) => {
				state.steer(3, 4, 'wrong range');
				activation.read({ after: 0, through: 4 });
			},
			seen: [],
			steps: [steer(4, false)],
			forwarded: [4],
		},
		{
			name: 'two lines in flight that the executor never reads',
			during: ({ state }: Handle) => {
				state.steer(3, 6, 'second');
				state.steer(3, 5, 'first');
			},
			seen: [],
			steps: [steer(5, false), steer(6, false)],
			forwarded: [6, 5],
		},
		{
			name: 'a line in flight when the executor throws on the steer',
			steering: 'throws',
			during: ({ state }: Handle) => state.steer(3, 4, 'refused'),
			seen: [steer(4, false)],
			steps: [steer(4, false)],
			forwarded: [4],
		},
		{
			name: 'a line in flight when the executor reads it and then throws',
			steering: 'readsThenThrows',
			during: ({ state }: Handle) => state.steer(3, 4, 'read, then refused'),
			seen: [steer(4, true)],
			steps: [steer(4, true)],
			forwarded: [4],
		},
		{
			name: 'a line in flight when the pass throws',
			during: ({ state }: Handle) => {
				state.steer(3, 4, 'lost');
				throw new Error('lost');
			},
			seen: [],
			steps: [steer(4, false)],
			forwarded: [4],
			failed: true,
		},
	] satisfies {
		name: string;
		steering?: 'takes' | 'none' | 'throws' | 'readsThenThrows';
		startThrows?: boolean;
		early?: [number, number][];
		late?: [number, number][];
		during?: (handle: Handle) => void;
		seen: Step[];
		steps: Step[];
		forwarded: number[];
		failed?: boolean;
	}[])('records the steer step of $name', async (one) => {
		let seen: Step[] = [];
		const { state, steered, steps } = around(
			(_pass, handle) => {
				if (one.startThrows) throw new Error('The pass broke before its first await.');
				return (async () => {
					// A harness takes a tick to start, and the core places the early lines in it.
					await Promise.resolve();
					try {
						one.during?.(handle);
					} finally {
						seen = [...steps];
					}
					return { failed: false };
				})();
			},
			[],
			one.steering,
		);
		for (const [after, seq] of one.early ?? []) state.steer(after, seq, `line ${seq}`);
		const result = await state.pass(input(respond));
		for (const [after, seq] of one.late ?? []) state.steer(after, seq, `line ${seq}`);
		expect(result.failed).toBe(one.failed === true);
		expect(seen).toEqual(one.seen);
		expect(steps).toEqual(one.steps);
		expect(steered).toEqual(one.forwarded);
	});

	it('raises the tool events from the steps, and hands an agent tool the view of its pass', async () => {
		const { state, activation, events } = around(
			async (pass) => {
				activation.trace.record({ type: 'tool_call', call: 'c1', name: 'echo', input: {} });
				const tool = pass.tools.find((one) => one.name === 'echo');
				const call = activation.callId('echo');
				const result = await tool?.run({}, call);
				activation.trace.record({ type: 'tool_result', call, output: 'echoed' });
				expect(call).toBe('c1');
				expect(result).toEqual({ content: [{ type: 'text', text: 'echoed' }] });
				return { failed: false };
			},
			[echo],
		);
		await expect(state.pass(input(respond))).resolves.toEqual({ failed: false });
		expect(events).toEqual([
			{ type: 'tool_call', seat: 'a', activation: 'act-1', name: 'echo' },
			{ type: 'tool_result', seat: 'a', activation: 'act-1', name: 'echo' },
		]);
	});
});
