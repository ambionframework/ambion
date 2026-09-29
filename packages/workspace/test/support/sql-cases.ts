/**
 * The cases of the SQLite backend as a `SqlBackend`: the preview and the
 * count of the last statement, an export through `WorkspaceFiles`, an
 * import through `WorkspaceFiles` that lives for one run, a refused
 * statement as an outcome, one database for every agent, and an abort
 * before the first statement. They run on SQLite in memory and on a file
 * (`test/sqlite.test.ts`). A second SQL backend would run them too, and
 * they would then move back to the conformance entry.
 */

import type { ConformanceCase } from '@ambionframework/ambion/conformance';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import type {
	SqlBackend,
	SqlEnv,
	SqlOutcome,
	SqlRunOptions,
	WorkspaceFiles,
} from '../../src/sql-backend.ts';

const ctx = BACKGROUND_CONTEXT;

function check(condition: boolean, what: string): void {
	if (!condition) throw new Error(what);
}

/** A SQL backend under test. `open` runs inside every case. */
export interface SqlHarness {
	readonly name: string;
	open(): Promise<{ backend: SqlBackend; dispose(): Promise<void> }>;
}

/** The files a case hands the backend: an in-memory map, keyed by absolute path. */
interface CaseFiles {
	forAgent(agent: string): WorkspaceFiles;
	read(path: string): string | undefined;
	write(path: string, text: string): void;
}

/** In-memory `WorkspaceFiles`. A file lands only after every chunk arrives. */
function caseFiles(): CaseFiles {
	const stored = new Map<string, string>();
	const absolute = (agent: string, path: string): string => {
		if (path.startsWith('/')) return path;
		const relative = path.startsWith('~/') ? path.slice(2) : path;
		return `/home/${agent}/${relative}`;
	};
	return {
		forAgent: (agent) => ({
			readFile: async (path, maxBytes) => {
				const target = absolute(agent, path);
				const text = stored.get(target);
				if (text === undefined) return { ok: false, message: `No file at ${target}.` };
				if (Buffer.byteLength(text) > maxBytes) {
					return { ok: false, message: `${target} is too large.` };
				}
				return { ok: true, path: target, text };
			},
			writeFile: async (path, chunks) => {
				let text = '';
				for await (const chunk of chunks) text += chunk;
				const target = absolute(agent, path);
				stored.set(target, text);
				return target;
			},
		}),
		read: (path) => stored.get(path),
		write: (path, text) => {
			stored.set(path, text);
		},
	};
}

interface SqlCase {
	connect(agent: string): Promise<SqlEnv>;
	readonly files: CaseFiles;
}

type SqlBody = (sql: SqlCase) => Promise<void>;

const PREVIEW = { maxRows: 50 };

/** The rows of `outcome`, or a failure that names the database's message. */
function okOf(outcome: SqlOutcome, what: string): Extract<SqlOutcome, { ok: true }> {
	if (!outcome.ok) throw new Error(`${what}: ${outcome.message}`);
	return outcome;
}

/** Run `sql` on one connection of `agent`, and clean the connection up. */
async function runAs(
	sql: SqlCase,
	agent: string,
	text: string,
	options: SqlRunOptions = PREVIEW,
): Promise<SqlOutcome> {
	const env = await sql.connect(agent);
	try {
		return await env.run(text, options, ctx);
	} finally {
		await env.cleanup();
	}
}

async function count(sql: SqlCase, table: string): Promise<number> {
	const outcome = okOf(
		await runAs(sql, 'conformance', `SELECT count(*) AS n FROM ${table}`),
		'count',
	);
	return Number(outcome.rows[0]?.n);
}

async function lastStatementRows(sql: SqlCase): Promise<void> {
	const outcome = okOf(
		await runAs(
			sql,
			'conformance',
			"CREATE TABLE t (id INTEGER, label TEXT); INSERT INTO t VALUES (1, 'a'), (2, NULL); SELECT id, label FROM t ORDER BY id",
		),
		'the run failed',
	);
	check(outcome.columns.join(',') === 'id,label', 'the columns are wrong');
	check(
		outcome.rowCount === 2 && outcome.rows.length === 2,
		'expected 2 rows of the last statement',
	);
	check(
		Number(outcome.rows[0]?.id) === 1 && outcome.rows[0]?.label === 'a',
		'the first row is wrong',
	);
	check(outcome.rows[1]?.label === null, 'a NULL value did not come back as null');
}

async function noRowsFromLastStatement(sql: SqlCase): Promise<void> {
	const outcome = okOf(
		await runAs(sql, 'conformance', 'CREATE TABLE u (x); INSERT INTO u VALUES (1)'),
		'the run failed',
	);
	check(outcome.columns.length === 0, 'a last statement with no result gave columns');
	check(
		outcome.rows.length === 0 && outcome.rowCount === 0,
		'a last statement with no result gave rows',
	);
	check((await count(sql, 'u')) === 1, 'an earlier statement did not run');
}

async function previewCap(sql: SqlCase): Promise<void> {
	okOf(
		await runAs(
			sql,
			'conformance',
			'CREATE TABLE p (x); INSERT INTO p VALUES (1), (2), (3), (4), (5)',
		),
		'the run failed',
	);
	const outcome = okOf(
		await runAs(sql, 'conformance', 'SELECT x FROM p ORDER BY x', { maxRows: 2 }),
		'the query failed',
	);
	check(outcome.rows.length === 2, `maxRows 2 gave ${outcome.rows.length} rows`);
	check(outcome.rowCount === 5, `rowCount is ${outcome.rowCount}, not 5`);
}

async function exportThroughFiles(sql: SqlCase): Promise<void> {
	okOf(
		await runAs(
			sql,
			'conformance',
			`CREATE TABLE e (id INTEGER, note TEXT); INSERT INTO e VALUES (1, 'a, "b"'), (2, NULL), (3, 'x\ny')`,
		),
		'the run failed',
	);
	const outcome = okOf(
		await runAs(sql, 'conformance', 'SELECT id, note FROM e ORDER BY id', {
			maxRows: 1,
			export: 'out/e.csv',
		}),
		'the export failed',
	);
	const path = '/home/conformance/out/e.csv';
	check(outcome.export === path, `the export path is ${outcome.export}`);
	check(outcome.rows.length === 1 && outcome.rowCount === 3, 'the export gave the wrong preview');
	const text = sql.files.read(path);
	const expected = 'id,note\n1,"a, ""b"""\n2,\\N\n3,"x\ny"\n';
	check(text === expected, `the CSV file is ${JSON.stringify(text)}`);
}

async function importThroughFiles(sql: SqlCase): Promise<void> {
	const path = '/home/conformance/in/e.csv';
	sql.files.write(path, 'id,note\n1,"a, ""b"""\n2,\\N\n3,"x\ny"\n');
	const outcome = okOf(
		await runAs(
			sql,
			'conformance',
			`CREATE TABLE f (id INTEGER, note TEXT);
INSERT INTO f SELECT CAST(id AS INTEGER), note FROM import.rows;
SELECT id, note FROM f ORDER BY id`,
			{ maxRows: 50, import: 'in/e.csv' },
		),
		'the import failed',
	);
	check(outcome.import?.path === path, `the import path is ${outcome.import?.path}`);
	check(outcome.import?.rows === 3, `the import staged ${outcome.import?.rows} rows`);
	const notes = JSON.stringify(outcome.rows.map((row) => row.note));
	check(notes === JSON.stringify(['a, "b"', null, 'x\ny']), `the imported notes are ${notes}`);
	check(Number(outcome.rows[2]?.id) === 3, 'the imported id did not CAST');
	const later = await runAs(sql, 'conformance', 'SELECT * FROM import.rows');
	check(!later.ok, 'a later run reads the rows of an import');
}

async function refusedImportRunsNothing(sql: SqlCase): Promise<void> {
	okOf(await runAs(sql, 'conformance', 'CREATE TABLE g (x)'), 'the run failed');
	sql.files.write('/home/conformance/bad.csv', 'x,y\n1,2\n3\n');
	for (const file of ['bad.csv', 'missing.csv']) {
		const outcome = await runAs(sql, 'conformance', 'INSERT INTO g VALUES (1)', {
			maxRows: 50,
			import: file,
		});
		check(!outcome.ok && outcome.message.length > 0, `the import of ${file} gave an ok outcome`);
	}
	check((await count(sql, 'g')) === 0, 'a statement ran after a refused import');
}

async function failedExportWritesNothing(sql: SqlCase): Promise<void> {
	const outcome = await runAs(sql, 'conformance', 'SELECT * FROM missing_table', {
		maxRows: 50,
		export: 'out/none.csv',
	});
	check(!outcome.ok, 'a refused statement gave an ok outcome');
	check(
		sql.files.read('/home/conformance/out/none.csv') === undefined,
		'a failed run wrote a file',
	);
}

async function refusedStatement(sql: SqlCase): Promise<void> {
	const outcome = await runAs(
		sql,
		'conformance',
		'CREATE TABLE v (x); SELECT * FROM missing_table; INSERT INTO v VALUES (1)',
	);
	check(!outcome.ok, 'a refused statement gave an ok outcome');
	check(!outcome.ok && outcome.message.length > 0, 'a refused statement gave no message');
	check((await count(sql, 'v')) === 0, 'a statement after the refused one ran');
}

async function oneDatabaseForEveryAgent(sql: SqlCase): Promise<void> {
	okOf(
		await runAs(sql, 'ada', "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('hi')"),
		'ada could not write',
	);
	const outcome = okOf(await runAs(sql, 'bob', 'SELECT body FROM notes'), 'bob could not read');
	check(outcome.rows[0]?.body === 'hi', 'bob does not read what ada wrote');
}

async function abortBeforeRun(sql: SqlCase): Promise<void> {
	okOf(await runAs(sql, 'conformance', 'CREATE TABLE w (x)'), 'the run failed');
	const controller = new AbortController();
	controller.abort();
	const env = await sql.connect('conformance');
	try {
		const aborted = withAbortSignal(controller.signal, ctx);
		const rejected = await env.run('INSERT INTO w VALUES (1)', PREVIEW, aborted).then(
			() => false,
			() => true,
		);
		check(rejected, 'run on an aborted context did not reject');
	} finally {
		await env.cleanup();
	}
	check((await count(sql, 'w')) === 0, 'run on an aborted context ran its statement');
}

const SQL_CASES: readonly [string, SqlBody][] = [
	[
		'run gives the columns and the rows of the last statement, with NULL as null',
		lastStatementRows,
	],
	['a last statement with no result gives no columns and no rows', noRowsFromLastStatement],
	['maxRows caps the rows, and rowCount counts every row', previewCap],
	[
		'export writes every row as CSV through WorkspaceFiles, and gives a preview',
		exportThroughFiles,
	],
	['a refused statement with an export writes no file', failedExportWritesNothing],
	[
		'import reads a CSV through WorkspaceFiles into import.rows, for one run alone',
		importThroughFiles,
	],
	['a refused import is an ok: false outcome, and no statement runs', refusedImportRunsNothing],
	['a refused statement is an ok: false outcome, and the run stops there', refusedStatement],
	['every agent reads what another agent wrote', oneDatabaseForEveryAgent],
	['an aborted context rejects before the first statement runs', abortBeforeRun],
];

/** Opens the backend through `harness`, runs `body`, and disposes it. */
async function runSqlCase(harness: SqlHarness, body: SqlBody): Promise<void> {
	const { backend, dispose } = await harness.open();
	const files = caseFiles();
	try {
		await body({
			connect: (agent) => backend.connect({ name: agent }, files.forAgent(agent)),
			files,
		});
	} finally {
		await backend.dispose?.();
		await dispose();
	}
}

/** The cases of a `SqlBackend`, as named test bodies. */
export function sqlCases(harness: SqlHarness): readonly ConformanceCase[] {
	return SQL_CASES.map(([name, body]) => ({ name, run: () => runSqlCase(harness, body) }));
}
