/**
 * How a room finds the execution for a seat. An execution of a room or a
 * runtime is supplied explicitly. One router serves each seat on the first
 * execution for its executor kind, and an execution with no kind serves
 * every kind. A room with no execution still runs its people and its
 * record. A seat whose kind no execution serves fails at once and for good,
 * and the room does not wake it again. Stub executions stand in for an
 * executor kind, because the kernel imports no executor package.
 */
import { describe, expect, it, vi } from 'vitest';
import { pi, piExecution, type StreamFn } from '../../pi/src/index.ts';
import {
	type ActivationOpener,
	type Execution,
	hostingOf,
	localExecution,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	definePerson,
	type Executor,
	isSaid,
	type Message,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { andrei, collect, roomName, stateOf, waitForRoom } from './support/room.ts';
import { contextText, quiet, say, scriptedStream } from './support/scripted.ts';
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

/** An executor whose sessions never run a pass. */
const idle: ActivationOpener = () => ({ pass: async () => ({ failed: false }) });

function seat(kind: string, name = 'worker') {
	const executor: Executor = { kind, instructions: 'answer', tools: [] };
	return defineAgent({ name, identity: 'Answers.', executor });
}

async function ask(options: Parameters<typeof startRoom>[0]) {
	const room = stopAtEnd(await startRoom(options));
	await (await room.visit(andrei)).send({ text: 'Anybody there?' });
	await room.stop();
	return room;
}

describe('the execution a room chooses', () => {
	it('keeps execution construction apart from routing and builds each supplied value once per room', async () => {
		let unusedBuilds = 0;
		localExecution('stub', () => {
			unusedBuilds += 1;
			return () => idle;
		});
		const shared = stub([], 'stub');
		const runtime = createRuntime({ execution: shared.execution });
		for (const label of ['a', 'b']) {
			await ask({
				name: roomName(`explicit-${label}`),
				agents: [seat('stub', 'first'), seat('stub', 'second')],
				runtime,
			});
		}
		expect(shared.counts).toEqual({ built: 2, connected: 4 });
		expect(unusedBuilds).toBe(0);
	});

	it.each(['room', 'runtime'] as const)('runs the execution supplied to the %s', async (owner) => {
		const explicit = stub();
		await ask({
			name: roomName(owner),
			agents: [seat('stub')],
			runtime: createRuntime(owner === 'runtime' ? { execution: explicit.execution } : {}),
			...(owner === 'room' ? { execution: explicit.execution } : {}),
		});
		expect(explicit.counts).toEqual({ built: 1, connected: 1 });
	});

	it.each(['room', 'runtime'] as const)(
		'uses the first matching execution of the %s, including a wildcard',
		async (owner) => {
			const first = stub();
			const later = stub([], 'stub');
			const execution = [first.execution, later.execution];
			await ask({
				name: roomName(`first-${owner}`),
				agents: [seat('stub')],
				runtime: createRuntime(owner === 'runtime' ? { execution } : {}),
				...(owner === 'room' ? { execution } : {}),
			});
			expect(first.counts).toEqual({ built: 1, connected: 1 });
			expect(later.counts).toEqual({ built: 0, connected: 0 });
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
			execution: [stub(pi, 'pi').execution, stub(claude).execution],
		});
		await vi.waitFor(() => expect([...pi, ...claude]).toEqual(['pilot', 'sonnet']));
		expect(shadowed).toEqual([]);
	});

	const other = () => stub([], 'pi').execution;
	const missing = (kind: string, known = 'pi') =>
		`No execution serves seat 'worker' of kind '${kind}'. Pass an \`execution\` of the kind, such as \`piExecution()\` from @ambionframework/pi, to startRoom or createRuntime. Known kinds: ${known}.`;
	const reason = missing('claude');
	it.each([
		{
			router: 'an execution of another kind on the room',
			kind: 'claude',
			room: other(),
			reason,
			before: false,
		},
		{
			router: 'an execution of another kind on the runtime',
			kind: 'claude',
			runtime: other(),
			reason,
			before: false,
		},
		{
			router: 'a runtime created after execution construction',
			kind: 'pi',
			reason: missing('pi', 'none'),
			before: false,
		},
		{
			router: 'a runtime created before execution construction',
			kind: 'pi',
			reason: missing('pi', 'none'),
			before: true,
		},
	])(
		'fails the activation at once and for good when $router serves no execution for the kind',
		async ({ kind, room: own, runtime: shared, reason, before: useBefore }) => {
			const clock = fakeClock();
			const before = createRuntime({ clock });
			// Importing Pi and building another execution cannot configure either runtime.
			piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) });
			const runtime = createRuntime({
				clock,
				...(shared === undefined ? {} : { execution: shared }),
			});
			const room = stopAtEnd(
				await startRoom({
					name: roomName('no-execution'),
					agents: [seat(kind)],
					runtime: useBefore ? before : runtime,
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
				seat: 'worker',
				error: { code: 'no_execution', message: reason },
			});
			const seen = events.length;
			await clock.advance(3 * hostingOf(runtime).limits.port.resend);
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
	return scriptedStream((context) => {
		const text = contextText(context);
		calls.push({ systemPrompt: context.systemPrompt ?? '', context: text });
		return text.includes(question) && !text.includes(response) ? say(response) : quiet();
	});
}

async function spokenTexts(room: { read(): Promise<{ messages: readonly Message[] }> }) {
	const { messages } = await room.read();
	return messages.filter(isSaid).map((message) => message.text);
}

describe('execution composition', () => {
	it('keeps same named definitions and room stream overrides isolated in one runtime', async () => {
		let defaultCalls = 0;
		const runtime = createRuntime({
			execution: piExecution({
				sessions: 'memory',
				stream: scriptedStream(() => {
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
			await resumed.visit(definePerson({ name: 'replacement-person', identity: 'A new visitor.' }))
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
