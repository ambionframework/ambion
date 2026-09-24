/**
 * The Durable Object's SQLite: one native journal backend for the room
 * records, and one table for the durable record of each object.
 */
import type { JournalOpener, Sql, SqlValue } from '@ambionframework/journal';
import { sqliteJournals } from '@ambionframework/journal';

/** The object's SQLite as the core reaches it. */
export function sqlOver(storage: SqlStorage): Sql {
	return {
		run(query, ...params) {
			storage.exec(query, ...params);
		},
		all(query, ...params) {
			return storage.exec(query, ...params).toArray() as Record<string, SqlValue>[];
		},
	};
}

/** One native journal backend over the object's SQLite. */
export function sqlStorage(state: DurableObjectState): JournalOpener {
	return sqliteJournals(sqlOver(state.storage.sql));
}

/** What one change does to a record: fields to set and fields to remove. */
interface MetadataUpdate<T extends object> {
	patch?: Partial<T>;
	remove?: readonly (keyof T)[];
}

/** The durable record of one object, outside its room record. */
export interface MetadataStore<T extends object> {
	/** A copy of the record. A record never written reads as `{}`. */
	read(): T;
	/**
	 * Read the record, decide an update, and write it. `undefined` writes
	 * nothing. Returns a copy of the record as it stands after the change.
	 */
	change(decide: (current: Readonly<T>) => MetadataUpdate<T> | undefined): T;
}

const METADATA = `CREATE TABLE IF NOT EXISTS ambion_metadata (
	name TEXT PRIMARY KEY,
	value TEXT NOT NULL
)`;

/**
 * One JSON record in the object's SQLite. The object runs one request at a
 * time, and `change` reads, decides, and writes with no await between them,
 * so no other request lands in between. SQLite commits the write whole, and
 * the object sends no reply before the write is durable.
 */
function metadataStore<T extends object>(sql: SqlStorage, name: string): MetadataStore<T> {
	sql.exec(METADATA);
	const read = (): T => {
		const [row] = sql.exec('SELECT value FROM ambion_metadata WHERE name = ?', name).toArray();
		return row === undefined ? ({} as T) : (JSON.parse(String(row.value)) as T);
	};
	return {
		read,
		change(decide) {
			const current = read();
			const update = decide(read());
			if (update === undefined) return current;
			const next: Record<string, unknown> = {
				...(current as Record<string, unknown>),
				...update.patch,
			};
			for (const key of update.remove ?? []) delete next[String(key)];
			sql.exec(
				`INSERT INTO ambion_metadata (name, value) VALUES (?, ?)
				ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
				name,
				JSON.stringify(next),
			);
			return read();
		},
	};
}

export interface RoomMetadata {
	name?: string;
	/** Definition names supplied for this room run. Used for automatic resume. */
	agents?: string[];
	/** A planned stop leaves the record readable without automatically resuming it. */
	stopped?: boolean;
}

export interface SeatMetadata {
	room?: string;
	seat?: string;
	activation?: string;
	phase?: 'pending' | 'running';
	wakes?: number;
	cuts?: number;
	hold?: boolean;
}

/** Durable state owned by a room object, apart from its room record. */
export function roomMetadata(state: DurableObjectState): MetadataStore<RoomMetadata> {
	return metadataStore(state.storage.sql, 'room');
}

/** Durable state owned by a seat object, apart from the room record. */
export function seatMetadata(state: DurableObjectState): MetadataStore<SeatMetadata> {
	return metadataStore(state.storage.sql, 'seat');
}
