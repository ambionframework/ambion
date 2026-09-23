import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { people } from '../src/definitions.ts';
import { liveRoom, openRooms, type RoomView } from '../src/rooms.ts';
import type { Workbench } from '../src/workbench.ts';
import { freshDirectory, openHost, quietStream, scriptedFamilies } from './hosting.ts';

const mira = people.at(0);
if (!mira) throw new Error('The test team has no human.');

/**
 * Faults the test arms on the real SQLite storage. Each armed fault fails the
 * next matching write once. A departure fails before its write or after it,
 * as a lost acknowledgement.
 */
interface Faults {
	departure?: 'before' | 'after';
	composition?: boolean;
	catalog?: boolean;
}

function journalWrite(faults: Faults, write: (...params: unknown[]) => unknown) {
	return (...params: unknown[]) => {
		const entry = typeof params[2] === 'string' ? JSON.parse(params[2]) : undefined;
		if (faults.composition && entry?.kind === 'composition') {
			faults.composition = false;
			throw new Error('injected initialization write failure');
		}
		const departure =
			faults.departure && entry?.body?.kind === 'left' ? faults.departure : undefined;
		if (departure) faults.departure = undefined;
		if (departure === 'before') throw new Error('injected departure write failure');
		const rows = write(...params);
		if (departure === 'after') throw new Error('injected departure acknowledgement loss');
		return rows;
	};
}

function catalogSave(faults: Faults, save: (...params: unknown[]) => unknown) {
	return (...params: unknown[]) => {
		if (!faults.catalog) return save(...params);
		faults.catalog = false;
		throw new Error('injected catalog save failure');
	};
}

/** Arm faults on every SQLite statement the test prepares. The test restores SQLite when it ends. */
function faults(): Faults {
	const armed: Faults = {};
	const original = DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = function (this: DatabaseSync, query: string) {
		const statement = original.call(this, query);
		return new Proxy(statement, {
			get(target, method) {
				const value = Reflect.get(target, method);
				if (typeof value !== 'function') return value;
				const bound = value.bind(target);
				if (method === 'all' && query.includes('INSERT INTO journal_entries'))
					return journalWrite(armed, bound);
				if (method === 'run' && query.includes('UPDATE workbench_rooms'))
					return catalogSave(armed, bound);
				return bound;
			},
		});
	} as typeof DatabaseSync.prototype.prepare;
	onTestFinished(() => {
		DatabaseSync.prototype.prepare = original;
	});
	return armed;
}

/** The catalog database of a rooms host. The test closes it after the hosts. */
function catalog(directory: string): DatabaseSync {
	const database = new DatabaseSync(join(directory, 'rooms.db'));
	onTestFinished(() => database.close());
	return database;
}

async function hostRooms(database: DatabaseSync, directory: string, counter = { calls: 0 }) {
	const rooms = await openRooms(database, directory, {
		stream: quietStream(counter),
		executions: scriptedFamilies(),
	});
	onTestFinished(() => rooms.close().catch(() => undefined));
	return rooms;
}

const departures = (view: RoomView) =>
	view.messages.filter((message) => message.kind === 'left').length;
const statusOf = async (workbench: Workbench, room: string) =>
	(await workbench.rooms()).find((candidate) => candidate.name === room)?.status;

describe('Workbench host stop recovery', () => {
	it('recovers a lost stop acknowledgement, a failed stop, and a failed shutdown', async () => {
		const armed = faults();
		const counter = { calls: 0 };
		const workbench = await openHost({ stream: quietStream(counter) });
		await workbench.join('bringup', 'mira');
		armed.departure = 'after';
		await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/acknowledgement loss/);
		expect(await statusOf(workbench, 'bringup')).toBe('stopping');
		expect((await workbench.control('bringup', 'resume')).status).toBe('running');
		expect(departures(await workbench.read('bringup', 0))).toBe(1);

		await workbench.join('bringup', 'mira');
		armed.departure = 'before';
		await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/write failure/);
		await expect(workbench.join('bringup', 'mira')).rejects.toThrow(/Resume this room first/);
		expect(await statusOf(workbench, 'bringup')).toBe('stopping');
		const retries = await Promise.all([
			workbench.control('bringup', 'stop'),
			workbench.control('bringup', 'stop'),
		]);
		expect(retries.map((view) => view.status)).toEqual(['stopped', 'stopped']);
		expect(departures(await workbench.read('bringup', 0))).toBe(2);

		expect((await workbench.control('bringup', 'resume')).status).toBe('running');
		await workbench.join('bringup', 'mira');
		armed.departure = 'before';
		await expect(workbench.close()).rejects.toThrow(/write failure/);
		expect(await statusOf(workbench, 'bringup')).toBe('stopping');
		await expect(workbench.close()).resolves.toBeUndefined();
		expect(counter.calls).toBe(0);
	});

	it('retries the catalog stop intent after cleanup succeeds but its save fails', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const counter = { calls: 0 };
		const workbench = await openHost({ directory, stream: quietStream(counter) });
		await workbench.join('bringup', 'mira');
		armed.catalog = true;
		await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/catalog save failure/);
		expect(await statusOf(workbench, 'bringup')).toBe('stopped');
		expect(departures(await workbench.read('bringup', 0))).toBe(1);
		expect((await workbench.control('bringup', 'stop')).status).toBe('stopped');
		const rows = catalog(directory)
			.prepare('SELECT enabled FROM workbench_rooms WHERE name = ?')
			.all('bringup') as { enabled: number }[];
		expect(rows[0]?.enabled).toBe(0);
		expect(counter.calls).toBe(0);
	});

	it('reopens a failed stop as running intent and retries it on the next host', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const database = catalog(directory);
		const counter = { calls: 0 };
		const first = await hostRooms(database, directory, counter);
		await first.create('review', 'Check durable stop.');
		await first.withRoom('review', (entry) => liveRoom(entry).visit(mira));
		armed.departure = 'before';
		await expect(first.lifecycle('review', 'stop')).rejects.toThrow(/write failure/);

		const restarted = await hostRooms(database, directory, counter);
		expect((await restarted.list())[0]?.status).toBe('running');
		expect((await restarted.lifecycle('review', 'stop')).status).toBe('stopped');
		expect(departures(await restarted.read('review', 0))).toBe(1);
		expect(counter.calls).toBe(0);
	});
});

describe('Workbench room reads and recovery', () => {
	it('returns one coherent stopped room read and its recorded exchange', async () => {
		const counter = { calls: 0 };
		const workbench = await openHost({ stream: quietStream(counter) });
		await workbench.join('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'read-1', 'Read this room.');
		const closedExchange = async () => {
			const exchange = (await workbench.read('bringup', 0)).exchanges[0];
			return exchange?.status === 'closed' && exchange.summary.status === 'silent'
				? exchange
				: undefined;
		};
		await expect.poll(async () => (await closedExchange()) !== undefined).toBe(true);
		const from = (await closedExchange())?.from ?? 0;
		const beforeRead = counter.calls;
		const full = await workbench.read('bringup', 0);
		const selected = await workbench.read('bringup', from);
		expect(counter.calls).toBe(beforeRead);
		expect(full).toMatchObject({
			initialized: true,
			goal: expect.stringContaining('Bring up an Arduino Uno'),
			status: 'running',
			participants: expect.any(Array),
			exchanges: expect.any(Array),
			watermark: expect.any(Number),
		});
		expect(selected.messages.every((message) => message.seq > from)).toBe(true);
		await workbench.control('bringup', 'stop');
		const stopped = await workbench.read('bringup', 0);
		expect(stopped).toMatchObject({ status: 'stopped', initialized: true });
		expect(stopped.exchanges).toContainEqual(expect.objectContaining({ from, status: 'closed' }));
		expect(counter.calls).toBe(beforeRead);
	});

	it('resumes from the recorded membership and goal, not the catalog row', async () => {
		const directory = await freshDirectory();
		const database = catalog(directory);
		const counter = { calls: 0 };
		const rooms = await hostRooms(database, directory, counter);
		await rooms.create('legacy', 'Recorded goal.');
		await rooms.withRoom('legacy', (entry) => liveRoom(entry).unseat('design'));
		await rooms.lifecycle('legacy', 'stop');
		await rooms.close();
		// The catalog holds a provisional goal. The journal holds the recorded one.
		database
			.prepare('UPDATE workbench_rooms SET goal = ?, enabled = 1 WHERE name = ?')
			.run('Provisional goal.', 'legacy');
		const status = (await (await hostRooms(database, directory, counter)).list())[0];
		expect(status).toMatchObject({ initialized: true, goal: 'Recorded goal.', status: 'running' });
		expect(status?.participants).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'design' })]),
		);
		expect(counter.calls).toBe(0);
	});

	it('retries startup after a failure before the initialization composition', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const database = catalog(directory);
		database.exec(
			'CREATE TABLE workbench_rooms (name TEXT PRIMARY KEY, goal TEXT NOT NULL, enabled INTEGER NOT NULL)',
		);
		database
			.prepare('INSERT INTO workbench_rooms VALUES (?, ?, 1)')
			.run('partial', 'Retry startup.');
		armed.composition = true;
		const counter = { calls: 0 };
		await expect(hostRooms(database, directory, counter)).rejects.toThrow(
			/injected initialization write failure/,
		);
		const recovered = await hostRooms(database, directory, counter);
		expect((await recovered.list())[0]).toMatchObject({ initialized: true, status: 'running' });
		expect(counter.calls).toBe(0);
	});
});
