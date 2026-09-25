/**
 * The room mirror over a `Room` double that a test drives by hand: the
 * backfill, the resume, live messages, and each failure path. A mirror of a
 * running room is in `workspace.test.ts`.
 */
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
import { BACKGROUND_CONTEXT, type ExecutionEnv } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { roomName as name } from '../../ambion/test/support/room.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { openWorkspace } from '../src/index.ts';
import type { WorkspaceAgent } from '../src/resource.ts';

const reader: WorkspaceAgent = { name: 'reader' };

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
				scheduled: [],
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
	it('backfills the full backlog in order on a fresh log, and resumes from the highest seq on disk', async () => {
		const site = openWorkspace({ name: name('fresh'), backend: { bash: memoryBackend() } });
		const backlog = [said(1, 'one'), said(2, 'two'), said(3, 'three')];

		const first = await site.mirror(fakeRoom('lobby', backlog));
		expect(first.path).toBe('/rooms/lobby/messages.jsonl');
		await first.stop();
		const texts = async () =>
			(await site.use(reader, (env) => readLines(env, first.path))).map((line) => line.text);
		expect(await texts()).toEqual(['one', 'two', 'three']);
		// A file beside the log that no rotation made does not count: its
		// higher seq would hide message 4 from the resume.
		await site.use(reader, (env) =>
			env.writeFile(`${first.path}.bak`, `${JSON.stringify({ seq: 9 })}\n`, BACKGROUND_CONTEXT),
		);
		// A fresh call, as a restarted host would make: no in-memory state survives.
		const second = await site.mirror(fakeRoom('lobby', [...backlog, said(4, 'four')]));
		await second.stop();

		const lines = await site.use(reader, (env) => readLines(env, second.path));
		expect(lines.map((line) => [line.seq, line.text])).toEqual([
			[1, 'one'],
			[2, 'two'],
			[3, 'three'],
			[4, 'four'],
		]);
		expect(lines.every((line) => line.room === 'lobby')).toBe(true);
		await site.dispose();
	});

	it('appends a live message after the backfill, drops one already written, and ignores one once stopped', async () => {
		const site = openWorkspace({ name: name('live'), backend: { bash: memoryBackend() } });
		const room = fakeRoom('lobby', [said(1, 'one'), said(2, 'two')]);

		const mirror = await site.mirror(room);
		room.emit({ type: 'message', message: said(2, 'two') });
		room.emit({ type: 'message', message: said(3, 'three') });
		await mirror.stop();
		room.emit({ type: 'message', message: said(4, 'four') });
		await mirror.stop();

		const lines = await site.use(reader, (env) => readLines(env, mirror.path));
		expect(lines.map((line) => line.text)).toEqual(['one', 'two', 'three']);
		await site.dispose();
	});
	it('does not drop a message published while the backfill read is still in flight', async () => {
		// A room settles its read only once every queued append has landed, so
		// it can publish a message to a brand-new subscriber before that same
		// read resolves with the message already included. Appending it right
		// away would mark it accounted for before the backfill loop runs, and
		// the loop would then skip it as already written: gone for good.
		const site = openWorkspace({ name: name('race'), backend: { bash: memoryBackend() } });
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

	it('reports a write failure to onError, and keeps running', async () => {
		const site = openWorkspace({ name: name('write-fails'), backend: { bash: memoryBackend() } });
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
		const site = openWorkspace({ name: name('escape'), backend: { bash: memoryBackend() } });
		const room = fakeRoom('../escape', []);

		await expect(site.mirror(room)).rejects.toThrow(/room name/i);
		await site.dispose();
	});

	it('unsubscribes before rejecting when the backfill read itself fails', async () => {
		const site = openWorkspace({ name: name('read-fails'), backend: { bash: memoryBackend() } });
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
});
