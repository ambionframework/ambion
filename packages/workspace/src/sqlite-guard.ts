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
 * `guardTables` finds each table by its name in any case, as SQLite does,
 * and uses the stored name. With provenance, it refuses a table that the
 * stamp cannot fill: a table WITHOUT ROWID, because the stamp finds the new
 * row by its rowid, and a provenance column with a DEFAULT, because SQLite
 * writes the DEFAULT before the insert trigger reads the row.
 *
 * `recursive_triggers` is on, so a REPLACE that deletes a row fires the
 * delete trigger. `guardRefusal` refuses a statement that lifts the guard:
 * a DROP or an ALTER of an append-only table, a DROP of a guard trigger,
 * and a PRAGMA of a guard flag. The flag `query_only` is a guard flag
 * because it stops the writes of every agent on the shared connection.
 * `guardRefusal` reads names as the SQLite tokenizer does, and refuses a
 * DROP, an ALTER, or a PRAGMA whose target it cannot read.
 *
 * Two checks of the engine state hold the guard where the text check
 * cannot. SQLite applies a flag PRAGMA when it compiles the statement, also
 * under EXPLAIN, so `flagRefusal` reads the flags after each compile and
 * sets back a flag that changed. SQLite reads an unqualified name in `temp`
 * first, and a trigger on Node 22 cannot qualify the table of its UPDATE.
 * So `shadowRefusal` runs after each statement, and drops a temporary table
 * or view with the name of an append-only table.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { SqlProvenance } from './sql-backend.ts';

/** The columns that provenance fills, when a table declares them. */
export const PROVENANCE_COLUMNS = [
	'agent',
	'room',
	'activation',
	'exchange_person',
	'exchange_from',
	'at',
] as const satisfies readonly (keyof SqlProvenance)[];

/** The function that the stamp trigger calls for the value of one column. */
const PROVENANCE_FUNCTION = 'ambion_provenance';

const LIFTS_GUARD = 'it would lift the guard of the append-only tables';

/** The flag PRAGMAs that the guard holds, and why it refuses a change of each one. */
const GUARD_FLAGS: ReadonlyMap<string, string> = new Map([
	['recursive_triggers', LIFTS_GUARD],
	['writable_schema', LIFTS_GUARD],
	['query_only', 'it would stop the writes of every agent on this database'],
]);

/**
 * One identifier as the SQLite tokenizer reads it: in double quotes, in
 * brackets, in backticks, or bare. A bare name takes each character from
 * U+0080 up as a letter.
 */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")+"|\[[^\]]+\]|\`(?:[^\`]|\`\`)+\`|[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*)`;

/** The space before an identifier: white space, or none before a quote. */
const BEFORE = String.raw`(?:\s+|(?=["\[\`]))`;

/** The space after an identifier: white space, or none after a quote. */
const AFTER = String.raw`(?:\s|(?<=["\]\`]))`;

/** An identifier with an optional schema in front. The group holds the identifier. */
const QUALIFIED = String.raw`(?:${IDENTIFIER}\s*\.\s*)?(${IDENTIFIER})`;

const TARGETS: Readonly<Record<string, RegExp>> = {
	drop: new RegExp(
		String.raw`^drop\s+(?:table|trigger|view|index)${BEFORE}(?:if\s+exists${BEFORE})?${QUALIFIED}\s*;?\s*$`,
		'i',
	),
	alter: new RegExp(String.raw`^alter\s+table${BEFORE}${QUALIFIED}${AFTER}`, 'i'),
	pragma: new RegExp(`^pragma${BEFORE}${QUALIFIED}`, 'i'),
};

/** The append-only tables of one connection, and the provenance of the running call. */
export interface Guard {
	/** The lower-case names that no statement drops or alters: the tables and their triggers. */
	readonly names: ReadonlySet<string>;
	/** The lower-case names of the append-only tables. */
	readonly tables: ReadonlySet<string>;
	/** The value of each flag PRAGMA after the guard began. */
	readonly flags: Readonly<Record<string, number>>;
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

/** One table in `main`, as SQLite stores it. */
interface Table {
	/** The stored name. */
	readonly name: string;
	/** True when the table is WITHOUT ROWID. */
	readonly withoutRowid: boolean;
	/** The names of the columns. */
	readonly columns: readonly string[];
	/** The names of the columns with a DEFAULT other than NULL. */
	readonly defaulted: readonly string[];
}

/** The table `table` in `main`, by its name in any case. Throws when no such table exists. */
function tableOf(db: DatabaseSync, table: string): Table {
	const found = db
		.prepare(
			"SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ? COLLATE NOCASE",
		)
		.get(table);
	if (found === undefined) {
		throw new Error(`sqliteBackend: the append-only table '${table}' does not exist.`);
	}
	const name = String(found.name);
	const columns = db.prepare(`PRAGMA main.table_info(${quoteName(name)})`).all();
	const defaulted = columns.filter(
		(column) => column.dflt_value !== null && String(column.dflt_value).toUpperCase() !== 'NULL',
	);
	return {
		name,
		withoutRowid: Number(found.wr) === 1,
		columns: columns.map((column) => String(column.name)),
		defaulted: defaulted.map((column) => String(column.name)),
	};
}

/** Throw when the stamp cannot fill the provenance columns `stamped` of `table`. */
function checkStamp(table: Table, stamped: readonly string[]): void {
	if (stamped.length === 0) return;
	if (table.withoutRowid) {
		throw new Error(
			`sqliteBackend: the append-only table '${table.name}' is WITHOUT ROWID, and the provenance stamp finds a new row by its rowid. Give the table a rowid, or turn provenance off.`,
		);
	}
	const defaulted = stamped.find((column) => table.defaulted.includes(column));
	if (defaulted !== undefined) {
		throw new Error(
			`sqliteBackend: the provenance column '${defaulted}' of '${table.name}' has a DEFAULT. SQLite writes the DEFAULT before the guard reads the new row, so the guard would refuse every INSERT. Remove the DEFAULT: the database fills the column.`,
		);
	}
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

/** Create the triggers of one append-only table. Give its stored name and the names of its triggers. */
function guardTable(
	db: DatabaseSync,
	wanted: string,
	provenance: boolean,
): { table: string; triggers: string[] } {
	const found = tableOf(db, wanted);
	const { name: table, columns } = found;
	const stamped = provenance ? PROVENANCE_COLUMNS.filter((name) => columns.includes(name)) : [];
	checkStamp(found, stamped);
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
	if (stamped.length === 0) return { table, triggers: [name('delete'), name('update')] };
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
	return { table, triggers: [name('delete'), name('update'), name('insert'), name('stamp')] };
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
	const tables = new Set<string>();
	if (appendOnly.length === 0) return { names, tables, flags: {}, current: undefined };
	db.exec('PRAGMA recursive_triggers = ON');
	const guard: Guard = { names, tables, flags: readFlags(db), current: undefined };
	db.function(PROVENANCE_FUNCTION, (column) => {
		const value = guard.current?.[String(column) as keyof SqlProvenance];
		return value ?? null;
	});
	for (const wanted of appendOnly) {
		const { table, triggers } = guardTable(db, wanted, provenance);
		tables.add(table.toLowerCase());
		for (const name of [table, ...triggers]) names.add(name.toLowerCase());
	}
	return guard;
}

/** The value of each flag PRAGMA of the guard, as SQLite reads it now. */
function readFlags(db: DatabaseSync): Record<string, number> {
	return Object.fromEntries(
		[...GUARD_FLAGS.keys()].map((name) => [
			name,
			Number(db.prepare(`PRAGMA ${name}`).get()?.[name]),
		]),
	);
}

/**
 * Why the statement that SQLite just compiled lifts the guard, or undefined.
 * A flag that changed gets its value back before this returns.
 */
export function flagRefusal(db: DatabaseSync, guard: Guard): string | undefined {
	if (guard.tables.size === 0) return undefined;
	const now = readFlags(db);
	const changed = [...GUARD_FLAGS.keys()].filter((name) => now[name] !== guard.flags[name]);
	for (const name of changed) db.exec(`PRAGMA ${name} = ${guard.flags[name]}`);
	const first = changed[0];
	return first === undefined ? undefined : flagMessage(first);
}

/** Why the guard refuses a PRAGMA of `name`, or undefined when `name` is not a guard flag. */
function flagMessage(name: string): string | undefined {
	const why = GUARD_FLAGS.get(name);
	return why === undefined ? undefined : `PRAGMA ${name} is refused: ${why}.`;
}

/**
 * Why the statement that just ran hides an append-only table, or undefined.
 * A temporary table or view with the name of an append-only table is dropped
 * before this returns.
 */
export function shadowRefusal(db: DatabaseSync, guard: Guard): string | undefined {
	if (guard.tables.size === 0) return undefined;
	const shadows = db
		.prepare("SELECT type, name FROM temp.sqlite_master WHERE type IN ('table', 'view')")
		.all()
		.filter((row) => guard.tables.has(String(row.name).toLowerCase()));
	for (const { type, name } of shadows) {
		db.exec(`DROP ${type === 'view' ? 'VIEW' : 'TABLE'} temp.${quoteName(String(name))}`);
	}
	const first = shadows[0];
	return first === undefined
		? undefined
		: `A temporary ${String(first.type)} named '${String(first.name)}' is refused: it would hide the append-only table.`;
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
		return `The backend cannot read the target of this ${verb}. Write the ${verb} in its plain form, with no comment inside it.`;
	}
	const name = unquoted(target);
	if (kind === 'pragma') return flagMessage(name);
	return guard.names.has(name)
		? `${verb} of '${name}' is refused: it would lift the guard of an append-only table.`
		: undefined;
}
