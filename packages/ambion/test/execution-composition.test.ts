/**
 * How a room finds the execution for a seat. An execution of a room or a
 * runtime runs before a default. One router serves each seat on the first
 * execution for its executor kind, and an execution with no kind serves
 * every kind. A room with no execution still runs its people and its
 * record. A seat whose kind no execution serves fails at once and for good,
 * and the room does not wake it again. Stub executions stand in for a
 * family, because the kernel imports no executor package.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	defineExecution,
	type Execution,
	type Executor,
	hostingOf,
	localExecution,
} from '../src/hosting.ts';
import {
	type AgentExecutor,
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { andrei, collect, roomName, stateOf, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted, speak } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { memory } from './support/storage.ts';

/** A stub execution that counts its builds and the seats it connects. Absent a kind, it serves every kind. */
function stub(connected: string[] = [], kind?: string) {
	const counts = { built: 0, connected: 0 };
	const execution: Execution = {
		...(kind === undefined ? {} : { kind }),
		connector() {
			counts.built += 1;
			return {
				connect(_room, request) {
					counts.connected += 1;
					connected.push(request.seat);
					return { wake: async () => {}, steer: async () => {}, cut: async () => {} };
				},
			};
		},
	};
	return { counts, execution };
}

/** An executor whose sessions never run a pass: the stub of a default counts only its builds. */
const idle: Executor = {
	open: () => ({
		readThrough: 0,
		cancelled: false,
		pass: async () => ({ failed: false }),
		shouldRefresh: () => false,
		abort() {},
	}),
};

/** A default of `kind`, defined the way an executor package defines one, that counts its builds. */
function defaultOf(kind: string) {
	const counts = { built: 0, connected: 0 };
	defineExecution(kind, () => {
		counts.built += 1;
		return () => {
			counts.connected += 1;
			return idle;
		};
	});
	return counts;
}

function seat(kind: string, name = 'worker') {
	const executor: AgentExecutor = { kind, instructions: 'answer', tools: [] };
	return defineAgent({ name, identity: 'Answers.', executor });
}

async function ask(options: Parameters<typeof startRoom>[0]) {
	const room = stopAtEnd(await startRoom(options));
	await (await room.visit(andrei)).send({ text: 'Anybody there?' });
	await room.stop();
	return room;
}

describe('the execution a room chooses', () => {
	// The defaults register as the suite loads, so each case sees the same known kinds.
	const once = defaultOf('stub-once');
	const overridden = {
		room: defaultOf('stub-room-override'),
		runtime: defaultOf('stub-runtime-override'),
	};

	it('runs the default of the kind when the host passes none, and builds it once per runtime', async () => {
		const defaults = once;
		// An execution that localExecution builds does not change the default of its kind.
		let local = 0;
		localExecution('stub-once', () => {
			local += 1;
			return () => idle;
		});
		const runtime = createRuntime();
		await ask({ name: roomName('once-a'), agents: [seat('stub-once')], runtime });
		await ask({ name: roomName('once-b'), agents: [seat('stub-once')], runtime });
		await vi.waitFor(() => expect(defaults.connected).toBeGreaterThan(1));
		expect(defaults.built).toBe(1);
		expect(local).toBe(0);
	});

	it.each(['room', 'runtime'] as const)(
		'runs the execution of the %s and not the default',
		async (owner) => {
			const kind = `stub-${owner}-override`;
			const defaults = overridden[owner];
			const explicit = stub();
			await ask({
				name: roomName(kind),
				agents: [seat(kind)],
				runtime: createRuntime(owner === 'runtime' ? { execution: explicit.execution } : {}),
				...(owner === 'room' ? { execution: explicit.execution } : {}),
			});
			await vi.waitFor(() => expect(explicit.counts.connected).toBeGreaterThan(0));
			expect(defaults).toEqual({ built: 0, connected: 0 });
		},
	);

	it('routes each seat to the first execution for its kind, the room before the runtime', async () => {
		const pi: string[] = [];
		const claude: string[] = [];
		const shadowed: string[] = [];
		await ask({
			name: roomName('routes'),
			agents: [seat('pi', 'pilot'), seat('claude', 'sonnet')],
			runtime: createRuntime({ execution: stub(shadowed, 'pi').execution }),
			execution: [stub(pi, 'pi').execution, stub(claude, 'claude').execution],
		});
		await vi.waitFor(() => expect([...pi, ...claude]).toEqual(['pilot', 'sonnet']));
		expect(shadowed).toEqual([]);
	});

	const other = () => stub([], 'pi').execution;
	const missing = (kind: string) =>
		`No execution serves seat 'worker' of kind '${kind}'. Load the executor package of the kind, or pass an \`execution\` of the kind, such as \`piExecution()\` from @ambionframework/pi, to startRoom or createRuntime. Known kinds: pi, stub-once, stub-room-override, stub-runtime-override.`;
	const reason = missing('claude');
	it.each([
		{ router: 'an execution of another kind on the room', kind: 'claude', room: other(), reason },
		{
			router: 'an execution of another kind on the runtime',
			kind: 'claude',
			runtime: other(),
			reason,
		},
		{
			router: 'the defaults',
			kind: 'none',
			reason: missing('none'),
		},
	])(
		'fails the activation at once and for good when $router serves no execution for the kind',
		async ({ kind, room: own, runtime: shared, reason }) => {
			const clock = fakeClock();
			const runtime = createRuntime({
				clock,
				...(shared === undefined ? {} : { execution: shared }),
			});
			const room = stopAtEnd(
				await startRoom({
					name: roomName('no-execution'),
					agents: [seat(kind)],
					runtime,
					...(own === undefined ? {} : { execution: own }),
				}),
			);
			const events = collect(room);
			await (await room.visit(andrei)).send({ text: 'Anybody there?' });
			await waitForRoom(room, 'settled', 10_000);
			const failures = events.filter((event) => event.type === 'error');
			expect(failures.length).toBeGreaterThan(0);
			expect(failures[0]).toMatchObject({
				cause: 'permanent',
				agent: 'worker',
				error: { code: 'no_execution', message: reason },
			});
			const seen = events.length;
			await clock.advance(3 * hostingOf(runtime).limits.delivery.resend);
			await room.reconcile();
			expect(events.slice(seen)).toEqual([]);
			expect(stateOf(room).due).toEqual([]);
		},
	);
});

interface Call {
	readonly systemPrompt: string;
	readonly context: string;
}

function definition(identity: string, instructions: string) {
	return defineAgent({
		name: 'writer',
		identity,
		executor: pi({ instructions, model: 'scripted/writer' }),
	});
}

function answer(question: string, response: string, calls: Call[]): StreamFn {
	return scripted((context) => {
		const text = contextText(context);
		calls.push({ systemPrompt: context.systemPrompt ?? '', context: text });
		return text.includes(question) && !text.includes(response) ? speak(response) : quiet();
	});
}

async function spokenTexts(room: { read(): Promise<{ messages: readonly Message[] }> }) {
	const { messages } = await room.read();
	return messages.filter(isSpoken).map((message) => message.text);
}

describe('execution composition', () => {
	it('keeps same named definitions and room stream overrides isolated in one runtime', async () => {
		let defaultCalls = 0;
		const runtime = createRuntime({
			execution: piExecution({
				sessions: 'memory',
				stream: scripted(() => {
					defaultCalls += 1;
					return quiet();
				}),
			}),
		});
		const rooms = await Promise.all(
			(['First', 'Second'] as const).map(async (label) => {
				const calls: Call[] = [];
				const writer = definition(`${label} writer.`, `Use the ${label} room instructions.`);
				const room = stopAtEnd(
					await startRoom({
						name: roomName(`execution-${label.toLowerCase()}`),
						runtime,
						agents: [writer],
						execution: piExecution({
							sessions: 'memory',
							stream: answer(`${label} question?`, `${label} answer.`, calls),
						}),
					}),
				);
				return { label, calls, writer, room };
			}),
		);
		await Promise.all(
			rooms.map(async ({ room, label }) =>
				(await room.visit(andrei)).send({ text: `${label} question?` }),
			),
		);
		await Promise.all(rooms.map(({ room }) => waitForRoom(room)));

		expect(defaultCalls).toBe(0);
		const [first, second] = rooms;
		if (first === undefined || second === undefined) throw new Error('Two rooms expected.');
		for (const [own, other] of [
			[first, second],
			[second, first],
		] as const) {
			expect(await spokenTexts(own.room)).toEqual([
				`${own.label} question?`,
				`${own.label} answer.`,
			]);
			const prompts = own.calls.map((call) => call.systemPrompt);
			expect(prompts.some((prompt) => prompt.includes(own.writer.identity))).toBe(true);
			expect(prompts.every((prompt) => prompt.includes(own.writer.executor.instructions))).toBe(
				true,
			);
			expect(prompts.some((prompt) => prompt.includes(other.writer.executor.instructions))).toBe(
				false,
			);
		}
	});

	it('uses the runtime stream as the default and resumes one room with new execution', async () => {
		const opened = await memory.open();
		const firstCalls: Call[] = [];
		const fallbackCalls: Call[] = [];
		const runtime = createRuntime({
			storage: opened.storage,
			execution: piExecution({
				sessions: 'memory',
				stream: answer('Other question?', 'Runtime answer.', fallbackCalls),
			}),
		});
		const first = stopAtEnd(
			await startRoom({
				name: roomName('execution-resume-first'),
				runtime,
				agents: [definition('Original writer.', 'Use the original instructions.')],
				execution: piExecution({
					sessions: 'memory',
					stream: answer('Original question?', 'Original answer.', firstCalls),
				}),
			}),
		);
		const second = stopAtEnd(
			await startRoom({
				name: roomName('execution-resume-second'),
				runtime,
				agents: [definition('Other writer.', 'Keep the other room separate.')],
			}),
		);
		const original = await (await first.visit(andrei)).send({ text: 'Original question?' });
		await original.waitForClose();
		await first.stop();

		const resumed = stopAtEnd(
			await resumeRoom(first.name, {
				runtime,
				agents: [definition('Replacement writer.', 'Use the replacement instructions.')],
				execution: piExecution({
					sessions: 'memory',
					stream: answer('Replacement question?', 'Replacement answer.', firstCalls),
				}),
			}),
		);
		const replacement = await (
			await resumed.visit(defineHuman({ name: 'replacement-person', identity: 'A new visitor.' }))
		).send({ text: 'Replacement question?' });
		const other = await (await second.visit(andrei)).send({ text: 'Other question?' });
		await Promise.all([replacement.waitForClose(), other.waitForClose()]);

		expect(await spokenTexts(resumed)).toContain('Replacement answer.');
		expect(await spokenTexts(second)).toEqual(['Other question?', 'Runtime answer.']);
		expect(fallbackCalls.length).toBeGreaterThan(0);
		expect(
			fallbackCalls.every((call) => call.systemPrompt.includes('Keep the other room separate.')),
		).toBe(true);
		expect(
			firstCalls.some((call) => call.systemPrompt.includes('Use the replacement instructions.')),
		).toBe(true);
		await Promise.all([resumed.stop(), second.stop()]);
		await opened.dispose();
	});
});
