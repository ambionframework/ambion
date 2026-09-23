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
 * text, so the rest of the text starts after it. The last statement's rows
 * stream through `sqlResult`: a preview comes back, and an export goes to
 * the agent's files on the bash backend.
 *
 * One call is one unit of work on the shared handle. A call that leaves a
 * transaction open gets it rolled back and an `ok: false` outcome, so no
 * later call from another agent runs inside it.
 *
 * `node:sqlite` runs a statement to its end, and has no hook to stop one.
 * The backend stops a call between statements and between rows: on an
 * abort, and past the call's time limit. `sqlResult` yields to the event
 * loop as it reads rows, so an abort and a timer can fire. A single
 * statement that gives no rows runs to its end.
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
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type Context, withAbortSignal } from '@earendil-works/pi-agent-core';
import { Deadline } from './execution-env.ts';
import type {
	SqlBackend,
	SqlEnv,
	SqlOutcome,
	SqlRow,
	SqlRunOptions,
	WorkspaceFiles,
} from './sql-backend.ts';
import { sqlResult } from './sql-result.ts';

/** The in-memory location. Every agent shares it while the backend lives. */
const MEMORY = ':memory:';

/** Seconds one call may run, when the caller names no limit. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** SQLite's own action and result codes for an authorizer. */
const SQLITE_OK = 0;
const SQLITE_DENY = 1;
const SQLITE_ATTACH = 24;

/**
 * An `ATTACH` of one string literal, and the literal. The keywords match in
 * any case. The caller compares the literal exactly, because SQLite reads
 * `:memory:` in lower case alone.
 */
const ATTACH_LITERAL = /^attach\s+(?:database\s+)?('[^']*')\s+as\s+(?:\w+|"[^"]+")\s*;?\s*$/i;

/**
 * What SQLite skips before a statement: whitespace, comments, and the
 * empty statement `;`.
 */
const LEADING = /^(?:\s+|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;

/** A statement that the backend refuses, reported as an `ok: false` outcome. */
class Refusal extends Error {}

export interface SqliteBackendOptions {
	/** Seconds one call may run before the backend stops it. The default is 30. */
	timeout?: number;
}

/** `text` without what SQLite skips before its first keyword. */
function statementText(text: string): string {
	return text.replace(LEADING, '').trimEnd();
}

/** True when `text` holds no statement. */
function blank(text: string): boolean {
	return statementText(text) === '';
}

/** Why the backend refuses `statement`, or undefined when it may run. */
function refusal(statement: string): string | undefined {
	const text = statementText(statement);
	if (/^attach\b/i.test(text) && ATTACH_LITERAL.exec(text)?.[1] !== `'${MEMORY}'`) {
		return "ATTACH opens ':memory:' alone. This database cannot open another file.";
	}
	if (/^vacuum\b/i.test(text) && /\binto\b/i.test(text)) {
		return 'VACUUM INTO writes a file, and this database cannot write another file.';
	}
	return undefined;
}

type Authorizer = (action: number, first: string | null) => number;

/** Refuse, in the engine, an `ATTACH` of anything but `:memory:`. Node before 24.10 has no authorizer. */
function authorize(db: DatabaseSync): void {
	const withAuthorizer = db as DatabaseSync & { setAuthorizer?: (callback: Authorizer) => void };
	withAuthorizer.setAuthorizer?.((action, first) =>
		action === SQLITE_ATTACH && first !== MEMORY ? SQLITE_DENY : SQLITE_OK,
	);
}

/** Compile the statement at the front of `text`, refuse it if it opens a host file, and give the rest. */
function prepare(db: DatabaseSync, text: string): { statement: StatementSync; rest: string } {
	const statement = db.prepare(text);
	const source = statement.sourceSQL;
	const refused = refusal(source);
	if (refused !== undefined) throw new Refusal(refused);
	return { statement, rest: text.slice(source.length) };
}

/** The column names of `statement`, refused when two share a name: a row keeps one value per name. */
function columnsOf(statement: StatementSync): string[] {
	const columns = statement.columns().map((column) => column.name);
	const repeated = columns.find((name, index) => columns.indexOf(name) !== index);
	if (repeated !== undefined) {
		throw new Refusal(
			`The result has two columns named '${repeated}'. Give each column its own name with AS.`,
		);
	}
	return columns;
}

/** The outcome of the last statement: its preview, its count, and its export. */
function lastResult(
	statement: StatementSync,
	options: SqlRunOptions,
	files: WorkspaceFiles,
	context: Context,
): Promise<SqlOutcome> {
	const columns = columnsOf(statement);
	if (columns.length === 0) statement.run();
	const rows = columns.length === 0 ? [] : (statement.iterate() as Iterable<SqlRow>);
	return sqlResult(columns, rows, options, files, context);
}

/** Run every statement of `sql` in order, and give the outcome of the last one. */
async function runStatements(
	db: DatabaseSync,
	sql: string,
	options: SqlRunOptions,
	files: WorkspaceFiles,
	context: Context,
): Promise<SqlOutcome> {
	let rest = sql;
	while (!blank(rest)) {
		const signal = context.abortSignal;
		if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
		const next = prepare(db, rest);
		rest = next.rest;
		if (blank(rest)) return lastResult(next.statement, options, files, context);
		next.statement.run();
	}
	return sqlResult([], [], options, files, context);
}

/** True for an error the database or the backend gives about a statement. */
function statementError(error: unknown): error is Error {
	if (error instanceof Refusal) return true;
	return error instanceof Error && (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR';
}

/** Roll back a transaction that the call left open, and say so. */
function rollBackOpen(db: DatabaseSync): string | undefined {
	if (!db.isTransaction) return undefined;
	db.exec('ROLLBACK');
	return 'The call left a transaction open, so the backend rolled it back. Commit a transaction within one call.';
}

/**
 * Run one call under its time limit. A statement error and a timeout are
 * `ok: false` outcomes. An abort by the caller, and a fault of the files,
 * reject. A transaction the call left open is rolled back.
 */
async function runCall(
	db: DatabaseSync,
	sql: string,
	options: SqlRunOptions,
	files: WorkspaceFiles,
	context: Context,
	timeout: number,
): Promise<SqlOutcome> {
	const deadline = new Deadline(context.abortSignal, timeout);
	let outcome: SqlOutcome;
	try {
		outcome = await runStatements(
			db,
			sql,
			options,
			files,
			withAbortSignal(deadline.signal, context),
		);
	} catch (error) {
		const stop = deadline.error();
		if (stop?.code === 'timeout') {
			outcome = { ok: false, message: `The call ran past ${timeout} seconds, so it stopped.` };
		} else if (stop === undefined && statementError(error)) {
			outcome = { ok: false, message: error.message };
		} else {
			rollBackOpen(db);
			throw error;
		}
	} finally {
		deadline.clear();
	}
	const rolledBack = rollBackOpen(db);
	if (rolledBack === undefined) return outcome;
	return { ok: false, message: outcome.ok ? rolledBack : `${outcome.message}\n${rolledBack}` };
}

/** Open the database, and create the parent directory of a file first. */
function open(location: string): DatabaseSync {
	if (location !== MEMORY) mkdirSync(dirname(location), { recursive: true });
	const db = new DatabaseSync(location);
	authorize(db);
	return db;
}

/** Guidance for the SQLite dialect and the limits of this backend. */
function guidance(timeout: number): string {
	return [
		`The database is SQLite: dates are functions, || joins text, and a column type is an`,
		`affinity. Attach a private scratch database with ATTACH ':memory:' inside one call;`,
		`ATTACH opens no file, and VACUUM INTO is refused. Commit a transaction within the call`,
		`that begins it. A call stops after ${timeout} seconds.`,
	].join('\n');
}

/**
 * A SQL backend over one SQLite database at `location`, a host path, or
 * `:memory:`. The first `run` opens the database, and `dispose` closes it
 * and keeps the file. A host deletes the data that it owns.
 */
export function sqliteBackend(location: string, options: SqliteBackendOptions = {}): SqlBackend {
	const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	let db: DatabaseSync | undefined;
	const envFor = (files: WorkspaceFiles): SqlEnv => ({
		run: async (sql, runOptions, context) => {
			const signal = context.abortSignal;
			if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
			db ??= open(location);
			return runCall(db, sql, runOptions, files, context, timeout);
		},
		cleanup: async () => undefined,
	});
	return {
		database: location,
		guidance: guidance(timeout),
		connect: async (_agent, files) => envFor(files),
		dispose: async () => {
			db?.close();
			db = undefined;
		},
	};
}
