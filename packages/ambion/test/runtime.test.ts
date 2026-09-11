/**
 * The runtime is what a host owns. Two runtimes in one process are two
 * hosts: they share nothing, and a room on a durable storage is read by a
 * second runtime over the same storage.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineWorkspace,
	destroyWorkspace,
	isSpoken,
	readSession,
	startSession,
	stopSession,
	visitSession,
} from '../src/internal.ts';
import { fakeClock } from './support/clock.ts';
import { andrei, assistant, roomName } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { jsonl, jsonlSessions, memory } from './support/storage.ts';

describe('createRuntime', () => {
	it('keeps two runtimes apart: one name runs in both, and neither reads the other', async () => {
		const name = roomName('runtime');
		const [one, two] = await Promise.all([memory.open(), memory.open()]);
		const first = createRuntime({ sessions: one.sessions, clock: fakeClock() });
		const second = createRuntime({ sessions: two.sessions, clock: fakeClock() });
		const a = startSession({ name, runtime: first, assistant, streamFn: scripted(() => quiet()) });
		const b = startSession({ name, runtime: second, assistant, streamFn: scripted(() => quiet()) });
		await (await visitSession(a, andrei)).deliver({ text: 'in the first' });
		await (await visitSession(b, andrei)).deliver({ text: 'in the second' });
		await Promise.all([a.settled(), b.settled()]);

		expect((await a.messages()).filter(isSpoken).map((m) => m.text)).toEqual(['in the first']);
		expect((await b.messages()).filter(isSpoken).map((m) => m.text)).toEqual(['in the second']);
		expect(readSession(name, { runtime: first })).toBe(a);
		expect(readSession(name, { runtime: second })).toBe(b);
		// a workspace name is taken per runtime, the way a room name is
		const here = defineWorkspace({ name: 'shared-drive', runtime: first });
		const there = defineWorkspace({ name: 'shared-drive', runtime: second });
		expect(() => defineWorkspace({ name: 'shared-drive', runtime: first })).toThrow(/already/);
		await Promise.all([destroyWorkspace(here), destroyWorkspace(there)]);
		await Promise.all([stopSession(a), stopSession(b)]);
	});

	it('writes a room on JSONL through to disk, where a second runtime reads it', async () => {
		const opened = await jsonl.open();
		const dir = opened.dir ?? '';
		try {
			const name = roomName('jsonl');
			const writer = createRuntime({ sessions: opened.sessions, clock: fakeClock() });
			const session = startSession({
				name,
				runtime: writer,
				assistant,
				streamFn: scripted(() => quiet()),
			});
			const visit = await visitSession(session, andrei);
			await visit.deliver({ text: 'kept on disk' });
			await session.settled();
			await stopSession(session);

			const files = await readdir(join(dir, 'sessions'), { recursive: true });
			expect(files.some((file) => String(file).endsWith('.jsonl'))).toBe(true);

			const reader = createRuntime({ sessions: jsonlSessions(dir), clock: fakeClock() });
			const view = readSession(name, { runtime: reader });
			expect((await view.messages()).map((m) => m.kind)).toEqual(['arrived', 'said', 'left']);
			expect((await view.messages()).filter(isSpoken).map((m) => m.text)).toEqual(['kept on disk']);
		} finally {
			await opened.dispose();
		}
	});
});
