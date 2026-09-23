/**
 * The storages every scenario runs on.
 *
 * Every storage gives room journals and traces their own namespace. Memory
 * keeps both in process. SQLite keeps both in one database. A second
 * runtime reads either record.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	type JournalOpener,
	memoryJournals,
	namespaced,
	type Sql,
	type SqlValue,
	sqliteJournals,
} from '@ambionframework/journal';

export interface OpenedStorage {
	readonly storage: JournalOpener;
	readonly journals: JournalOpener;
	readonly dir?: string;
	dispose(): Promise<void>;
}

export interface Storage {
	readonly name: 'memory' | 'sqlite';
	open(): Promise<OpenedStorage>;
}

export const memory: Storage = {
	name: 'memory',
	async open() {
		const storage = memoryJournals();
		return {
			storage,
			journals: namespaced(storage, 'ambion/room'),
			dispose: async () => {},
		};
	},
};

/**
 * `node:sqlite` as the two calls the core's storage makes. A statement
 * runs where it is asked, so the driver never holds one back.
 */
export function nodeSql(database: DatabaseSync): Sql {
	return {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
	};
}

/** The core's storage over one database on disk, so a second runtime reads what the first wrote. */
export const sqlite: Storage = {
	name: 'sqlite',
	async open() {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-sqlite-'));
		const database = new DatabaseSync(join(dir, 'room.db'));
		const storage = sqliteJournals(nodeSql(database));
		return {
			storage,
			journals: namespaced(storage, 'ambion/room'),
			dir,
			async dispose() {
				database.close();
				await rm(dir, { recursive: true, force: true });
			},
		};
	},
};

export const storages: readonly Storage[] = [memory, sqlite];

/** The storages a room in a process of its own opens over one directory, by name. */
export function childStorage(_name: string, dir: string): JournalOpener {
	return sqliteJournals(nodeSql(new DatabaseSync(join(dir, 'room.db'))));
}

/** The durable journal a child process opens over a storage directory. */
export function childJournals(name: string, dir: string): JournalOpener {
	return namespaced(childStorage(name, dir), 'ambion/room');
}

// -- a storage that fails ----------------------------------------------------

/**
 * Called around every append a session takes: once before it lands and
 * once after. `n` counts the appends to this session id, and `customType`
 * names the entry type of a custom entry. A hook that throws fails the
 * append: before it lands, the entry is nowhere; after, the entry is on
 * the storage and the writer never learns it.
 */
export type AppendHook = (
	id: string,
	n: number,
	phase: 'before' | 'after',
	customType: string | undefined,
) => void;

/** When a write fails: before it lands, or after it landed and before the writer hears. */
export type FailMode = false | 'before' | 'after';

/** The room of a journal name: the name inside the room namespace, or the raw name. */
function roomId(name: string): string {
	try {
		const parsed: unknown = JSON.parse(name);
		if (Array.isArray(parsed) && parsed[0] === 'ambion/room' && typeof parsed[1] === 'string')
			return parsed[1];
	} catch {
		// A raw name is the name of its room.
	}
	return name;
}

/** A journal opener whose appends report around their durable boundary. */
export function tappedJournals(journals: JournalOpener, hook: AppendHook): JournalOpener {
	const counts = new Map<string, number>();
	return {
		async open(name) {
			const storage = await journals.open(name);
			const id = roomId(name);
			return {
				read: storage.read.bind(storage),
				async append(entry, expectedPosition) {
					const n = (counts.get(id) ?? 0) + 1;
					counts.set(id, n);
					const kind =
						typeof entry === 'object' && entry !== null && 'kind' in entry
							? String((entry as { kind: unknown }).kind)
							: undefined;
					hook(id, n, 'before', kind);
					const landed = await storage.append(entry, expectedPosition);
					hook(id, n, 'after', kind);
					return landed;
				},
			};
		},
	};
}

export interface FaultyJournals {
	readonly journals: JournalOpener;
	fail(on: boolean | FailMode, only?: string): void;
}

/** A journal opener whose writes fail before or after the native append. */
export function faultyJournals(journals: JournalOpener): FaultyJournals {
	let failing: FailMode = false;
	let onlyKind: string | undefined;
	return {
		journals: tappedJournals(journals, (_id, _n, phase, kind) => {
			if (failing === phase && (onlyKind === undefined || onlyKind === kind)) {
				throw new Error('the disk is full');
			}
		}),
		fail(on, only) {
			failing = on === true ? 'before' : on;
			onlyKind = only;
		},
	};
}

/** A journal opener that holds a named append until its test releases it. */
export function gatedJournals(
	journals: JournalOpener,
	held: (kind: string | undefined, entry: unknown) => Promise<void> | undefined,
): JournalOpener {
	return {
		async open(name) {
			const storage = await journals.open(name);
			return {
				read: storage.read.bind(storage),
				async append(entry, expectedPosition) {
					const kind =
						typeof entry === 'object' && entry !== null && 'kind' in entry
							? String((entry as { kind: unknown }).kind)
							: undefined;
					await held(kind, entry);
					return storage.append(entry, expectedPosition);
				},
			};
		},
	};
}
