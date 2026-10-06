/** The canvas store in the SQLite database of the host. */
import type { Sql } from '@ambionframework/journal';
import {
	archivedRoom,
	type CanvasClose,
	type CanvasRoom,
	type CanvasStore,
	type CanvasWidget,
	missingRoom,
} from './store.ts';

const SCHEMA = `CREATE TABLE IF NOT EXISTS canvas_rooms (
	position INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE,
	goal TEXT NOT NULL,
	depth INTEGER NOT NULL,
	state TEXT NOT NULL,
	start TEXT NOT NULL,
	close TEXT
)`;

const REVISIONS_SCHEMA = `CREATE TABLE IF NOT EXISTS canvas_widget_revisions (
	position INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	room TEXT NOT NULL,
	name TEXT NOT NULL,
	rev INTEGER NOT NULL,
	body TEXT NOT NULL,
	UNIQUE (room, name, rev)
)`;

const COLUMNS = 'name, goal, depth, state, start, close';

type Row = Record<string, string | number | null>;

function toRoom(row: Row): CanvasRoom {
	const room = {
		name: String(row.name),
		goal: String(row.goal),
		depth: Number(row.depth) === 1 ? 1 : 0,
		state: String(row.state),
		start: JSON.parse(String(row.start)),
	} as CanvasRoom;
	return row.close === null ? room : { ...room, close: JSON.parse(String(row.close)) };
}

/**
 * A canvas store over table `canvas_rooms`. It creates the table when absent,
 * and it shares the `Sql` of `sqliteJournals`.
 */
export function sqliteCanvas(sql: Sql): CanvasStore {
	sql.run(SCHEMA);
	sql.run(REVISIONS_SCHEMA);
	const find = (name: string): CanvasRoom => {
		const [row] = sql.all(`SELECT ${COLUMNS} FROM canvas_rooms WHERE name = ?`, name);
		if (row === undefined) throw missingRoom(name);
		return toRoom(row);
	};
	return {
		list: async () =>
			sql.all(`SELECT ${COLUMNS} FROM canvas_rooms ORDER BY position ASC`).map(toRoom),
		insert: async (room) => {
			const written = sql.all(
				`INSERT INTO canvas_rooms (name, goal, depth, state, start, close)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT (name) DO NOTHING
				 RETURNING name`,
				room.name,
				room.goal,
				room.depth,
				room.state,
				JSON.stringify(room.start),
				room.close === undefined ? null : JSON.stringify(room.close),
			);
			return written.length === 0 ? 'exists' : 'inserted';
		},
		setState: async (name, state) => {
			const changed = sql.all(
				"UPDATE canvas_rooms SET state = ? WHERE name = ? AND state != 'archived' RETURNING name",
				state,
				name,
			);
			if (changed.length > 0) return;
			find(name);
			throw archivedRoom(name);
		},
		archive: async (name, close) => {
			sql.run(
				"UPDATE canvas_rooms SET state = 'archived', close = ? WHERE name = ? AND state != 'archived'",
				JSON.stringify(close),
				name,
			);
			const recorded: CanvasClose | undefined = find(name).close;
			if (recorded === undefined) throw archivedRoom(name);
			return recorded;
		},
		revisions: async () =>
			sql
				.all('SELECT body FROM canvas_widget_revisions ORDER BY position ASC')
				.map((row): CanvasWidget => JSON.parse(String(row.body))),
		appendRevision: async (widget) => {
			const written = sql.all(
				`INSERT INTO canvas_widget_revisions (id, room, name, rev, body)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO NOTHING
				 RETURNING id`,
				widget.revision,
				widget.room,
				widget.name,
				widget.rev,
				JSON.stringify(widget),
			);
			return written.length === 0 ? 'exists' : 'inserted';
		},
	};
}
