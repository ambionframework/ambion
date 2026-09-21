import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PiExecutionOptions } from '@ambionframework/pi';
import { afterEach, describe, expect, it } from 'vitest';
import { people } from '../src/definitions.ts';
import { liveRoom, openRooms } from '../src/rooms.ts';
import { openWorkbench } from '../src/workbench.ts';
import { scriptedFamilies } from './scripted-families.ts';

type StopFailure = false | 'before' | 'after';
type WrappedDatabase = {
	database: DatabaseSync;
	setFailure: (failure: StopFailure) => void;
	setCatalogFailure: (failure: boolean) => void;
};
type FaultState = { failure: StopFailure; catalogFailure: boolean };

function wrappedDatabase(path: string): WrappedDatabase {
	const database = new DatabaseSync(path);
	const state: FaultState = { failure: false, catalogFailure: false };
	const wrapped = new Proxy(database, {
		get(target, property) {
			if (property === 'prepare')
				return (query: string) => {
					const statement = target.prepare(query);
					return wrapStatement(statement, query, state);
				};
			const value = Reflect.get(target, property);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as unknown as DatabaseSync;
	return {
		database: wrapped,
		setFailure: (next) => (state.failure = next),
		setCatalogFailure: (next) => (state.catalogFailure = next),
	};
}

function wrapStatement(
	statement: ReturnType<DatabaseSync['prepare']>,
	query: string,
	state: FaultState,
) {
	return new Proxy(statement, {
		get(bound, method) {
			if (method === 'all')
				return (...params: unknown[]) => runJournalRead(bound, query, params, state);
			if (method === 'run' && state.catalogFailure && query.includes('UPDATE workbench_rooms'))
				return () => {
					state.catalogFailure = false;
					throw new Error('injected catalog save failure');
				};
			return boundMethod(bound, method);
		},
	});
}

function runJournalRead(
	statement: ReturnType<DatabaseSync['prepare']>,
	query: string,
	params: unknown[],
	state: FaultState,
) {
	const departure = isDeparture(query, params, state.failure);
	if (departure && state.failure === 'before') throw new Error('injected departure write failure');
	const rows = Reflect.apply(statement.all, statement, params);
	if (departure) {
		state.failure = false;
		throw new Error('injected departure acknowledgement loss');
	}
	return rows;
}

function isDeparture(query: string, params: unknown[], failure: StopFailure): boolean {
	return (
		failure !== false &&
		query.includes('INSERT INTO journal_entries') &&
		typeof params[2] === 'string' &&
		JSON.parse(params[2]).body?.kind === 'left'
	);
}

function boundMethod(statement: ReturnType<DatabaseSync['prepare']>, method: string | symbol) {
	const value = Reflect.get(statement, method);
	return typeof value === 'function' ? value.bind(statement) : value;
}

const mira = people.at(0);
if (!mira) throw new Error('The test team has no human.');

function noModelStream() {
	let calls = 0;
	const stream: PiExecutionOptions['stream'] = () => {
		calls += 1;
		throw new Error('model calls are forbidden in lifecycle recovery tests');
	};
	return { stream, calls: () => calls };
}

function failNextDeparture(): { attempts: () => number; restore: () => void } {
	let pending = true;
	let count = 0;
	const original = DatabaseSync.prototype.prepare;
	const replacement = function (this: DatabaseSync, query: string) {
		const statement = original.call(this, query);
		if (!query.includes('INSERT INTO journal_entries')) return statement;
		return new Proxy(statement, {
			get(bound, method) {
				if (method === 'all')
					return (...params: unknown[]) => {
						const departure =
							pending &&
							typeof params[2] === 'string' &&
							JSON.parse(params[2]).body?.kind === 'left';
						if (departure) {
							pending = false;
							count += 1;
							throw new Error('injected departure write failure');
						}
						const value = Reflect.get(bound, method);
						if (typeof value !== 'function')
							throw new Error('SQLite statement all is unavailable.');
						return Reflect.apply(value, bound, params);
					};
				const value = Reflect.get(bound, method);
				return typeof value === 'function' ? value.bind(bound) : value;
			},
		});
	} as typeof DatabaseSync.prototype.prepare;
	DatabaseSync.prototype.prepare = replacement;
	return {
		attempts: () => count,
		restore: () => {
			DatabaseSync.prototype.prepare = original;
		},
	};
}

describe('Workbench host stop recovery', () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
	});

	it('retains a failed stop handle, retries concurrent requests, and gates admission', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'ambion-stop-recovery-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		const model = noModelStream();
		const rooms = await openRooms(wrapped.database, directory, {
			stream: model.stream,
			executions: scriptedFamilies(),
		});
		try {
			await rooms.create('review', 'Check durable stop.');
			await rooms.withRoom('review', async (entry) => {
				await liveRoom(entry).visit(mira);
			});

			wrapped.setFailure('before');
			await expect(rooms.lifecycle('review', 'stop')).rejects.toThrow(/write failure/);
			await expect(
				rooms.withRoom('review', (entry) => liveRoom(entry).visit(mira)),
			).rejects.toThrow(/Resume this room first/);
			expect((await rooms.list())[0]?.status).toBe('stopping');

			wrapped.setFailure(false);
			const [first, second] = await Promise.all([
				rooms.lifecycle('review', 'stop'),
				rooms.lifecycle('review', 'stop'),
			]);
			expect(first.status).toBe('stopped');
			expect(second.status).toBe('stopped');
			const messages = (await rooms.read('review', 0)).messages;
			expect(messages.filter((message) => message.kind === 'left')).toHaveLength(1);
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			await rooms.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('reopens a failed stop as running intent and retries it on the next host', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'ambion-stop-restart-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		let first: Awaited<ReturnType<typeof openRooms>> | undefined;
		let restarted: Awaited<ReturnType<typeof openRooms>> | undefined;
		try {
			const model = noModelStream();
			first = await openRooms(wrapped.database, directory, {
				stream: model.stream,
				executions: scriptedFamilies(),
			});
			await first.create('review', 'Check durable stop.');
			await first.withRoom('review', async (entry) => {
				await liveRoom(entry).visit(mira);
			});
			wrapped.setFailure('before');
			await expect(first.lifecycle('review', 'stop')).rejects.toThrow(/write failure/);

			wrapped.setFailure(false);
			restarted = await openRooms(wrapped.database, directory, {
				stream: model.stream,
				executions: scriptedFamilies(),
			});
			expect((await restarted.list())[0]?.status).toBe('running');
			const stopped = await restarted.lifecycle('review', 'stop');
			expect(stopped.status).toBe('stopped');
			expect(
				(await restarted.read('review', 0)).messages.filter((message) => message.kind === 'left'),
			).toHaveLength(1);
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			await first?.close().catch(() => undefined);
			await restarted?.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('retries a lost stop acknowledgement before resume and shutdown', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'ambion-stop-recovery-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		const model = noModelStream();
		const rooms = await openRooms(wrapped.database, directory, {
			stream: model.stream,
			executions: scriptedFamilies(),
		});
		try {
			await rooms.create('review', 'Check durable stop.');
			await rooms.withRoom('review', async (entry) => {
				await liveRoom(entry).visit(mira);
			});

			wrapped.setFailure('after');
			await expect(rooms.lifecycle('review', 'stop')).rejects.toThrow(/acknowledgement loss/);
			expect((await rooms.list())[0]?.status).toBe('stopping');
			wrapped.setFailure(false);
			const resumed = await rooms.lifecycle('review', 'resume');
			expect(resumed.status).toBe('running');
			expect(
				(await rooms.read('review', 0)).messages.filter((message) => message.kind === 'left'),
			).toHaveLength(1);
			await rooms.lifecycle('review', 'stop');
			await rooms.lifecycle('review', 'resume');
			wrapped.setFailure('before');
			await rooms.withRoom('review', async (entry) => {
				await liveRoom(entry).visit(mira);
			});
			await expect(rooms.close()).rejects.toThrow(/write failure/);
			expect((await rooms.list())[0]?.status).toBe('stopping');
			wrapped.setFailure(false);
			await rooms.close();
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			await rooms.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('retries the catalog stop intent after cleanup succeeds but its save fails', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'ambion-stop-catalog-'));
		directories.push(directory);
		const wrapped = wrappedDatabase(`${directory}/rooms.db`);
		let rooms: Awaited<ReturnType<typeof openRooms>> | undefined;
		try {
			const model = noModelStream();
			rooms = await openRooms(wrapped.database, directory, {
				stream: model.stream,
				executions: scriptedFamilies(),
			});
			await rooms.create('review', 'Check durable stop.');
			await rooms.withRoom('review', async (entry) => {
				await liveRoom(entry).visit(mira);
			});
			wrapped.setCatalogFailure(true);
			await expect(rooms.lifecycle('review', 'stop')).rejects.toThrow(/catalog save failure/);
			expect((await rooms.list())[0]?.status).toBe('stopped');
			expect(
				(await rooms.read('review', 0)).messages.filter((message) => message.kind === 'left'),
			).toHaveLength(1);
			const retry = await rooms.lifecycle('review', 'stop');
			expect(retry.status).toBe('stopped');
			const rows = wrapped.database
				.prepare('SELECT enabled FROM workbench_rooms WHERE name = ?')
				.all('review') as { enabled: number }[];
			expect(rows[0]?.enabled).toBe(0);
			expect(model.calls()).toBe(0);
		} finally {
			wrapped.setFailure(false);
			wrapped.setCatalogFailure(false);
			await rooms?.close().catch(() => undefined);
			wrapped.database.close();
		}
	});

	it('reports a failed stop through the host and rejects admission until a retry succeeds', async () => {
		const directory = await mkdtemp(joinPath(tmpdir(), 'ambion-host-stop-recovery-'));
		const failure = failNextDeparture();
		let modelCalls = 0;
		const stream: PiExecutionOptions['stream'] = () => {
			modelCalls += 1;
			throw new Error('model calls are forbidden in host lifecycle recovery tests');
		};
		let workbench: Awaited<ReturnType<typeof openWorkbench>> | undefined;
		try {
			workbench = await openWorkbench({
				directory: joinPath(directory, 'run'),
				stream,
				executions: scriptedFamilies(),
			});
			await workbench.join('bringup', 'mira');
			await expect(workbench.control('bringup', 'stop')).rejects.toThrow(/write failure/);
			await expect(workbench.join('bringup', 'mira')).rejects.toThrow(/Resume this room first/);
			expect((await workbench.rooms()).find((room) => room.name === 'bringup')?.status).toBe(
				'stopping',
			);
			failure.restore();
			expect((await workbench.control('bringup', 'stop')).status).toBe('stopped');
			const messages = (await workbench.read('bringup', 0)).messages;
			expect(messages.filter((message) => message.kind === 'left')).toHaveLength(1);
			expect(failure.attempts()).toBe(1);
			const shutdownFailure = failNextDeparture();
			try {
				expect((await workbench.control('bringup', 'resume')).status).toBe('running');
				await workbench.join('bringup', 'mira');
				await expect(workbench.close()).rejects.toThrow(/write failure/);
			} finally {
				shutdownFailure.restore();
			}
			await expect(workbench.close()).resolves.toBeUndefined();
			expect(modelCalls).toBe(0);
		} finally {
			failure.restore();
			await workbench?.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});
});
