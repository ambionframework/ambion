/**
 * The default SQL backend: one SQLite database through `node:sqlite`.
 *
 * `sqliteBackend(location)` opens one database file on the host, or an
 * in-memory database for `:memory:`. The file lives beside the bash
 * backend's filesystem and not in it, so the shell does not reach it. Every
 * agent connects to the same handle, so a table one agent creates is data
 * another agent reads at once.
 *
 * `run` runs the statements of one call in order. `prepare` compiles the
 * first statement of the text, and `sourceSQL` gives that statement's own
 * text, so the rest of the text starts after it. The rows of the last
 * statement come back. `node:sqlite` runs a statement to its end, so an
 * abort takes effect before the next statement.
 *
 * The database is a file on the host, so a statement must not open another
 * host file. `ATTACH` opens `:memory:` alone, and `VACUUM INTO` is refused.
 * A check of each statement's text holds this on every supported Node. On a
 * Node whose `node:sqlite` has `setAuthorizer`, the engine refuses the same
 * operations a second time. `node:sqlite` loads no extension unless its
 * caller allows it, and this backend does not.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Context } from '@earendil-works/pi-agent-core';
import type { SqlBackend, SqlEnv, SqlOutcome, SqlRow } from './sql-backend.ts';

/** The in-memory location. Every agent shares it while the backend lives. */
const MEMORY = ':memory:';

/** Guidance for the SQLite dialect and the limits of this backend. */
const GUIDANCE = [
	`The database is SQLite: dates are functions, || joins text, and a column type is an`,
	`affinity. Attach a private scratch database with ATTACH ':memory:' inside one call;`,
	`ATTACH opens no file, and VACUUM INTO is refused.`,
].join('\n');

/** SQLite's own action and result codes for an authorizer. */
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_ATTACH = 24;

/** An `ATTACH` that opens an in-memory database, and nothing else. */
const MEMORY_ATTACH =
	/^attach\s+(?:database\s+)?(?:':memory:'|'')\s+as\s+(?:\w+|"[^"]+")\s*;?\s*$/i;

/** Leading whitespace and comments, which SQLite skips before a statement. */
const LEADING = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

/** `text` without the whitespace and comments before its first keyword. */
function statementText(text: string): string {
	return text.replace(LEADING, '').trimEnd();
}

/** Why the backend refuses `statement`, or undefined when it may run. */
function refusal(statement: string): string | undefined {
	const text = statementText(statement);
	if (/^attach\b/i.test(text) && !MEMORY_ATTACH.test(text)) {
		return "ATTACH opens ':memory:' alone. This database cannot open another file.";
	}
	if (/^vacuum\b/i.test(text) && /\binto\b/i.test(text)) {
		return 'VACUUM INTO writes a file, and this database cannot write another file.';
	}
	return undefined;
}

/** True when `text` holds no statement: only whitespace and comments. */
function blank(text: string): boolean {
	return statementText(text) === '';
}

type Authorizer = (action: number, first: string | null) => number;

/** Refuse, in the engine, an `ATTACH` or a `VACUUM INTO` of a file. Node 22 has no authorizer. */
function authorize(db: DatabaseSync): void {
	const withAuthorizer = db as DatabaseSync & { setAuthorizer?: (callback: Authorizer) => void };
	withAuthorizer.setAuthorizer?.((action, first) =>
		action === SQLITE_ATTACH && first !== MEMORY && first !== '' ? SQLITE_DENY : SQLITE_OK,
	);
}

/** Run one statement at the front of `text`, and give its rows and the rest of the text. */
function step(db: DatabaseSync, text: string): { rows: SqlRow[]; rest: string } {
	const statement = db.prepare(text);
	const source = statement.sourceSQL;
	const refused = refusal(source);
	if (refused !== undefined) throw new Error(refused);
	const returnsRows = statement.columns().length > 0;
	const rows = returnsRows ? (statement.all() as SqlRow[]) : [];
	if (!returnsRows) statement.run();
	return { rows, rest: text.slice(source.length) };
}

/** Run every statement of `sql` in order, and keep the rows of the last one. */
function runAll(db: DatabaseSync, sql: string, context: Context): SqlOutcome {
	let rest = sql;
	let rows: SqlRow[] = [];
	try {
		while (!blank(rest)) {
			if (context.abortSignal?.aborted) throw abortError(context.abortSignal);
			({ rows, rest } = step(db, rest));
		}
	} catch (error) {
		if (context.abortSignal?.aborted) throw abortError(context.abortSignal);
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, rows };
}

function abortError(signal: AbortSignal): unknown {
	return signal.reason ?? new Error('Operation aborted.');
}

/** Open the database, and create the parent directory of a file first. */
function open(location: string): DatabaseSync {
	if (location !== MEMORY) mkdirSync(dirname(location), { recursive: true });
	const db = new DatabaseSync(location);
	authorize(db);
	return db;
}

/**
 * A SQL backend over one SQLite database at `location`, a host path, or
 * `:memory:`. The first `connect` opens the database, and `dispose` closes
 * it and keeps the file. A host deletes the data that it owns.
 */
export function sqliteBackend(location: string): SqlBackend {
	let db: DatabaseSync | undefined;
	const env: SqlEnv = {
		run: async (sql, context) => {
			if (context.abortSignal?.aborted) throw abortError(context.abortSignal);
			db ??= open(location);
			return runAll(db, sql, context);
		},
		cleanup: async () => undefined,
	};
	return {
		database: location,
		guidance: GUIDANCE,
		connect: async () => env,
		dispose: async () => {
			db?.close();
			db = undefined;
		},
	};
}
