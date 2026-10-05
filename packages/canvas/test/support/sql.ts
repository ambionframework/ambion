import type { DatabaseSync } from 'node:sqlite';
import type { Sql, SqlValue } from '@ambionframework/journal';

/** The `Sql` of a native SQLite database, as `sqliteJournals` and `sqliteCanvas` take it. */
export const sqlOver = (database: DatabaseSync): Sql => ({
	run: (query, ...params) => {
		database.prepare(query).run(...params);
	},
	all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
});
