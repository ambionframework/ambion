import type {
	ExchangeHandle,
	HumanDefinition,
	Message,
	Room,
	RoomNotification,
	RoomRead,
	Seq,
	Visit,
} from '@ambionframework/ambion';
import { defineAgent, startRoom } from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import { byAgent, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import type { WorkspaceAgent } from '../src/index.ts';
import {
	memoryBackend,
	openWorkspace,
	ROOM_MIRROR_GUIDANCE,
	roomMirrorPath,
} from '../src/index.ts';

const reader: WorkspaceAgent = { name: 'reader', identity: 'Reads the mirrored file back.' };

function said(seq: Seq, text: string, from = 'priya'): Message {
	return { kind: 'said', seq, at: new Date(seq).toISOString(), from, text };
}

/** A minimal `Room` double: a fixed backlog, plus a live feed a test drives by hand. */
function fakeRoom(
	roomName: string,
	backlog: Message[],
): Room & { emit(event: RoomNotification): void } {
	const listeners = new Set<(event: RoomNotification) => void>();
	return {
		name: roomName,
		async read(options): Promise<RoomRead> {
			const selection = options?.messages;
			const since = selection === false ? undefined : selection?.since;
			const messages =
				selection === false
					? []
					: since === undefined
						? backlog
						: backlog.filter((m) => m.seq > since);
			return {
				name: roomName,
				initialized: true,
				messages,
				participants: [],
				exchanges: [],
				exchange: undefined,
				watermark: backlog.at(-1)?.seq ?? 0,
			};
		},
		async pendingFor() {
			return [];
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		exchange: (_from: Seq): ExchangeHandle | undefined => undefined,
		visit: (_human: HumanDefinition): Promise<Visit> => {
			throw new Error('not implemented in this double');
		},
		stop: async () => {},
		abort: async () => {},
		seat: async () => {},
		unseat: async () => {},
		reconcile: async () => {},
		emit(event) {
			for (const listener of listeners) listener(event);
		},
	};
}

async function readLines(env: ExecutionEnv, path: string): Promise<Record<string, unknown>[]> {
	const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
	if (!read.ok) return [];
	return read.value
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Workspace.mirror', () => {
	it('names the path under /rooms/<room name>/messages.jsonl', () => {
		expect(roomMirrorPath('lobby')).toBe('/rooms/lobby/messages.jsonl');
	});

	it('always includes the /rooms guidance in tools(), with no option to set', () => {
		const site = openWorkspace({ name: name('guidance'), backend: memoryBackend() });
		expect(site.tools().guidance).toContain(ROOM_MIRROR_GUIDANCE);
	});

	it('backfills the full backlog, in order, on a fresh log', async () => {
		const site = openWorkspace({ name: name('fresh'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one'), said(2, 'two'), said(3, 'three')]);

		const mirror = await site.mirror(room);
		expect(mirror.path).toBe('/rooms/lobby/messages.jsonl');
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
		expect(lines.every((line) => line.room === 'lobby')).toBe(true);
		await site.dispose();
	});

	it('resumes from the highest seq already on disk, writing nothing twice', async () => {
		const site = openWorkspace({ name: name('resume'), backend: memoryBackend() });
		const backlog = [said(1, 'one'), said(2, 'two'), said(3, 'three')];

		const first = await site.mirror(fakeRoom('lobby', backlog));
		await first.stop();

		// A fresh call, as a restarted host would make: no in-memory state survives.
		const second = await site.mirror(fakeRoom('lobby', backlog));
		await second.stop();

		const lines = await site.use(reader, (env) => readLines(env, second.path));
		expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
		await site.dispose();
	});

	it('appends a live message as it arrives, after the backfill', async () => {
		const site = openWorkspace({ name: name('live'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one')]);

		const mirror = await site.mirror(room);
		room.emit({ type: 'message', message: said(2, 'two') });
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		expect(lines.map((line) => line.text)).toEqual(['one', 'two']);
		await site.dispose();
	});

	it('drops a message already accounted for, from either source', async () => {
		const site = openWorkspace({ name: name('dedup'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one'), said(2, 'two')]);

		const mirror = await site.mirror(room);
		// A duplicate delivery of a message the backfill already wrote.
		room.emit({ type: 'message', message: said(2, 'two') });
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		expect(lines).toHaveLength(2);
		await site.dispose();
	});

	it('does not drop a message published while the backfill read is still in flight', async () => {
		// A room settles its read only once every queued append has landed, so
		// it can publish a message to a brand-new subscriber before that same
		// read resolves with the message already included. Appending it right
		// away would mark it accounted for before the backfill loop runs, and
		// the loop would then skip it as already written: gone for good.
		const site = openWorkspace({ name: name('race'), backend: memoryBackend() });
		const backlog = [said(1, 'one'), said(2, 'two')];
		const base = fakeRoom('lobby', backlog);
		const room: typeof base = {
			...base,
			async read(options) {
				base.emit({ type: 'message', message: said(3, 'three') });
				backlog.push(said(3, 'three'));
				return base.read(options);
			},
		};

		const mirror = await site.mirror(room);
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
		await site.dispose();
	});

	it('ignores a live event once stopped', async () => {
		const site = openWorkspace({ name: name('stopped'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one')]);

		const mirror = await site.mirror(room);
		await mirror.stop();
		room.emit({ type: 'message', message: said(2, 'two') });
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		expect(lines).toHaveLength(1);
		await site.dispose();
	});

	it('reports a write failure to onError, and keeps running', async () => {
		const site = openWorkspace({ name: name('write-fails'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one')]);
		const errors: Error[] = [];

		const mirror = await site.mirror(room, { onError: (error) => errors.push(error) });
		// Settle the backfill's own write before disposing: reads and writes
		// share one queue, so this proves message one already landed.
		await site.use(reader, (env) => readLines(env, mirror.path));
		await site.dispose();
		room.emit({ type: 'message', message: said(2, 'two') });
		await mirror.stop();

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/no longer available/i);
	});

	it('refuses a room name that would resolve outside /rooms, instead of writing there', async () => {
		const site = openWorkspace({ name: name('escape'), backend: memoryBackend() });
		const room = fakeRoom('../escape', []);

		await expect(site.mirror(room)).rejects.toThrow(/room name/i);
		await site.dispose();
	});

	it('unsubscribes before rejecting when the backfill read itself fails', async () => {
		const site = openWorkspace({ name: name('read-fails'), backend: memoryBackend() });
		const base = fakeRoom('lobby', []);
		let subscribed = 0;
		const room: typeof base = {
			...base,
			subscribe(listener) {
				subscribed += 1;
				const off = base.subscribe(listener);
				return () => {
					subscribed -= 1;
					off();
				};
			},
			read: () => Promise.reject(new Error('storage unavailable')),
		};

		await expect(site.mirror(room)).rejects.toThrow(/storage unavailable/);
		expect(subscribed).toBe(0);
		await site.dispose();
	});

	it('names the real room, through a running room, over its own message record', async () => {
		const roomId = name('through-room');
		const site = openWorkspace({ name: name('site'), backend: memoryBackend() });
		const worker = defineAgent({
			name: 'worker',
			identity: 'Says two things.',
			executor: pi({
				instructions: 'speak',
				model: 'scripted/worker',
				bundles: [],
			}),
		});
		const session = await startRoom({
			name: roomId,
			agents: [worker],
			execution: piExecution({
				stream: scripted(
					byAgent({
						worker: (_context, _who, call) => {
							if (call === 1) return speak('first');
							if (call === 2) return speak('second');
							return quiet();
						},
					}),
				),
			}),
		});
		const mirror = await site.mirror(session);
		const visit = await enter(session);
		const exchange = await visit.send({ text: 'go' });
		await exchange.waitForClose();
		// Stop the room, and its shutdown-triggered "left", before stopping
		// the mirror itself: a mirror that stopped first must not see what
		// came after.
		await session.stop();
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		const spoken = lines.filter((line) => line.kind === 'said' && line.from === 'worker');
		expect(spoken.map((line) => line.text)).toEqual(['first', 'second']);
		expect(lines.every((line) => line.room === roomId)).toBe(true);

		const read = await session.read();
		expect(lines).toHaveLength(read.messages.length);
		await site.dispose();
	});
});
