/**
 * The git storage: one SQLite file through `node:sqlite`.
 *
 * `just-git`'s `BetterSqlite3Storage` holds the objects and the refs. It
 * needs a database with `exec`, `prepare`, and `transaction`, and
 * `node:sqlite` has no `transaction`, so a small wrapper gives it one.
 *
 * The same file holds `ambion_repositories`, the registry: what `just-git`
 * storage does not keep. That is the list of repositories, the direct
 * source of each fork, the description of each template, and a state,
 * `forking` or `ready`. A fork writes its row as `forking` before
 * `forkRepo` runs, and marks it `ready` after. `forkRepo` runs its own
 * transactions, so one transaction cannot hold both writes.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BetterSqlite3Storage, type Storage } from 'just-git/server';

/** One row of the registry. */
export interface RegistryRow {
	readonly id: string;
	readonly source?: string;
	readonly description?: string;
	readonly state: 'forking' | 'ready';
}

/** The registry of the repositories in one git storage. */
export interface Registry {
	/** Every row, in ID order. */
	all(): readonly RegistryRow[];
	get(id: string): RegistryRow | undefined;
	/** Write the row of a repository that is on its way. */
	begin(id: string, source: string | undefined, description: string | undefined): void;
	ready(id: string): void;
	remove(id: string): void;
}

/** An open git storage: the `just-git` storage and the registry over one database. */
export interface OpenGitStorage {
	readonly storage: Storage;
	readonly registry: Registry;
	close(): void;
}

/** Where a git backend keeps its repositories. `gitBackend` opens it on first use. */
export interface GitStorage {
	/** The file path, or `':memory:'`. */
	readonly location: string;
	open(): OpenGitStorage;
}

const REGISTRY = `CREATE TABLE IF NOT EXISTS ambion_repositories (
	id TEXT PRIMARY KEY,
	source TEXT,
	description TEXT,
	state TEXT NOT NULL CHECK (state IN ('forking', 'ready'))
)`;

type Row = { id: string; source: string | null; description: string | null; state: string };

function rowOf(row: Row): RegistryRow {
	return {
		id: row.id,
		...(row.source === null ? {} : { source: row.source }),
		...(row.description === null ? {} : { description: row.description }),
		state: row.state === 'forking' ? 'forking' : 'ready',
	};
}

function registryOver(db: DatabaseSync): Registry {
	db.exec(REGISTRY);
	const all = db.prepare(
		'SELECT id, source, description, state FROM ambion_repositories ORDER BY id',
	);
	const one = db.prepare(
		'SELECT id, source, description, state FROM ambion_repositories WHERE id = ?',
	);
	const insert = db.prepare(
		`INSERT INTO ambion_repositories (id, source, description, state) VALUES (?, ?, ?, 'forking')`,
	);
	const markReady = db.prepare(`UPDATE ambion_repositories SET state = 'ready' WHERE id = ?`);
	const remove = db.prepare('DELETE FROM ambion_repositories WHERE id = ?');
	return {
		all: () => (all.all() as Row[]).map(rowOf),
		get: (id) => {
			const row = one.get(id) as Row | undefined;
			return row === undefined ? undefined : rowOf(row);
		},
		begin: (id, source, description) => {
			insert.run(id, source ?? null, description ?? null);
		},
		ready: (id) => {
			markReady.run(id);
		},
		remove: (id) => {
			remove.run(id);
		},
	};
}

/** `node:sqlite` in the shape `BetterSqlite3Storage` reads: `exec`, `prepare`, and `transaction`. */
function asBetterSqlite3(db: DatabaseSync) {
	return {
		exec: (sql: string) => db.exec(sql),
		prepare: (sql: string) => db.prepare(sql),
		transaction:
			<A extends unknown[], R>(fn: (...args: A) => R) =>
			(...args: A): R => {
				db.exec('BEGIN');
				try {
					const result = fn(...args);
					db.exec('COMMIT');
					return result;
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}
			},
	};
}

/**
 * Keep every repository in one SQLite file at `location`, or in memory with
 * `':memory:'`. The first use creates the file and its directory. The
 * backend's `dispose` closes the database and keeps the file.
 */
export function sqliteGitStorage(location: string): GitStorage {
	return Object.freeze({
		location,
		open: (): OpenGitStorage => {
			if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true });
			const db = new DatabaseSync(location);
			return {
				storage: new BetterSqlite3Storage(asBetterSqlite3(db)),
				registry: registryOver(db),
				close: () => db.close(),
			};
		},
	});
}
