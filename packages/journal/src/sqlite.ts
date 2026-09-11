/**
 * Pi's `SessionStorage` over one SQLite database, reached through two
 * calls: `run` a statement, or `all` its rows. Any host that holds a
 * SQLite reaches a journal through it: a process over `node:sqlite`,
 * a Cloudflare Durable Object over its own storage. The host wraps its
 * driver in `Sql`, and the core owns the schema and every statement.
 *
 * One database holds any number of sessions, keyed by id: a room's journal,
 * and each seat's audit session beside it. It implements what the room
 * reaches — `appendCustomEntry`, `appendMessage` and `findEntries` on Pi's
 * `Session` — and refuses the rest. A lane's leaf and a session's metadata
 * are rows too, so a session reopens where it left off.
 */
import type {
	Entry,
	EntryQuery,
	LanePointer,
	Session as PiSession,
	ProvisionedEntry,
	SessionMetadata,
	SessionStorage,
} from '@earendil-works/pi-agent-core';
import { Session, SessionError } from '@earendil-works/pi-agent-core';
import type { FencedSession } from './journal.ts';

/** Opens one Pi session by id, and creates it on the first open. */
export interface SessionOpener {
	open(id: string, parentId?: string): Promise<PiSession>;
}

/** What a bound parameter and a column hold. */
export type SqlValue = string | number | null;

/** The two calls the storage makes on a SQLite: a host wraps its driver in these. */
export interface Sql {
	/** Run one statement that returns nothing. */
	run(query: string, ...params: SqlValue[]): void;
	/** Run one statement and return its rows. */
	all(query: string, ...params: SqlValue[]): Record<string, SqlValue>[];
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS entries (
		session TEXT NOT NULL,
		seq INTEGER NOT NULL,
		id TEXT NOT NULL,
		parent_id TEXT,
		lane TEXT NOT NULL,
		type TEXT NOT NULL,
		custom_type TEXT,
		timestamp INTEGER NOT NULL,
		entry TEXT NOT NULL,
		PRIMARY KEY (session, seq),
		UNIQUE (session, id)
	)`,
	`CREATE TABLE IF NOT EXISTS lanes (
		session TEXT NOT NULL,
		lane TEXT NOT NULL,
		leaf_id TEXT,
		PRIMARY KEY (session, lane)
	)`,
	`CREATE TABLE IF NOT EXISTS meta (
		session TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		PRIMARY KEY (session, key)
	)`,
];

const unsupported = (what: string) => new SessionError('storage', `${what} is not supported.`);

export class SqliteSessionStorage implements SessionStorage {
	constructor(
		private readonly sql: Sql,
		private readonly id: string,
	) {}

	/** Create the tables, and the session's row and main lane on first open. */
	static open(sql: Sql, metadata: SessionMetadata): SqliteSessionStorage {
		for (const statement of SCHEMA) sql.run(statement);
		const known = sql.all(
			'SELECT value FROM meta WHERE session = ? AND key = ?',
			metadata.id,
			'metadata',
		);
		if (known.length === 0) {
			sql.run(
				'INSERT INTO meta (session, key, value) VALUES (?, ?, ?)',
				metadata.id,
				'metadata',
				JSON.stringify(metadata),
			);
			sql.run(
				'INSERT INTO lanes (session, lane, leaf_id) VALUES (?, ?, NULL)',
				metadata.id,
				'main',
			);
		}
		return new SqliteSessionStorage(sql, metadata.id);
	}

	/** Whether the database holds a session under this id. */
	static has(sql: Sql, id: string): boolean {
		for (const statement of SCHEMA) sql.run(statement);
		return sql.all('SELECT 1 FROM meta WHERE session = ? AND key = ?', id, 'metadata').length > 0;
	}

	async getMetadata(): Promise<SessionMetadata> {
		const row = this.sql.all(
			'SELECT value FROM meta WHERE session = ? AND key = ?',
			this.id,
			'metadata',
		)[0];
		if (row === undefined) throw new SessionError('storage', `Session not found: ${this.id}`);
		return JSON.parse(String(row.value)) as SessionMetadata;
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.sql
			.all('SELECT lane, leaf_id FROM lanes WHERE session = ?', this.id)
			.map((row) => ({
				lane: String(row.lane),
				leafId: row.leaf_id === null ? null : String(row.leaf_id),
			}));
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		this.sql.run('INSERT INTO lanes (session, lane, leaf_id) VALUES (?, ?, ?)', this.id, lane, at);
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		this.sql.run('UPDATE lanes SET leaf_id = ? WHERE session = ? AND lane = ?', to, this.id, lane);
	}

	/** Append one entry to the lane's leaf, at the next seq, and move the leaf onto it. */
	async appendEntry<TEntry extends Entry>(
		newEntry: ProvisionedEntry<TEntry>,
		lane: string,
	): Promise<TEntry> {
		const pointer = this.sql.all(
			'SELECT leaf_id FROM lanes WHERE session = ? AND lane = ?',
			this.id,
			lane,
		)[0];
		if (pointer === undefined) throw new SessionError('invalid_lane', `Lane not found: ${lane}`);
		const last = this.sql.all('SELECT MAX(seq) AS seq FROM entries WHERE session = ?', this.id)[0];
		const seq = Number(last?.seq ?? 0) + 1;
		const entry = {
			...newEntry,
			parentId: pointer.leaf_id === null ? null : String(pointer.leaf_id),
			seq,
			timestamp: Date.now(),
		} as unknown as TEntry;
		this.sql.run(
			'INSERT INTO entries (session, seq, id, parent_id, lane, type, custom_type, timestamp, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
			this.id,
			seq,
			entry.id,
			entry.parentId,
			lane,
			entry.type,
			entry.type === 'custom' ? entry.customType : null,
			entry.timestamp,
			JSON.stringify(entry),
		);
		this.sql.run(
			'UPDATE lanes SET leaf_id = ? WHERE session = ? AND lane = ?',
			entry.id,
			this.id,
			lane,
		);
		return entry;
	}

	/**
	 * Append one custom entry at `expected + 1`, and only while the record's
	 * last entry is `expected`. One statement decides both: the insert takes
	 * the seq it asserts, so a writer the record moved under inserts nothing.
	 * The read back says which happened, because a `run` reports no rows.
	 */
	appendAfter(customType: string, data: unknown, expected: number): string | undefined {
		const pointer = this.sql.all(
			'SELECT leaf_id FROM lanes WHERE session = ? AND lane = ?',
			this.id,
			'main',
		)[0];
		if (pointer === undefined) throw new SessionError('invalid_lane', 'Lane not found: main');
		const seq = expected + 1;
		// The id names this write and no other. A position names none: two runs
		// that expect the same seq derive the same id, and the read back below
		// could not tell one run's entry from the other's.
		const id = crypto.randomUUID();
		const entry = {
			type: 'custom' as const,
			id,
			customType,
			data,
			parentId: pointer.leaf_id === null ? null : String(pointer.leaf_id),
			seq,
			timestamp: Date.now(),
		};
		this.sql.run(
			`INSERT INTO entries (session, seq, id, parent_id, lane, type, custom_type, timestamp, entry)
			 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
			 WHERE (SELECT COALESCE(MAX(seq), 0) FROM entries WHERE session = ?) = ?`,
			this.id,
			seq,
			id,
			entry.parentId,
			'main',
			'custom',
			customType,
			entry.timestamp,
			JSON.stringify(entry),
			this.id,
			expected,
		);
		const landed = this.sql.all('SELECT 1 FROM entries WHERE session = ? AND id = ?', this.id, id);
		if (landed.length === 0) return undefined;
		this.sql.run(
			'UPDATE lanes SET leaf_id = ? WHERE session = ? AND lane = ?',
			id,
			this.id,
			'main',
		);
		return id;
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const row = this.sql.all(
			'SELECT entry FROM entries WHERE session = ? AND id = ?',
			this.id,
			id,
		)[0];
		return row === undefined ? undefined : (JSON.parse(String(row.entry)) as Entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		const where = ['session = ?'];
		const args: SqlValue[] = [this.id];
		if (query.type !== undefined) {
			where.push('type = ?');
			args.push(query.type);
		}
		if (query.customType !== undefined) {
			where.push('custom_type = ?');
			args.push(query.customType);
		}
		const order = query.order === 'newestFirst' ? 'DESC' : 'ASC';
		// A cursor reads against the order, the way Pi's own storages do: past it oldest first, before it newest first.
		if (query.cursor !== undefined) {
			where.push(order === 'ASC' ? 'seq > ?' : 'seq < ?');
			args.push(query.cursor.afterSeq);
		}
		const limit = query.limit === undefined ? '' : ` LIMIT ${Math.floor(query.limit)}`;
		return this.sql
			.all(
				`SELECT entry FROM entries WHERE ${where.join(' AND ')} ORDER BY seq ${order}${limit}`,
				...args,
			)
			.map((row) => JSON.parse(String(row.entry)) as Entry);
	}

	async getName(): Promise<string | undefined> {
		const row = this.sql.all(
			'SELECT value FROM meta WHERE session = ? AND key = ?',
			this.id,
			'name',
		)[0];
		return row === undefined ? undefined : String(row.value);
	}

	async setName(name: string | undefined): Promise<void> {
		if (name === undefined) {
			this.sql.run('DELETE FROM meta WHERE session = ? AND key = ?', this.id, 'name');
			return;
		}
		this.sql.run(
			'INSERT OR REPLACE INTO meta (session, key, value) VALUES (?, ?, ?)',
			this.id,
			'name',
			name,
		);
	}

	findEntriesOnBranch(): never {
		throw unsupported('findEntriesOnBranch');
	}

	appendRecord(): never {
		throw unsupported('appendRecord');
	}

	findRecords(): never {
		throw unsupported('findRecords');
	}

	findOpenOperations(): never {
		throw unsupported('findOpenOperations');
	}

	getLog(): never {
		throw unsupported('getLog');
	}

	getLabel(): never {
		throw unsupported('getLabel');
	}

	setLabel(): never {
		throw unsupported('setLabel');
	}

	getStats(): never {
		throw unsupported('getStats');
	}
}

/** A `SessionOpener` over one SQLite: any id opens, and is created on the first open. */
export function sqliteSessions(sql: Sql): SessionOpener {
	/** The session, and the conditional append its storage can promise. */
	const opened = (storage: SqliteSessionStorage): Session => {
		const session = new Session(storage);
		const appendAfter: FencedSession['appendAfter'] = async (customType, data, expected) =>
			storage.appendAfter(customType, data, expected);
		return Object.assign(session, { appendAfter });
	};
	return {
		async open(id, parentId) {
			if (!SqliteSessionStorage.has(sql, id)) {
				const metadata: SessionMetadata = {
					id,
					createdAt: Date.now(),
					...(parentId === undefined ? {} : { parentSessionId: parentId }),
				};
				return opened(SqliteSessionStorage.open(sql, metadata));
			}
			return opened(new SqliteSessionStorage(sql, id));
		},
	};
}
