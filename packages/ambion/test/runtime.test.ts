/**
 * The runtime is what a host owns. Two runtimes in one process are two
 * hosts: they share nothing, and a room on a durable storage is read by a
 * second runtime over the same storage.
 */
import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createRuntime, isSpoken, readRoom, startRoom } from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { andrei, assistant, messagesOf, roomName, waitForRoom } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { childStorage, memory, sqlite } from './support/storage.ts';

describe('createRuntime', () => {
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
			streamFn: scripted(() => quiet()),
		});
		const b = await startRoom({
			name,
			runtime: second,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			streamFn: scripted(() => quiet()),
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
				streamFn: scripted(() => quiet()),
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
