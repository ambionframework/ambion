import type { DatabaseSync } from 'node:sqlite';
import type { Sql, SqlValue } from '@ambionframework/journal';

/** The `Sql` of the journal and the canvas stores, over one SQLite database. */
export function sqlOf(database: DatabaseSync): Sql {
	return {
		run: (query, ...params) => {
			database.prepare(query).run(...params);
		},
		all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
	};
}
