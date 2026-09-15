/** SQLite is a real cross-handle conditional journal store, not a Pi-session wrapper. */
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { type Sql, type SqlValue, sqliteJournals } from '../src/sqlite.ts';

const sqlOver = (database: DatabaseSync): Sql => ({
	run: (query, ...params) => {
		database.prepare(query).run(...params);
	},
	all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
});

it('atomically refuses a stale append across independently opened SQLite handles', async () => {
	const database = new DatabaseSync(':memory:');
	try {
		const first = await sqliteJournals(sqlOver(database)).open('room');
		const second = await sqliteJournals(sqlOver(database)).open('room');
		const [left, right] = await Promise.all([
			first.append({ writer: 'left' }, 0),
			second.append({ writer: 'right' }, 0),
		]);
		expect([left, right].filter((entry) => entry !== undefined)).toHaveLength(1);
		expect(await first.read(0)).toMatchObject({ position: 1, entries: [{ position: 1 }] });
		const current = await second.read(0);
		const next = await second.append({ writer: 'second' }, current.position);
		expect(next).toEqual({ position: 2, entry: { writer: 'second' } });
	} finally {
		database.close();
	}
});

it('returns an entry appended after a read query on the next read', async () => {
	const database = new DatabaseSync(':memory:');
	let second: Awaited<ReturnType<ReturnType<typeof sqliteJournals>['open']>> | undefined;
	let interleave = true;
	const sql: Sql = {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => {
			const rows = database.prepare(query).all(...params) as Record<string, SqlValue>[];
			if (interleave && query.startsWith('SELECT position, entry')) {
				interleave = false;
				void second?.append({ writer: 'between reads' }, 0);
			}
			return rows;
		},
	};
	try {
		const journals = sqliteJournals(sql);
		const first = await journals.open('room');
		second = await journals.open('room');
		const firstRead = await first.read(0);
		await new Promise((resolve) => setImmediate(resolve));
		expect(firstRead).toEqual({ entries: [], position: 0 });
		expect(await first.read(firstRead.position)).toEqual({
			entries: [{ position: 1, entry: { writer: 'between reads' } }],
			position: 1,
		});
	} finally {
		database.close();
	}
});
