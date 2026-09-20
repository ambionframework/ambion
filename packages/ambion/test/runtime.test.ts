/**
 * The runtime is what a host owns. Two runtimes in one process are two
 * hosts: they share nothing, and a room on a durable storage is read by a
 * second runtime over the same storage.
 */
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hostingOf } from '../src/hosting.ts';
import { createRuntime, isSpoken, readRoom, startRoom } from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { andrei, assistant, messagesOf, roomName, waitForRoom } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { childStorage, memory, sqlite } from './support/storage.ts';

describe('createRuntime', () => {
	it('refuses a retry cap below one attempt, which the verified cap rule requires', () => {
		expect(() => createRuntime({ limits: { activation: { attempts: 0 } } })).toThrow(
			/at least one attempt/,
		);
		expect(() => createRuntime({ limits: { activation: { attempts: 1.5 } } })).toThrow(
			/positive integer/,
		);
		expect(
			hostingOf(createRuntime({ limits: { activation: { attempts: 1 } } })).limits.activation
				.attempts,
		).toBe(1);
	});

	it('refuses a wake interval below one millisecond, so a resend and a claim always wait', () => {
		expect(() => createRuntime({ limits: { delivery: { resend: 0 } } })).toThrow(
			/limits.delivery.resend/,
		);
		expect(() => createRuntime({ limits: { lease: { ttl: -1 } } })).toThrow(/limits.lease.ttl/);
		expect(() => createRuntime({ limits: { lease: { deadline: Number.NaN } } })).toThrow(
			/limits.lease.deadline/,
		);
		expect(
			hostingOf(createRuntime({ limits: { delivery: { resend: 1 } } })).limits.delivery.resend,
		).toBe(1);
	});

	it('exposes every limit at its default, and an override keeps the rest of its group', () => {
		const limits = hostingOf(createRuntime()).limits;
		expect(limits.delivery).toEqual({ resend: 5_000 });
		expect(limits.lease).toEqual({ ttl: 60_000, deadline: 600_000 });
		expect(limits.activation.attempts).toBe(3);
		expect([1, 2, 3].map(limits.activation.backoff)).toEqual([30_000, 60_000, 90_000]);
		expect(limits.call).toEqual({ attempts: 2, timeout: 10_000 });
		expect(limits.context).toEqual({ messages: Number.POSITIVE_INFINITY });
		expect(limits.message).toEqual({ bytes: Number.POSITIVE_INFINITY });
		expect(limits.trace).toEqual({ toolOutputBytes: 65_536, stepsPerPass: 1_000 });

		const overridden = hostingOf(createRuntime({ limits: { lease: { ttl: 1 } } })).limits;
		expect(overridden.lease).toEqual({ ttl: 1, deadline: 600_000 });
	});

	it('keeps two runtimes apart: one name runs in both, and neither reads the other', async () => {
		const name = roomName('runtime');
		const [one, two] = await Promise.all([memory.open(), memory.open()]);
		const first = createRuntime({ storage: one.storage, clock: fakeClock() });
		const second = createRuntime({ storage: two.storage, clock: fakeClock() });
		const a = await startRoom({
			name,
			runtime: first,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			stream: scripted(() => quiet()),
		});
		const b = await startRoom({
			name,
			runtime: second,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			stream: scripted(() => quiet()),
		});
		await (await a.visit(andrei)).send({ text: 'in the first' });
		await (await b.visit(andrei)).send({ text: 'in the second' });
		await Promise.all([waitForRoom(a, 'settled'), waitForRoom(b, 'settled')]);

		expect((await messagesOf(a)).filter(isSpoken).map((m) => m.text)).toEqual(['in the first']);
		expect((await messagesOf(b)).filter(isSpoken).map((m) => m.text)).toEqual(['in the second']);
		expect((await readRoom(name, { runtime: first })).name).toBe(a.name);
		expect((await readRoom(name, { runtime: second })).name).toBe(b.name);
		await Promise.all([a.stop(), b.stop()]);
	});

	it('writes a room durably, where a second runtime reads it', async () => {
		const opened = await sqlite.open();
		const dir = opened.dir ?? '';
		try {
			const name = roomName('sqlite');
			const writer = createRuntime({
				storage: opened.storage,
				clock: fakeClock(),
			});
			const session = await startRoom({
				name,
				runtime: writer,
				seats: { [assistant.name]: 'none' },
				agents: [assistant],
				stream: scripted(() => quiet()),
			});
			const visit = await session.visit(andrei);
			await visit.send({ text: 'kept on disk' });
			await waitForRoom(session);
			await session.stop();

			const files = await readdir(dir, { recursive: true });
			expect(files.some((file) => String(file).endsWith('.db'))).toBe(true);

			const reader = createRuntime({
				storage: childStorage('sqlite', dir),
				clock: fakeClock(),
			});
			const view = await readRoom(name, { runtime: reader });
			expect(view.messages.map((m) => m.kind)).toEqual(['arrived', 'said', 'left']);
			expect(view.messages.filter(isSpoken).map((m) => m.text)).toEqual(['kept on disk']);
		} finally {
			await opened.dispose();
		}
	});
});
