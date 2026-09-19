/** SQLite storage for named journal entries. */
import {
	type JournalOpener,
	type JournalRead,
	type JournalStorage,
	positionRead,
	type StoragePosition,
	type StoredEntry,
} from './storage.ts';

/** What a bound parameter and a column hold. */
export type SqlValue = string | number | null;

/** The two calls SQLite journal storage needs from a host. */
export interface Sql {
	run(query: string, ...params: SqlValue[]): void;
	all(query: string, ...params: SqlValue[]): Record<string, SqlValue>[];
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS journal_entries (
	journal TEXT NOT NULL,
	position INTEGER NOT NULL,
	entry TEXT NOT NULL,
	PRIMARY KEY (journal, position)
)`;

class SqliteJournal implements JournalStorage {
	constructor(
		private readonly sql: Sql,
		private readonly name: string,
	) {}

	async read(after: StoragePosition): Promise<JournalRead> {
		const entries = this.sql
			.all(
				'SELECT position, entry FROM journal_entries WHERE journal = ? AND position > ? ORDER BY position ASC',
				this.name,
				after,
			)
			.map((row) => ({ position: Number(row.position), entry: JSON.parse(String(row.entry)) }));
		return { entries, position: positionRead(after, entries.at(-1)?.position) };
	}

	async append(
		entry: unknown,
		expectedPosition: StoragePosition,
	): Promise<StoredEntry | undefined> {
		const rows = this.sql.all(
			`INSERT INTO journal_entries (journal, position, entry)
			 SELECT ?, ?, ?
			 WHERE (SELECT COALESCE(MAX(position), 0) FROM journal_entries WHERE journal = ?) = ?
			 RETURNING position, entry`,
			this.name,
			expectedPosition + 1,
			JSON.stringify(entry),
			this.name,
			expectedPosition,
		);
		const stored = rows[0];
		return stored === undefined
			? undefined
			: { position: Number(stored.position), entry: JSON.parse(String(stored.entry)) };
	}
}

/** Named journals over one SQLite database. */
export function sqliteJournals(sql: Sql): JournalOpener {
	sql.run(SCHEMA);
	return { open: async (name) => new SqliteJournal(sql, name) };
}
