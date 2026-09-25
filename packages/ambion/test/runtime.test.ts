/**
 * The runtime is what a host owns. Two runtimes in one process are two
 * hosts: they share nothing, and a room on a durable storage is read by a
 * second runtime over the same storage. A host reconciles a room by name.
 */
import { readdir } from 'node:fs/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { hostingOf, reconcileRoom } from '../src/hosting.ts';
import {
	type CreateRuntimeOptions,
	createRuntime,
	isSpoken,
	type Runtime,
	readRoom,
	startRoom,
	systemClock,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { andrei, assistant, messagesOf, roomName, waitForRoom } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { childStorage, memory, sqlite } from './support/storage.ts';

const quietRoom = (name: string, runtime: Runtime) =>
	startRoom({
		name,
		runtime,
		seats: { [assistant.name]: 'none' },
		agents: [assistant],
		execution: piExecution({ sessions: 'memory', stream: scripted(() => quiet()) }),
	});

type Limits = NonNullable<CreateRuntimeOptions['limits']>;

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
		[
			'a wake interval below one millisecond',
			{ delivery: { resend: 0 } },
			/limits.delivery.resend/,
		],
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
		['a scheduled say of no seconds', { schedule: { minAfter: 0 } }, /limits.schedule.minAfter/],
		[
			'a least after with no bound',
			{ schedule: { minAfter: Number.POSITIVE_INFINITY } },
			/limits.schedule.minAfter/,
		],
		[
			'a most after below the least',
			{ schedule: { minAfter: 600, maxAfter: 60 } },
			/limits.schedule.maxAfter/,
		],
		['no pending says', { schedule: { pending: 0 } }, /limits.schedule.pending/],
	])('refuses %s', (_, limits, error) => {
		expect(() => createRuntime({ limits })).toThrow(error);
	});

	it('exposes every limit at its default, keeps the rest of a group on override, and accepts the floors', () => {
		const limits = hostingOf(createRuntime()).limits;
		expect(limits.delivery).toEqual({ resend: 5_000 });
		expect(limits.lease).toEqual({ ttl: 60_000, deadline: 600_000 });
		expect(limits.activation.attempts).toBe(3);
		expect([1, 2, 3].map(limits.activation.backoff)).toEqual([30_000, 60_000, 90_000]);
		expect(limits.call).toEqual({ attempts: 2, timeout: 10_000 });
		expect(limits.context).toEqual({ messages: Number.POSITIVE_INFINITY });
		expect(limits.message).toEqual({ bytes: Number.POSITIVE_INFINITY });
		expect(limits.trace).toEqual({ toolOutputBytes: 65_536, stepsPerPass: 1_000 });
		expect(limits.schedule).toEqual({ minAfter: 60, maxAfter: 604_800, pending: 4 });

		const overridden = hostingOf(
			createRuntime({
				limits: {
					lease: { ttl: 1 },
					activation: { attempts: 1 },
					delivery: { resend: 1 },
					context: { messages: 200 },
				},
			}),
		).limits;
		expect(overridden.lease).toEqual({ ttl: 1, deadline: 600_000 });
		expect(overridden.activation.attempts).toBe(1);
		expect(overridden.delivery.resend).toBe(1);
		expect(overridden.context.messages).toBe(200);
		expect(overridden.message.bytes).toBe(Number.POSITIVE_INFINITY);
		expect(() =>
			createRuntime({
				limits: {
					context: { messages: Number.POSITIVE_INFINITY },
					message: { bytes: Number.POSITIVE_INFINITY },
				},
			}),
		).not.toThrow();
	});

	it('keeps two runtimes apart, and reconciles a room by name only on its own runtime', async () => {
		const name = roomName('runtime');
		const [one, two] = await Promise.all([memory.open(), memory.open()]);
		const first = createRuntime({ storage: one.storage, clock: fakeClock() });
		const second = createRuntime({ storage: two.storage, clock: fakeClock() });
		const a = await quietRoom(name, first);
		const b = await quietRoom(name, second);
		await (await a.visit(andrei)).send({ text: 'in the first' });
		await (await b.visit(andrei)).send({ text: 'in the second' });
		await Promise.all([waitForRoom(a, 'settled'), waitForRoom(b, 'settled')]);

		expect((await messagesOf(a)).filter(isSpoken).map((m) => m.text)).toEqual(['in the first']);
		expect((await messagesOf(b)).filter(isSpoken).map((m) => m.text)).toEqual(['in the second']);
		expect((await readRoom(name, { runtime: first })).name).toBe(a.name);
		expect((await readRoom(name, { runtime: second })).name).toBe(b.name);

		// reconcileRoom runs a room that runs, and ignores a name that no room runs
		await expect(reconcileRoom(first, name)).resolves.toBeUndefined();
		await expect(reconcileRoom(first, 'nobody')).resolves.toBeUndefined();
		await Promise.all([a.stop(), b.stop()]);
		await expect(reconcileRoom(first, name)).resolves.toBeUndefined();
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
		expect(view.messages.filter(isSpoken).map((m) => m.text)).toEqual(['kept on disk']);
	});
});
