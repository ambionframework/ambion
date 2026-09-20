import type {
	ExchangeHandle,
	HumanDefinition,
	Message,
	Room,
	RoomNotification,
	RoomSnapshot,
	Seq,
	Visit,
} from '@ambionframework/ambion';
import { defineAgent, pi, startRoom } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { enter, roomName as name } from '../../ambion/test/support/room.ts';
import { byAgent, quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import type { WorkspaceAgent } from '../src/index.ts';
import { memoryBackend, openWorkspace } from '../src/index.ts';
import { recordRoomMessages, roomRecordGuidance, roomRecordPath } from '../src/room-record.ts';

const host: WorkspaceAgent = { name: 'host', identity: 'Mirrors the room record.' };

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
		async read(options): Promise<RoomSnapshot> {
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

describe('recordRoomMessages', () => {
	it('names the path under /rooms/<room name>/messages.jsonl', () => {
		expect(roomRecordPath('lobby')).toBe('/rooms/lobby/messages.jsonl');
	});

	it('backfills the full backlog, in order, on a fresh log', async () => {
		const site = openWorkspace({ name: name('fresh'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one'), said(2, 'two'), said(3, 'three')]);

		const record = await recordRoomMessages(room, site, host);
		expect(record.path).toBe('/rooms/lobby/messages.jsonl');
		await record.stop();

		const lines = await site.use(host, (env) => readLines(env, record.path));
		expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
		expect(lines.every((line) => line.room === 'lobby')).toBe(true);
		await site.destroy();
	});

	it('resumes from the highest seq already on disk, writing nothing twice', async () => {
		const site = openWorkspace({ name: name('resume'), backend: memoryBackend() });
		const backlog = [said(1, 'one'), said(2, 'two'), said(3, 'three')];
		const room = fakeRoom('lobby', backlog);

		const first = await recordRoomMessages(room, site, host);
		await first.stop();

		// A fresh call, as a restarted host would make: no in-memory state survives.
		const second = await recordRoomMessages(fakeRoom('lobby', backlog), site, host);
		await second.stop();

		const lines = await site.use(host, (env) => readLines(env, second.path));
		expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
		await site.destroy();
	});

	it('appends a live message as it arrives, after the backfill', async () => {
		const site = openWorkspace({ name: name('live'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one')]);

		const record = await recordRoomMessages(room, site, host);
		room.emit({ type: 'message', message: said(2, 'two') });
		await record.stop();

		const lines = await site.use(host, (env) => readLines(env, record.path));
		expect(lines.map((line) => line.text)).toEqual(['one', 'two']);
		await site.destroy();
	});

	it('drops a message already accounted for, from either source', async () => {
		const site = openWorkspace({ name: name('dedup'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one'), said(2, 'two')]);

		const record = await recordRoomMessages(room, site, host);
		// A duplicate delivery of a message the backfill already wrote.
		room.emit({ type: 'message', message: said(2, 'two') });
		await record.stop();

		const lines = await site.use(host, (env) => readLines(env, record.path));
		expect(lines).toHaveLength(2);
		await site.destroy();
	});

	it('ignores a live event once stopped', async () => {
		const site = openWorkspace({ name: name('stopped'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one')]);

		const record = await recordRoomMessages(room, site, host);
		await record.stop();
		room.emit({ type: 'message', message: said(2, 'two') });
		await record.stop();

		const lines = await site.use(host, (env) => readLines(env, record.path));
		expect(lines).toHaveLength(1);
		await site.destroy();
	});

	it('reports a write failure to onError, and keeps running', async () => {
		const site = openWorkspace({ name: name('write-fails'), backend: memoryBackend() });
		const room = fakeRoom('lobby', [said(1, 'one')]);
		const errors: Error[] = [];

		const record = await recordRoomMessages(room, site, host, {
			onError: (error) => errors.push(error),
		});
		// Settle the backfill's own write before destroying: reads and writes
		// share one queue, so this proves message one already landed.
		await site.use(host, (env) => readLines(env, record.path));
		await site.destroy();
		room.emit({ type: 'message', message: said(2, 'two') });
		await record.stop();

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/no longer available/i);
	});

	it('refuses a room name that would resolve outside /rooms, instead of writing there', async () => {
		const site = openWorkspace({ name: name('escape'), backend: memoryBackend() });
		const room = fakeRoom('../escape', []);

		await expect(recordRoomMessages(room, site, host)).rejects.toThrow(/room name/i);
		await site.destroy();
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
			streamFn: scripted(
				byAgent({
					worker: (_context, _who, call) => {
						if (call === 1) return speak('first');
						if (call === 2) return speak('second');
						return quiet();
					},
				}),
			),
		});
		const record = await recordRoomMessages(session, site, host);
		const visit = await enter(session);
		const exchange = await visit.send({ text: 'go' });
		await exchange.waitForClose();
		// Stop the room, and its recorded "left", before stopping the record
		// itself: a record that stopped first must not see what came after.
		await session.stop();
		await record.stop();

		const lines = await site.use(host, (env) => readLines(env, record.path));
		const said = lines.filter((line) => line.kind === 'said' && line.from === 'worker');
		expect(said.map((line) => line.text)).toEqual(['first', 'second']);
		expect(lines.every((line) => line.room === roomId)).toBe(true);

		const read = await session.read();
		expect(lines).toHaveLength(read.messages.length);
		await site.destroy();
	});
});

describe('roomRecordGuidance', () => {
	it('names the path convention and every message kind', () => {
		const guidance = roomRecordGuidance();
		expect(guidance).toContain('/rooms/<room name>/messages.jsonl');
		expect(guidance).toContain('room, kind, and seq');
		for (const kind of ['said', 'arrived', 'left', 'seated', 'unseated', 'summary']) {
			expect(guidance).toContain(kind);
		}
	});
});
