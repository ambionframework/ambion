/**
 * The append-only tables of the SQLite backend, and the provenance that it
 * writes on each new row.
 *
 * `guardTables` runs at each open of the database, after the schema. For
 * each append-only table it creates temporary triggers on the one
 * connection: a DELETE fails, and an UPDATE fails. With provenance, an
 * INSERT that sets a provenance column fails, and a trigger after each
 * INSERT fills the provenance columns that the table declares from the
 * running call. The guard lets that one UPDATE through: it changes no other
 * column, it sets each provenance column from NULL to the value of the call,
 * and it touches the row that the connection inserted last.
 *
 * `recursive_triggers` is on, so a REPLACE that deletes a row fires the
 * delete trigger. `guardRefusal` refuses a statement that lifts the guard:
 * a DROP or an ALTER of an append-only table, a DROP of a guard trigger,
 * and a PRAGMA of `recursive_triggers` or `writable_schema`. It refuses a
 * DROP, an ALTER, or a PRAGMA whose target it cannot read.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SqlProvenance } from './sql-backend.ts';

/** The columns that provenance fills, when a table declares them. */
export const PROVENANCE_COLUMNS = [
	'agent',
	'room',
	'activation',
	'exchange_owner',
	'exchange_from',
	'at',
] as const satisfies readonly (keyof SqlProvenance)[];

/** The function that the stamp trigger calls for the value of one column. */
const PROVENANCE_FUNCTION = 'ambion_provenance';

/** The PRAGMAs that would lift the guard. */
const GUARD_PRAGMAS = new Set(['recursive_triggers', 'writable_schema']);

/** One identifier: in double quotes, in brackets, in backticks, or bare. */
const IDENTIFIER =
	String.raw`(?:"(?:[^"]|"")+"|\[[^\]]+\]|` + '`(?:[^`]|``)+`' + String.raw`|[A-Za-z_][\w$]*)`;

/** An identifier with an optional schema in front. The group holds the identifier. */
const QUALIFIED = String.raw`(?:${IDENTIFIER}\s*\.\s*)?(${IDENTIFIER})`;

const TARGETS: Readonly<Record<string, RegExp>> = {
	drop: new RegExp(
		String.raw`^drop\s+(?:table|trigger|view|index)\s+(?:if\s+exists\s+)?${QUALIFIED}\s*;?\s*$`,
		'i',
	),
	alter: new RegExp(String.raw`^alter\s+table\s+${QUALIFIED}\s`, 'i'),
	pragma: new RegExp(String.raw`^pragma\s+${QUALIFIED}`, 'i'),
};

/** The append-only tables of one connection, and the provenance of the running call. */
export interface Guard {
	/** The lower-case names that no statement drops or alters: the tables and their triggers. */
	readonly names: ReadonlySet<string>;
	/** The provenance of the call that runs now. */
	current: SqlProvenance | undefined;
}

/** `name` as a quoted SQL identifier. */
export function quoteName(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** `text` as a SQL string literal. */
function literal(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

/** An identifier without its quotes, in lower case, the way SQLite compares names. */
function unquoted(identifier: string): string {
	const first = identifier[0];
	const inner = identifier.slice(1, -1);
	if (first === '"') return inner.replace(/""/g, '"').toLowerCase();
	if (first === '`') return inner.replace(/``/g, '`').toLowerCase();
	if (first === '[') return inner.toLowerCase();
	return identifier.toLowerCase();
}

/** The columns of the table `table` in `main`. Throws when no such table exists. */
function columnsOf(db: DatabaseSync, table: string): string[] {
	const found = db
		.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?")
		.get(table);
	if (found === undefined) {
		throw new Error(`sqliteBackend: the append-only table '${table}' does not exist.`);
	}
	return db
		.prepare(`PRAGMA main.table_info(${quoteName(table)})`)
		.all()
		.map((column) => String(column.name));
}

/** The condition of the one UPDATE that the guard lets through: the stamp of the row just inserted. */
function stampOnly(columns: readonly string[], stamped: readonly string[]): string {
	const kept = columns
		.filter((column) => !stamped.includes(column))
		.map((column) => `NEW.${quoteName(column)} IS OLD.${quoteName(column)}`);
	const filled = stamped.map(
		(column) =>
			`OLD.${quoteName(column)} IS NULL AND NEW.${quoteName(column)} IS ${PROVENANCE_FUNCTION}(${literal(column)})`,
	);
	return [...kept, ...filled, 'NEW.rowid IS OLD.rowid', 'NEW.rowid = last_insert_rowid()'].join(
		' AND ',
	);
}

/** Create the triggers of one append-only table, and give their names. */
function guardTable(db: DatabaseSync, table: string, provenance: boolean): string[] {
	const columns = columnsOf(db, table);
	const stamped = provenance ? PROVENANCE_COLUMNS.filter((name) => columns.includes(name)) : [];
	const target = `main.${quoteName(table)}`;
	const name = (kind: string) => `ambion_${table}_${kind}`;
	const refuse = (why: string) => `SELECT RAISE(ABORT, ${literal(why)});`;
	const appendOnly = refuse(`Table '${table}' is append-only: it accepts INSERT alone.`);
	const when = stamped.length === 0 ? '' : ` WHEN NOT (${stampOnly(columns, stamped)})`;
	db.exec(
		`CREATE TEMP TRIGGER ${quoteName(name('delete'))} BEFORE DELETE ON ${target} BEGIN ${appendOnly} END`,
	);
	db.exec(
		`CREATE TEMP TRIGGER ${quoteName(name('update'))} BEFORE UPDATE ON ${target}${when} BEGIN ${appendOnly} END`,
	);
	if (stamped.length === 0) return [name('delete'), name('update')];
	const set = stamped.map((column) => `NEW.${quoteName(column)} IS NOT NULL`).join(' OR ');
	const reserved = refuse(
		`The database fills the provenance columns of '${table}': ${stamped.join(', ')}. Leave them out of the INSERT.`,
	);
	db.exec(
		`CREATE TEMP TRIGGER ${quoteName(name('insert'))} BEFORE INSERT ON ${target} WHEN ${set} BEGIN ${reserved} END`,
	);
	const values = stamped
		.map((column) => `${quoteName(column)} = ${PROVENANCE_FUNCTION}(${literal(column)})`)
		.join(', ');
	db.exec(
		`CREATE TEMP TRIGGER ${quoteName(name('stamp'))} AFTER INSERT ON ${target} BEGIN UPDATE ${quoteName(table)} SET ${values} WHERE rowid = NEW.rowid; END`,
	);
	return [name('delete'), name('update'), name('insert'), name('stamp')];
}

/**
 * Guard the tables of `appendOnly` on `db`. Each table must exist. With
 * `provenance`, an INSERT into each one gets the provenance of the running
 * call in the columns that the table declares.
 */
export function guardTables(
	db: DatabaseSync,
	appendOnly: readonly string[],
	provenance: boolean,
): Guard {
	const names = new Set<string>();
	const guard: Guard = { names, current: undefined };
	if (appendOnly.length === 0) return guard;
	db.function(PROVENANCE_FUNCTION, (column) => {
		const value = guard.current?.[String(column) as keyof SqlProvenance];
		return value ?? null;
	});
	db.exec('PRAGMA recursive_triggers = ON');
	for (const table of appendOnly) {
		for (const name of [table, ...guardTable(db, table, provenance)]) names.add(name.toLowerCase());
	}
	return guard;
}

/** Why the guard refuses `text`, one statement without its leading comments, or undefined. */
export function guardRefusal(text: string, guard: Guard): string | undefined {
	if (guard.names.size === 0) return undefined;
	const kind = /^(drop|alter|pragma)\b/i.exec(text)?.[1]?.toLowerCase();
	const pattern = kind === undefined ? undefined : TARGETS[kind];
	if (kind === undefined || pattern === undefined) return undefined;
	const target = pattern.exec(text)?.[1];
	const verb = kind.toUpperCase();
	if (target === undefined) {
		return `Write ${verb} in its plain form, with no comment inside it: the backend reads its target first.`;
	}
	const name = unquoted(target);
	if (kind === 'pragma') {
		return GUARD_PRAGMAS.has(name)
			? `PRAGMA ${name} is refused: it would lift the guard of the append-only tables.`
			: undefined;
	}
	return guard.names.has(name)
		? `${verb} of '${name}' is refused: it would lift the guard of an append-only table.`
		: undefined;
}
