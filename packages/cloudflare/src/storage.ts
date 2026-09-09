/**
 * Pi's `SessionStorage` over a Durable Object's SQLite.
 *
 * One storage holds any number of sessions, keyed by id: the room object
 * holds the room's session, and a seat object holds its own audit session.
 * It implements what the room reaches — `appendCustomEntry`,
 * `appendMessage` and `findEntries` on Pi's `Session` — and refuses the
 * rest. A lane's leaf and a session's metadata are rows too, so a session
 * reopens where it left off.
 */
import type { SessionOpener } from '@ambionframework/ambion';
import type {
	Entry,
	EntryQuery,
	LanePointer,
	ProvisionedEntry,
	SessionMetadata,
	SessionStorage,
} from '@earendil-works/pi-agent-core';
import { Session, SessionError } from '@earendil-works/pi-agent-core';

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
		private readonly sql: SqlStorage,
		private readonly id: string,
	) {}

	/** Create the tables, and the session's row and main lane on first open. */
	static open(sql: SqlStorage, metadata: SessionMetadata): SqliteSessionStorage {
		for (const statement of SCHEMA) sql.exec(statement);
		const known = sql
			.exec('SELECT value FROM meta WHERE session = ? AND key = ?', metadata.id, 'metadata')
			.toArray();
		if (known.length === 0) {
			sql.exec(
				'INSERT INTO meta (session, key, value) VALUES (?, ?, ?)',
				metadata.id,
				'metadata',
				JSON.stringify(metadata),
			);
			sql.exec(
				'INSERT INTO lanes (session, lane, leaf_id) VALUES (?, ?, NULL)',
				metadata.id,
				'main',
			);
		}
		return new SqliteSessionStorage(sql, metadata.id);
	}

	/** Whether the storage holds a session under this id. */
	static has(sql: SqlStorage, id: string): boolean {
		for (const statement of SCHEMA) sql.exec(statement);
		return (
			sql.exec('SELECT 1 FROM meta WHERE session = ? AND key = ?', id, 'metadata').toArray()
				.length > 0
		);
	}

	async getMetadata(): Promise<SessionMetadata> {
		const row = this.sql
			.exec('SELECT value FROM meta WHERE session = ? AND key = ?', this.id, 'metadata')
			.one();
		return JSON.parse(String(row.value)) as SessionMetadata;
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.sql
			.exec('SELECT lane, leaf_id FROM lanes WHERE session = ?', this.id)
			.toArray()
			.map((row) => ({
				lane: String(row.lane),
				leafId: row.leaf_id === null ? null : String(row.leaf_id),
			}));
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		this.sql.exec('INSERT INTO lanes (session, lane, leaf_id) VALUES (?, ?, ?)', this.id, lane, at);
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		this.sql.exec('UPDATE lanes SET leaf_id = ? WHERE session = ? AND lane = ?', to, this.id, lane);
	}

	/** Append one entry to the lane's leaf, at the next seq, and move the leaf onto it. */
	async appendEntry<TEntry extends Entry>(
		newEntry: ProvisionedEntry<TEntry>,
		lane: string,
	): Promise<TEntry> {
		const pointer = this.sql
			.exec('SELECT leaf_id FROM lanes WHERE session = ? AND lane = ?', this.id, lane)
			.toArray()[0];
		if (pointer === undefined) throw new SessionError('invalid_lane', `Lane not found: ${lane}`);
		const last = this.sql
			.exec('SELECT MAX(seq) AS seq FROM entries WHERE session = ?', this.id)
			.one();
		const seq = Number(last.seq ?? 0) + 1;
		const entry = {
			...newEntry,
			parentId: pointer.leaf_id === null ? null : String(pointer.leaf_id),
			seq,
			timestamp: Date.now(),
		} as unknown as TEntry;
		this.sql.exec(
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
		this.sql.exec(
			'UPDATE lanes SET leaf_id = ? WHERE session = ? AND lane = ?',
			entry.id,
			this.id,
			lane,
		);
		return entry;
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const row = this.sql
			.exec('SELECT entry FROM entries WHERE session = ? AND id = ?', this.id, id)
			.toArray()[0];
		return row === undefined ? undefined : (JSON.parse(String(row.entry)) as Entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		const where = ['session = ?'];
		const args: (string | number)[] = [this.id];
		if (query.type !== undefined) {
			where.push('type = ?');
			args.push(query.type);
		}
		if (query.customType !== undefined) {
			where.push('custom_type = ?');
			args.push(query.customType);
		}
		if (query.cursor !== undefined) {
			where.push('seq > ?');
			args.push(query.cursor.afterSeq);
		}
		const order = query.order === 'newestFirst' ? 'DESC' : 'ASC';
		const limit = query.limit === undefined ? '' : ` LIMIT ${Math.floor(query.limit)}`;
		return this.sql
			.exec(
				`SELECT entry FROM entries WHERE ${where.join(' AND ')} ORDER BY seq ${order}${limit}`,
				...args,
			)
			.toArray()
			.map((row) => JSON.parse(String(row.entry)) as Entry);
	}

	async getName(): Promise<string | undefined> {
		const row = this.sql
			.exec('SELECT value FROM meta WHERE session = ? AND key = ?', this.id, 'name')
			.toArray()[0];
		return row === undefined ? undefined : String(row.value);
	}

	async setName(name: string | undefined): Promise<void> {
		if (name === undefined)
			this.sql.exec('DELETE FROM meta WHERE session = ? AND key = ?', this.id, 'name');
		else
			this.sql.exec(
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

/** A `SessionOpener` over one object's SQLite: any id opens, and is created on the first open. */
export function sqlSessions(state: DurableObjectState): SessionOpener {
	return {
		async open(id, parentId) {
			const sql = state.storage.sql;
			if (!SqliteSessionStorage.has(sql, id)) {
				const metadata: SessionMetadata = {
					id,
					createdAt: Date.now(),
					...(parentId === undefined ? {} : { parentSessionId: parentId }),
				};
				return new Session(SqliteSessionStorage.open(sql, metadata));
			}
			return new Session(new SqliteSessionStorage(sql, id));
		},
	};
}
