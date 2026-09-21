import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One table of a database, as the preview shows it: its first rows. */
export interface TableView {
	name: string;
	columns: string[];
	rows: string[][];
	/** The number of rows in the table, which can exceed the rows shown. */
	count: number;
}

const HEADER = 'SQLite format 3\0';
const MAX_TABLES = 30;
const MAX_ROWS = 50;
const MAX_CELL = 60;

export const isDatabasePath = (path: string): boolean => /\.(db|sqlite3?)$/i.test(path);

export const isDatabase = (bytes: Uint8Array): boolean =>
	new TextDecoder('latin1').decode(bytes.subarray(0, HEADER.length)) === HEADER;

/** Show any value as one short line of text. */
function cell(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (value instanceof Uint8Array) return `<blob ${value.length} B>`;
	const text = String(value).replace(/\s+/g, ' ');
	return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL - 1)}…` : text;
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function readTable(database: DatabaseSync, name: string): TableView {
	const columns = database
		.prepare(`PRAGMA table_info(${quote(name)})`)
		.all()
		.map((column) => String(column.name));
	const counted = database.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get();
	const select = database.prepare(`SELECT * FROM ${quote(name)} LIMIT ${MAX_ROWS}`);
	select.setReadBigInts(true);
	const rows = select.all().map((row) => columns.map((column) => cell(row[column])));
	return { name, columns, rows, count: Number(counted?.n ?? 0) };
}

function listNames(database: DatabaseSync): string[] {
	return database
		.prepare(
			`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ${MAX_TABLES}`,
		)
		.all()
		.map((table) => String(table.name));
}

/** The tables of a database, read-only, with the first rows of each. */
export async function readTables(bytes: Uint8Array): Promise<TableView[]> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-db-'));
	try {
		const file = join(directory, 'preview.db');
		await writeFile(file, bytes);
		const database = new DatabaseSync(file, { readOnly: true });
		try {
			return listNames(database).map((name) => readTable(database, name));
		} finally {
			database.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** A plain-text copy of the tables, tab separated, for the clipboard. */
export function tablesText(tables: readonly TableView[]): string {
	return tables
		.map((table) =>
			[
				`# ${table.name} (${table.count} rows)`,
				table.columns.join('\t'),
				...table.rows.map((row) => row.join('\t')),
			].join('\n'),
		)
		.join('\n\n');
}

/** The names of the tables of a database file, read-only. */
export function tableNames(location: string): string[] {
	const database = new DatabaseSync(location, { readOnly: true });
	try {
		return listNames(database);
	} finally {
		database.close();
	}
}

/** One table of a database file, read-only. The name must be one that the database lists. */
export function readNamedTable(location: string, name: string): TableView | undefined {
	const database = new DatabaseSync(location, { readOnly: true });
	try {
		return listNames(database).includes(name) ? readTable(database, name) : undefined;
	} finally {
		database.close();
	}
}
