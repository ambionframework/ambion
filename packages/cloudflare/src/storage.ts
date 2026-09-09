/**
 * The room's SQLite storage over a Durable Object's own SQLite. The core
 * owns the schema and every statement (`sqliteSessions`); this file wraps
 * `ctx.storage.sql` in the two calls the core makes.
 */
import type { SessionOpener, Sql, SqlValue } from '@ambionframework/ambion';
import { sqliteSessions } from '@ambionframework/ambion';

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

/** A `SessionOpener` over one object's SQLite: any id opens, and is created on the first open. */
export function sqlSessions(state: DurableObjectState): SessionOpener {
	return sqliteSessions(sqlOver(state.storage.sql));
}
