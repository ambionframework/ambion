import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { people } from '../src/definitions.ts';
import { openRooms, type RoomView } from '../src/rooms.ts';
import type { Workbench } from '../src/workbench.ts';
import { freshDirectory, openHost, quietStream, scriptedKinds } from './hosting.ts';

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
	state?: boolean;
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

function stateSave(faults: Faults, save: (...params: unknown[]) => unknown) {
	return (...params: unknown[]) => {
		if (!faults.state) return save(...params);
		faults.state = false;
		throw new Error('injected state save failure');
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
				if (method === 'all' && query.includes('UPDATE canvas_rooms SET state'))
					return stateSave(armed, bound);
				return bound;
			},
		});
	} as typeof DatabaseSync.prototype.prepare;
	onTestFinished(() => {
		DatabaseSync.prototype.prepare = original;
	});
	return armed;
}

/** The database of a rooms host. The test closes it after the hosts. */
function hostDatabase(directory: string): DatabaseSync {
	const database = new DatabaseSync(join(directory, 'rooms.db'));
	onTestFinished(() => database.close());
	return database;
}

async function hostRooms(database: DatabaseSync, directory: string, counter = { calls: 0 }) {
	const rooms = await openRooms(database, directory, {
		stream: quietStream(counter),
		executions: scriptedKinds(),
	});
	onTestFinished(() => rooms.close().catch(() => undefined));
	return rooms;
}

const departures = (view: RoomView) =>
	view.messages.filter((message) => message.kind === 'left').length;
const statusOf = async (workbench: Workbench, room: string) =>
	(await workbench.rooms()).find((candidate) => candidate.name === room)?.status;

describe('Workbench host stop recovery', () => {
	it('keeps a stopped room that failed to leave, and starts it again from its journal', async () => {
		const armed = faults();
		const counter = { calls: 0 };
		const workbench = await openHost({ stream: quietStream(counter) });
		await workbench.visit('bringup', 'mira');
		armed.departure = 'after';
		await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/acknowledgement loss/);
		expect(await statusOf(workbench, 'bringup')).toBe('stopped');
		expect((await workbench.control('bringup', 'resume')).status).toBe('running');
		expect(departures(await workbench.read('bringup', 0))).toBe(1);

		await workbench.visit('bringup', 'mira');
		armed.departure = 'before';
		await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/write failure/);
		await expect(workbench.visit('bringup', 'mira')).rejects.toThrow(/Resume this room first/);
		const repeats = await Promise.all([
			workbench.control('bringup', 'stop'),
			workbench.control('bringup', 'stop'),
		]);
		expect(repeats.map((view) => view.status)).toEqual(['stopped', 'stopped']);
		expect((await workbench.control('bringup', 'resume')).status).toBe('running');
		await workbench.visit('bringup', 'mira');
		expect(counter.calls).toBe(0);
	});

	it('reports a failed shutdown, closes the other rooms, and resumes every room at the next start', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const workbench = await openHost({ directory });
		await workbench.visit('bringup', 'mira');
		armed.departure = 'before';
		await expect(workbench.close()).resolves.toBeUndefined();
		expect(armed.departure).toBeUndefined();
		const restarted = await openHost({ directory });
		expect((await restarted.rooms()).map((room) => room.status)).toEqual([
			'running',
			'running',
			'running',
			'running',
		]);
	});

	it('keeps the room running when the save of its stopped state fails, and stops it on the retry', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const counter = { calls: 0 };
		const workbench = await openHost({ directory, stream: quietStream(counter) });
		await workbench.visit('bringup', 'mira');
		armed.state = true;
		await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/state save failure/);
		expect(await statusOf(workbench, 'bringup')).toBe('running');
		expect(departures(await workbench.read('bringup', 0))).toBe(0);
		expect((await workbench.control('bringup', 'stop')).status).toBe('stopped');
		expect(departures(await workbench.read('bringup', 0))).toBe(1);
		const rows = hostDatabase(directory)
			.prepare('SELECT state FROM canvas_rooms WHERE name = ?')
			.all('bringup') as { state: string }[];
		expect(rows[0]?.state).toBe('stopped');
		expect(counter.calls).toBe(0);
	});

	it('keeps the stopped state of a room that failed to leave across a restart', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const database = hostDatabase(directory);
		const counter = { calls: 0 };
		const first = await hostRooms(database, directory, counter);
		await first.create('review', 'Check durable stop.');
		await first.inRoom('review', (room) => room.visit(mira));
		armed.departure = 'before';
		await expect(first.lifecycle('review', 'stop')).rejects.toThrow(/write failure/);

		const restarted = await hostRooms(database, directory, counter);
		expect((await restarted.list())[0]?.status).toBe('stopped');
		expect((await restarted.lifecycle('review', 'resume')).status).toBe('running');
		expect(counter.calls).toBe(0);
	});
});

describe('Workbench room reads and recovery', () => {
	it('returns one coherent stopped room read and its recorded exchange', async () => {
		const counter = { calls: 0 };
		const workbench = await openHost({ stream: quietStream(counter) });
		await workbench.visit('bringup', 'mira');
		await workbench.send('bringup', 'mira', 'read-1', 'Read this room.');
		const closedExchange = async () => {
			const exchange = (await workbench.read('bringup', 0)).exchanges[0];
			return exchange?.status === 'closed' && exchange.summary.kind === 'silent'
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
			through: expect.any(Number),
		});
		expect(selected.messages.every((message) => message.seq > from)).toBe(true);
		await workbench.control('bringup', 'stop');
		const stopped = await workbench.read('bringup', 0);
		expect(stopped).toMatchObject({ status: 'stopped', initialized: true });
		expect(stopped.exchanges).toContainEqual(expect.objectContaining({ from, status: 'closed' }));
		expect(counter.calls).toBe(beforeRead);
	});

	it('resumes from the recorded membership and goal, not the canvas row', async () => {
		const directory = await freshDirectory();
		const database = hostDatabase(directory);
		const counter = { calls: 0 };
		const rooms = await hostRooms(database, directory, counter);
		await rooms.create('restored', 'Recorded goal.');
		await rooms.inRoom('restored', (room) => room.unseat('design'));
		await rooms.lifecycle('restored', 'stop');
		await rooms.close();
		// The canvas row holds a provisional goal. The journal holds the recorded one.
		database
			.prepare("UPDATE canvas_rooms SET goal = ?, state = 'running' WHERE name = ?")
			.run('Provisional goal.', 'restored');
		const status = (await (await hostRooms(database, directory, counter)).list())[0];
		expect(status).toMatchObject({ initialized: true, goal: 'Recorded goal.', status: 'running' });
		expect(status?.participants).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ name: 'design' })]),
		);
		expect(counter.calls).toBe(0);
	});

	it('keeps a room that fails to start as running intent, and starts it on a resume', async () => {
		const armed = faults();
		const directory = await freshDirectory();
		const database = hostDatabase(directory);
		const counter = { calls: 0 };
		const first = await hostRooms(database, directory, counter);
		armed.composition = true;
		await expect(first.create('partial', 'Retry startup.')).rejects.toThrow(
			/injected initialization write failure/,
		);
		await first.close();

		armed.composition = true;
		const restarted = await hostRooms(database, directory, counter);
		const failed = (await restarted.list())[0];
		expect(failed).toMatchObject({ initialized: false, status: 'stopped' });
		expect(failed?.activity).toContainEqual(
			expect.objectContaining({ type: 'error', text: expect.stringContaining('resume') }),
		);
		const recovered = await restarted.lifecycle('partial', 'resume');
		expect(recovered).toMatchObject({ initialized: true, status: 'running' });
		expect(counter.calls).toBe(0);
	});
});
