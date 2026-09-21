/**
 * The `/testing` entry: the scripted executor, the wait, and the clock,
 * proved through a room and through the executor contract. Nothing here
 * imports Pi or a model library.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorActivation, PassInput } from '../src/execution/executor.ts';
import { createRuntime, defineAgent, defineTool, type Room, startRoom } from '../src/index.ts';
import type { ActivationView, CommitRequest, CommitResult } from '../src/protocol.ts';
import {
	byAgent,
	callTool,
	fakeClock,
	isClosing,
	quiet,
	type Script,
	scripted,
	scriptedExecutor,
	settled,
	speak,
} from '../src/testing.ts';
import type { AgentExecutor, ExecutionEvent } from '../src/types.ts';
import { andrei, collect, roomName } from './support/room.ts';

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

const started: Room[] = [];
afterEach(async () => {
	for (const room of started.splice(0)) await room.stop();
});

const open = async (options: Parameters<typeof startRoom>[0]) => {
	const room = await startRoom(options);
	started.push(room);
	return room;
};

describe('scripted', () => {
	it('routes on the seat and counts steps per seat', async () => {
		const seen: string[] = [];
		const record = (label: string): Script => {
			return (_step, seat, call) => {
				seen.push(`${label}:${seat}:${call}`);
				return quiet();
			};
		};
		const room = await open({
			name: roomName('testing-route'),
			agents: [agent('a'), agent('b')],
			runtime: createRuntime(),
			execution: scripted(byAgent({ a: record('a'), b: record('b') })),
		});
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await settled(room);
		expect(seen).toContain('a:a:1');
		expect(seen).toContain('b:b:1');
		expect(seen.every((line) => line.split(':')[0] === line.split(':')[1])).toBe(true);
	});

	it('puts a spoken turn on the record, then reads its result on the next step', async () => {
		const results: string[][] = [];
		const room = await open({
			name: roomName('testing-speak'),
			agents: [agent('a')],
			runtime: createRuntime(),
			execution: scripted((step, _seat, call) => {
				results.push(step.results.map((result) => result.text));
				return call === 1 ? speak('an answer') : quiet();
			}),
		});
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await settled(room);
		const { messages } = await room.read();
		expect(messages.filter((m) => m.kind === 'said' && m.from === 'a')).toHaveLength(1);
		expect(results).toContainEqual(['delivered']);
	});

	it('runs a tool of the agent and emits its events', async () => {
		const room = await open({
			name: roomName('testing-tool'),
			agents: [agent('a', [echo])],
			runtime: createRuntime(),
			execution: scripted((_step, _seat, call) => (call === 1 ? callTool('echo') : quiet())),
		});
		const events = collect(room);
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await settled(room);
		const tools = events.filter(
			(event) => event.type === 'tool_execution_start' || event.type === 'tool_execution_end',
		);
		expect(tools.map((event) => event.type)).toEqual([
			'tool_execution_start',
			'tool_execution_end',
		]);
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
			agent: 'a',
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
				return call === 1 ? speak(seat === 'writer' ? 'the summary' : 'an answer') : quiet();
			}),
		});
		await (await room.visit(andrei)).send({ text: 'Question?' });
		await settled(room);
		expect(flags.filter((flag) => flag).length).toBeGreaterThan(0);
		expect(flags.at(-1)).toBe(true);
		const read = await room.read();
		expect(read.exchanges[0]).toMatchObject({ summary: { status: 'published' } });
	});
});

describe('settled', () => {
	it('resolves through the read and subscribe of a room alone', async () => {
		const room = await open({
			name: roomName('testing-settled'),
			agents: [agent('a')],
			runtime: createRuntime(),
			execution: scripted((_step, _seat, call) => (call === 1 ? speak('an answer') : quiet())),
		});
		const reads = vi.fn(room.read.bind(room));
		await (await room.visit(andrei)).send({ text: 'Question?' });
		const read = await settled({
			name: room.name,
			read: reads,
			subscribe: room.subscribe.bind(room),
		});
		expect(read.exchange).toBeUndefined();
		expect(read.participants.every((p) => p.kind !== 'agent' || p.status === 'idle')).toBe(true);
		expect(reads).toHaveBeenCalled();
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

	function harness(commit: (request: CommitRequest) => CommitResult) {
		const commits: CommitRequest[] = [];
		const events: ExecutionEvent[] = [];
		const activation: ExecutorActivation = {
			id: 'act-1',
			room: {
				view: async () => ({ stale: 'unused' }),
				commit: async (request) => {
					commits.push(request);
					return commit(request);
				},
				lease: async () => ({ stale: 'unused' }),
			},
			emit: (event) => events.push(event),
			trace: { startPass() {}, record() {}, usage: () => undefined, close: async () => {} },
		};
		return { activation, commits, events };
	}

	const said = (seq: number): CommitResult => ({
		committed: { kind: 'said', seq, from: 'a', text: 'hi', at: '' } as never,
	});
	const input = (v: ActivationView): PassInput => ({ kind: 'view', view: v });

	it('commits a say against the position it read and advances readThrough', async () => {
		const { activation, commits } = harness(() => said(4));
		const session = scriptedExecutor(
			(_step, _seat, call) => (call === 1 ? speak('hi') : quiet()),
			agent('a'),
		).open(activation);
		await expect(session.pass(input(respond))).resolves.toEqual({ failed: false });
		expect(commits).toHaveLength(1);
		expect(commits[0]).toMatchObject({ readThrough: 3, intent: { kind: 'said', text: 'hi' } });
		expect(session.readThrough).toBe(4);
		expect(session.shouldRefresh(4)).toBe(false);
		expect(session.shouldRefresh(5)).toBe(true);
	});

	it('takes the messages a refused say missed as read, and lets the script say again', async () => {
		let first = true;
		const { activation, commits } = harness(() => {
			if (!first) return said(9);
			first = false;
			return { missed: [{ kind: 'said', seq: 8 } as never] };
		});
		const seen: string[] = [];
		const session = scriptedExecutor((step) => {
			seen.push(step.results.map((result) => result.text).join(','));
			return step.results.some((r) => r.text === 'delivered') ? quiet() : speak('again');
		}, agent('a')).open(activation);
		await session.pass(input(respond));
		expect(commits.map((c) => c.key)).toHaveLength(2);
		expect(new Set(commits.map((c) => c.key)).size).toBe(2);
		expect(seen).toEqual(['', 'missed', 'missed,delivered']);
		expect(session.readThrough).toBe(9);
	});

	it('stops when the room answers stale, and never asks again', async () => {
		const { activation, commits } = harness(() => ({ stale: 'lease ended' }));
		const session = scriptedExecutor(() => speak('hi'), agent('a')).open(activation);
		await session.pass(input(respond));
		expect(commits).toHaveLength(1);
		expect(session.cancelled).toBe(true);
		expect(session.shouldRefresh(99)).toBe(false);
	});

	it('commits a closing say without readThrough and ends the pass', async () => {
		const closing = view(5, {
			kind: 'summarize',
			exchange: 1,
			person: 'andrei',
			people: ['andrei'],
			through: 5,
		});
		const { activation, commits } = harness(() => said(6));
		const session = scriptedExecutor(() => speak('summary'), agent('a')).open(activation);
		await session.pass(input(closing));
		expect(commits).toHaveLength(1);
		expect(commits[0]).not.toHaveProperty('readThrough');
	});

	it('reports a script that throws as a transient failure and emits the error', async () => {
		const { activation, events } = harness(() => said(4));
		const session = scriptedExecutor(() => {
			throw new Error('broke');
		}, agent('a')).open(activation);
		await expect(session.pass(input(respond))).resolves.toEqual({
			failed: true,
			cause: 'transient',
			message: 'broke',
		});
		expect(events).toEqual([expect.objectContaining({ type: 'error', cause: 'transient' })]);
	});
});

describe('the entry', () => {
	it('imports no Pi and no model library', async () => {
		const root = fileURLToPath(new URL('../src', import.meta.url));
		const files = ['testing.ts', ...(await readdir(`${root}/testing`)).map((f) => `testing/${f}`)];
		for (const file of files) {
			const code = await readFile(`${root}/${file}`, 'utf8');
			const imported = [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
				(m) => m[1] ?? '',
			);
			const models = imported.filter((name) =>
				/^@earendil-works\/|pi-journal$|\/pi(\/|$)/.test(name),
			);
			expect({ file, models }).toEqual({ file, models: [] });
		}
	});
});
