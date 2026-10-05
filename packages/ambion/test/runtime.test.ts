/**
 * The runtime is what a host owns. Two runtimes in one process are two
 * hosts: they share nothing, and a room on a durable storage is read by a
 * second runtime over the same storage.
 */
import { readdir } from 'node:fs/promises';
import { memoryJournals } from '@ambionframework/journal';
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { hostingOf } from '../src/hosting.ts';
import {
	type CreateRuntimeOptions,
	createRuntime,
	isSaid,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
	systemClock,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { andrei, assistant, messagesOf, roomName, waitForRoom } from './support/room.ts';
import { quiet, scriptedStream } from './support/scripted.ts';
import { childStorage, memory, sqlite } from './support/storage.ts';

const quietRoom = (name: string, runtime: Runtime) =>
	startRoom({
		name,
		runtime,
		seats: { [assistant.name]: 'none' },
		agents: [assistant],
		execution: piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) }),
	});

type Limits = NonNullable<CreateRuntimeOptions['limits']>;

describe('the required options', () => {
	it('refuses a runtime with no storage at the type level, and a room operation with no runtime', async () => {
		// @ts-expect-error `storage` is required.
		const withoutStorage = (): Runtime => createRuntime({});
		expect(withoutStorage).toBeTypeOf('function');
		// @ts-expect-error `runtime` is required.
		await expect(startRoom({ name: 'no-runtime', agents: [assistant] })).rejects.toThrow();
		// @ts-expect-error `runtime` is required.
		await expect(resumeRoom('no-runtime', { agents: [assistant] })).rejects.toThrow();
		// @ts-expect-error `runtime` is required.
		await expect(readRoom('no-runtime', {})).rejects.toThrow();
	});
});

describe('the system clock', () => {
	it('waits the longest delay a timer takes, and no less, for an alarm past it', () => {
		// A timer over 2^31 - 1 ms fires at once, and the room would reconcile in a loop.
		const clock = systemClock();
		let fired = false;
		const cancel = clock.alarm(clock.now() + 30 * 86_400_000, () => {
			fired = true;
		});
		onTestFinished(cancel);
		return new Promise<void>((resolve) =>
			setTimeout(() => {
				expect(fired).toBe(false);
				resolve();
			}, 20),
		);
	});
});

describe('createRuntime', () => {
	it.each<[string, Limits, RegExp]>([
		['a retry cap below one attempt', { activation: { attempts: 0 } }, /at least one attempt/],
		['a fractional retry cap', { activation: { attempts: 1.5 } }, /positive integer/],
		['a wake interval below one millisecond', { port: { resend: 0 } }, /limits.port.resend/],
		['a negative lease', { lease: { ttl: -1 } }, /limits.lease.ttl/],
		[
			'a deadline that is not a number',
			{ lease: { deadline: Number.NaN } },
			/limits.lease.deadline/,
		],
		['a context of no messages', { context: { messages: 0 } }, /limits.context.messages/],
		['a fractional context', { context: { messages: 1.5 } }, /limits.context.messages/],
		[
			'a context that is not a number',
			{ context: { messages: Number.NaN } },
			/limits.context.messages/,
		],
		['a message of no bytes', { message: { bytes: 0 } }, /limits.message.bytes/],
		[
			'a scheduled say of no seconds',
			{ schedule: { minDelaySeconds: 0 } },
			/limits.schedule.minDelaySeconds/,
		],
		[
			'a least delay with no bound',
			{ schedule: { minDelaySeconds: Number.POSITIVE_INFINITY } },
			/limits.schedule.minDelaySeconds/,
		],
		[
			'a most delay below the least',
			{ schedule: { minDelaySeconds: 600, maxDelaySeconds: 60 } },
			/limits.schedule.maxDelaySeconds/,
		],
		['no scheduled says', { schedule: { waiting: 0 } }, /limits.schedule.waiting/],
	])('refuses %s', (_, limits, error) => {
		expect(() => createRuntime({ storage: memoryJournals(), limits })).toThrow(error);
	});

	it('exposes every limit at its default, keeps the rest of a group on override, and accepts the floors', () => {
		const limits = hostingOf(createRuntime({ storage: memoryJournals() })).limits;
		expect(limits.port).toEqual({ resend: 5_000 });
		expect(limits.lease).toEqual({ ttl: 60_000, deadline: 600_000 });
		expect(limits.activation.attempts).toBe(3);
		expect([1, 2, 3].map(limits.activation.backoff)).toEqual([30_000, 60_000, 90_000]);
		expect(limits.call).toEqual({ attempts: 2, timeout: 10_000 });
		expect(limits.context).toEqual({ messages: Number.POSITIVE_INFINITY });
		expect(limits.message).toEqual({ bytes: Number.POSITIVE_INFINITY });
		expect(limits.trace).toEqual({ toolOutputBytes: 65_536, stepsPerPass: 1_000 });
		expect(limits.schedule).toEqual({ minDelaySeconds: 60, maxDelaySeconds: 604_800, waiting: 4 });

		const overridden = hostingOf(
			createRuntime({
				storage: memoryJournals(),
				limits: {
					lease: { ttl: 1 },
					activation: { attempts: 1 },
					port: { resend: 1 },
					context: { messages: 200 },
				},
			}),
		).limits;
		expect(overridden.lease).toEqual({ ttl: 1, deadline: 600_000 });
		expect(overridden.activation.attempts).toBe(1);
		expect(overridden.port.resend).toBe(1);
		expect(overridden.context.messages).toBe(200);
		expect(overridden.message.bytes).toBe(Number.POSITIVE_INFINITY);
		expect(() =>
			createRuntime({
				storage: memoryJournals(),
				limits: {
					context: { messages: Number.POSITIVE_INFINITY },
					message: { bytes: Number.POSITIVE_INFINITY },
				},
			}),
		).not.toThrow();
	});

	it('keeps two runtimes apart', async () => {
		const name = roomName('runtime');
		const [one, two] = await Promise.all([memory.open(), memory.open()]);
		const first = createRuntime({ storage: one.storage, clock: fakeClock() });
		const second = createRuntime({ storage: two.storage, clock: fakeClock() });
		const a = await quietRoom(name, first);
		const b = await quietRoom(name, second);
		await (await a.visit(andrei)).send({ text: 'in the first' });
		await (await b.visit(andrei)).send({ text: 'in the second' });
		await Promise.all([waitForRoom(a, 'settled'), waitForRoom(b, 'settled')]);

		expect((await messagesOf(a)).filter(isSaid).map((m) => m.text)).toEqual(['in the first']);
		expect((await messagesOf(b)).filter(isSaid).map((m) => m.text)).toEqual(['in the second']);
		expect((await readRoom(name, { runtime: first })).name).toBe(a.name);
		expect((await readRoom(name, { runtime: second })).name).toBe(b.name);
		await Promise.all([a.stop(), b.stop()]);
	});

	it('writes a room durably, where a second runtime reads it', async () => {
		const opened = await sqlite.open();
		onTestFinished(() => opened.dispose());
		const dir = opened.dir ?? '';
		const name = roomName('sqlite');
		const session = await quietRoom(
			name,
			createRuntime({ storage: opened.storage, clock: fakeClock() }),
		);
		const visit = await session.visit(andrei);
		await visit.send({ text: 'kept on disk' });
		await waitForRoom(session);
		await session.stop();

		const files = await readdir(dir, { recursive: true });
		expect(files.some((file) => String(file).endsWith('.db'))).toBe(true);

		const reader = createRuntime({ storage: childStorage('sqlite', dir), clock: fakeClock() });
		const view = await readRoom(name, { runtime: reader });
		expect(view.messages.map((m) => m.kind)).toEqual(['arrived', 'said', 'left']);
		expect(view.messages.filter(isSaid).map((m) => m.text)).toEqual(['kept on disk']);
	});
});
