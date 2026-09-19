import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CreateRuntimeOptions } from '@ambionframework/ambion';
import { createAssistantMessageEventStream, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { people } from '../src/definitions.ts';
import { liveRoom, openRooms } from '../src/rooms.ts';
import { openWorkbench } from '../src/server.ts';

const mira = people.at(0);
if (!mira) throw new Error('The test team has no human.');

function quietStream(counter: { calls: number }): CreateRuntimeOptions['stream'] {
	return (_model, _context, _options) => {
		counter.calls += 1;
		const output = createAssistantMessageEventStream();
		const response = fauxAssistantMessage('quiet', { stopReason: 'stop' });
		queueMicrotask(() => {
			output.push({ type: 'start', partial: response });
			output.push({ type: 'done', reason: 'stop', message: response });
		});
		return output;
	};
}

async function request(base: string, path: string, init?: RequestInit) {
	const response = await fetch(`${base}${path}`, init);
	const text = await response.text();
	return { response, body: text ? (JSON.parse(text) as unknown) : {} };
}

async function launch(directory: string, stream: CreateRuntimeOptions['stream']) {
	const workbench = await openWorkbench(directory, 'start', stream);
	await new Promise<void>((resolve, reject) => {
		workbench.server.once('error', reject);
		workbench.server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = workbench.server.address();
	if (!address || typeof address === 'string') throw new Error('The test server did not bind.');
	return { workbench, base: `http://127.0.0.1:${address.port}` };
}

describe('Workbench room reads and recovery', () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
	});

	it('returns one coherent stopped room read and its recorded exchange', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-read-http-'));
		directories.push(directory);
		const counter = { calls: 0 };
		const { workbench, base } = await launch(join(directory, 'workbench'), quietStream(counter));
		try {
			const path = '/rooms/bringup/humans/mira';
			expect((await request(base, path, { method: 'PUT' })).response.status).toBe(200);
			const sent = await request(base, path, {
				method: 'POST',
				body: JSON.stringify({ key: 'read-1', text: 'Read this room.' }),
				headers: { 'content-type': 'application/json' },
			});
			const from = (sent.body as { from: number }).from;
			await expect
				.poll(async () => {
					const current = await request(base, '/rooms/bringup');
					const exchanges = (
						current.body as {
							exchanges?: {
								from: number;
								status: string;
								summary?: { status: string };
							}[];
						}
					).exchanges;
					const exchange = exchanges?.find((candidate) => candidate.from === from);
					return exchange?.status === 'closed' && exchange.summary?.status === 'silent';
				})
				.toBe(true);
			const beforeRead = counter.calls;
			const full = await request(base, '/rooms/bringup');
			const selected = await request(base, `/rooms/bringup?since=${from}`);
			expect(counter.calls).toBe(beforeRead);
			expect(full.body).toMatchObject({
				initialized: true,
				goal: expect.stringContaining('Bring up an Arduino Uno'),
				status: 'running',
				participants: expect.any(Array),
				exchanges: expect.any(Array),
				watermark: expect.any(Number),
			});
			expect(
				(selected.body as { messages: { seq: number }[] }).messages.every(
					(message) => message.seq > from,
				),
			).toBe(true);
			await request(base, '/rooms/bringup/stop', { method: 'POST' });
			const stopped = await request(base, '/rooms/bringup');
			const exchange = await request(base, `/rooms/bringup/exchanges/${from}`);
			expect(stopped.body).toMatchObject({ status: 'stopped', initialized: true });
			expect(exchange.response.status).toBe(200);
			expect(exchange.body).toMatchObject({
				exchange: expect.objectContaining({ from }),
				messages: expect.any(Array),
			});
			expect(counter.calls).toBe(beforeRead);
		} finally {
			await workbench.close().catch(() => undefined);
		}
	});

	it('resumes from the recorded membership and goal, not the catalog row', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-read-resume-'));
		directories.push(directory);
		const database = new DatabaseSync(join(directory, 'rooms.db'));
		const counter = { calls: 0 };
		let rooms: Awaited<ReturnType<typeof openRooms>> | undefined;
		let restarted: Awaited<ReturnType<typeof openRooms>> | undefined;
		try {
			rooms = await openRooms(database, directory, quietStream(counter));
			await rooms.create('legacy', 'Recorded goal.');
			await rooms.withRoom('legacy', async (entry) => {
				await liveRoom(entry).unseat('design');
			});
			await rooms.lifecycle('legacy', 'stop');
			await rooms.close();
			// The catalog holds a provisional goal. The journal holds the recorded one.
			database
				.prepare('UPDATE workbench_rooms SET goal = ?, enabled = 1 WHERE name = ?')
				.run('Provisional goal.', 'legacy');
			restarted = await openRooms(database, directory, quietStream(counter));
			const status = (await restarted.list())[0];
			expect(status).toMatchObject({
				initialized: true,
				goal: 'Recorded goal.',
				status: 'running',
			});
			expect(status?.participants).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ name: 'design' })]),
			);
			expect(counter.calls).toBe(0);
		} finally {
			await rooms?.close().catch(() => undefined);
			await restarted?.close().catch(() => undefined);
			database.close();
		}
	});

	it('retries startup after a failure before the initialization composition', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-read-startup-'));
		directories.push(directory);
		const database = new DatabaseSync(join(directory, 'rooms.db'));
		database.exec(
			'CREATE TABLE workbench_rooms (name TEXT PRIMARY KEY, goal TEXT NOT NULL, enabled INTEGER NOT NULL)',
		);
		database
			.prepare('INSERT INTO workbench_rooms VALUES (?, ?, 1)')
			.run('partial', 'Retry startup.');
		let failComposition = true;
		const originalPrepare = DatabaseSync.prototype.prepare;
		const replacement = function (this: DatabaseSync, query: string) {
			const statement = originalPrepare.call(this, query);
			if (!query.includes('INSERT INTO journal_entries')) return statement;
			return new Proxy(statement, {
				get(bound, method) {
					if (method !== 'all') {
						const value = Reflect.get(bound, method);
						return typeof value === 'function' ? value.bind(bound) : value;
					}
					return (...params: unknown[]) => {
						const entry = typeof params[2] === 'string' ? JSON.parse(params[2]) : undefined;
						if (failComposition && entry?.kind === 'composition') {
							failComposition = false;
							throw new Error('injected initialization write failure');
						}
						return Reflect.apply(bound.all, bound, params);
					};
				},
			});
		} as typeof DatabaseSync.prototype.prepare;
		DatabaseSync.prototype.prepare = replacement;
		const counter = { calls: 0 };
		let recovered: Awaited<ReturnType<typeof openRooms>> | undefined;
		try {
			await expect(openRooms(database, directory, quietStream(counter))).rejects.toThrow(
				/injected initialization write failure/,
			);
			recovered = await openRooms(database, directory, quietStream(counter));
			expect((await recovered.list())[0]).toMatchObject({ initialized: true, status: 'running' });
			expect(counter.calls).toBe(0);
		} finally {
			DatabaseSync.prototype.prepare = originalPrepare;
			await recovered?.close().catch(() => undefined);
			database.close();
		}
	});
});
