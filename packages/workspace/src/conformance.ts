/**
 * The cases every bash backend (`BashBackend`) and every
 * `SqlBackend` must pass. A bash backend supplies a Pi
 * `ExecutionEnv` (`docs/workspace.md`), and the tools the neutral layer
 * builds over it assume one rule set: how a path resolves, how an error
 * comes back, how an aborted command differs from a timed-out one, how a
 * bounded command view carries its truncation, and where a temporary name
 * lands.
 *
 * A case is a name and a `run` that throws on failure. The suite needs no
 * test framework and loads no just-bash, so any backend runs it, and the
 * memory and directory backends run it first (`test/conformance.test.ts`).
 *
 * ```ts
 * describe.each(backends)('$name', (harness) => {
 * 	for (const c of workspaceConformance(harness)) it(c.name, c.run);
 * });
 * ```
 *
 * `sqlConformance` holds the cases of a `SqlBackend`: the preview and the
 * count of the last statement, an export through `WorkspaceFiles`, a
 * refused statement as an outcome, one database for every agent, and an
 * abort before the first statement.
 */

import type { ConformanceCase } from '@ambionframework/ambion/conformance';
import {
	BACKGROUND_CONTEXT,
	ExecutionError,
	FileError,
	type ShellOutputUpdate,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import type { BashBackend, WorkspaceEnv } from './backend.ts';
import type {
	SqlBackend,
	SqlEnv,
	SqlOutcome,
	SqlRunOptions,
	WorkspaceFiles,
} from './sql-backend.ts';

export type {
	GitConformanceBackend,
	GitConformanceOptions,
	GitConformancePair,
	GitConformanceProbe,
	GitConformanceStore,
	GitConformanceTemplate,
} from './git-conformance.ts';
export { gitConformance } from './git-conformance.ts';
export type { ConformanceCase };

/**
 * A backend under test. `open` runs inside every case, so a directory
 * backend can mint its own temporary root and clean it up after.
 */
export interface ConformanceBackend {
	readonly name: string;
	open(): Promise<{ backend: BashBackend; dispose(): Promise<void> }>;
}

const ctx = BACKGROUND_CONTEXT;

function check(condition: boolean, what: string): void {
	if (!condition) throw new Error(what);
}

// -- the cases ----------------------------------------------------------------

type Body = (env: WorkspaceEnv) => Promise<void>;

async function renameReplacesTarget(env: WorkspaceEnv): Promise<void> {
	await env.writeFile('source.txt', 'new', ctx);
	await env.writeFile('target.txt', 'old', ctx);
	const renamed = await env.renameFile('source.txt', 'target.txt', ctx);
	check(renamed.ok, 'renameFile refused to replace an existing target');
	const target = await env.readTextFile('target.txt', ctx);
	check(target.ok && target.value === 'new', 'the target kept its old content');
	const source = await env.readTextFile('source.txt', ctx);
	check(!source.ok && source.error.code === 'not_found', 'the source is still there after rename');
}

async function recursiveCreateDir(env: WorkspaceEnv): Promise<void> {
	const created = await env.createDir('a/b/c', { recursive: true }, ctx);
	check(created.ok, 'createDir with recursive did not create the missing parents');
	const info = await env.fileInfo('a/b/c', ctx);
	check(info.ok && info.value.kind === 'directory', 'the deepest directory is missing');
	const parent = await env.fileInfo('a/b', ctx);
	check(parent.ok && parent.value.kind === 'directory', 'a missing parent was not created');
}

async function forcedRemove(env: WorkspaceEnv): Promise<void> {
	const onMissing = await env.remove('never-existed', { force: true }, ctx);
	check(onMissing.ok, 'remove with force failed on a missing path');
	await env.createDir('tree/inner', { recursive: true }, ctx);
	await env.writeFile('tree/inner/leaf.txt', 'x', ctx);
	const removed = await env.remove('tree', { recursive: true }, ctx);
	check(removed.ok, 'recursive remove did not remove the tree');
	const gone = await env.exists('tree', ctx);
	check(gone.ok && gone.value === false, 'the tree is still there after a recursive remove');
}

async function fileErrorCodes(env: WorkspaceEnv): Promise<void> {
	const missing = await env.readTextFile('missing.txt', ctx);
	check(
		!missing.ok && missing.error instanceof FileError && missing.error.code === 'not_found',
		'a missing file did not answer not_found',
	);
	await env.createDir('a-dir', undefined, ctx);
	const asFile = await env.readTextFile('a-dir', ctx);
	check(
		!asFile.ok && asFile.error instanceof FileError && asFile.error.code === 'is_directory',
		'reading a directory did not answer is_directory',
	);
	await env.writeFile('a-file.txt', 'x', ctx);
	const asDir = await env.listDir('a-file.txt', ctx);
	check(
		!asDir.ok && asDir.error instanceof FileError && asDir.error.code === 'not_directory',
		'listing a file did not answer not_directory',
	);
}

async function tildeAndRelativePaths(env: WorkspaceEnv): Promise<void> {
	const home = env.cwd;
	const tilde = await env.absolutePath('~', ctx);
	check(tilde.ok && tilde.value === home, '~ did not expand to the home');
	const tildePath = await env.absolutePath('~/x', ctx);
	check(tildePath.ok && tildePath.value === `${home}/x`, '~/x did not expand under the home');
	const relative = await env.absolutePath('y', ctx);
	check(relative.ok && relative.value === `${home}/y`, 'a relative path did not resolve under cwd');
}

async function abortApartFromTimeout(env: WorkspaceEnv): Promise<void> {
	const controller = new AbortController();
	const aborting = env.exec('sleep 5', undefined, withAbortSignal(controller.signal, ctx));
	controller.abort();
	const aborted = await aborting;
	check(
		!aborted.ok && aborted.error instanceof ExecutionError && aborted.error.code === 'aborted',
		'an aborted context signal did not answer ExecutionError code aborted',
	);
	const timedOut = await env.exec('sleep 5', { timeout: 0.05 }, ctx);
	check(
		!timedOut.ok && timedOut.error instanceof ExecutionError && timedOut.error.code === 'timeout',
		'a timeout did not answer ExecutionError code timeout',
	);
}

async function boundedOutputWithSpill(env: WorkspaceEnv): Promise<void> {
	const updates: ShellOutputUpdate[] = [];
	const tail = await env.exec(
		'printf "%s\\n" a b c d e',
		{
			capture: { limits: { maxBytes: 1_000_000, maxLines: 2 }, spill: true },
			onUpdate: (update) => updates.push(update),
		},
		ctx,
	);
	check(tail.ok, 'the bounded command failed to run');
	check(updates.length === 1, `onUpdate received ${updates.length} updates, expected one`);
	const view = updates[0];
	check(view?.kind === 'replace', 'onUpdate did not receive a replace view');
	if (view?.kind !== 'replace') return;
	check(view.output.truncation.truncated === true, 'the view lacks truncation metadata');
	check(view.output.text === 'd\ne', 'the default tail view kept the wrong lines');
	const spillPath = view.output.spillPath;
	check(
		typeof spillPath === 'string' && spillPath.startsWith('/tmp/'),
		'a cut view has no spillPath under /tmp',
	);
	if (typeof spillPath !== 'string') return;
	const spilled = await env.readTextFile(spillPath, ctx);
	check(spilled.ok && spilled.value === 'a\nb\nc\nd\ne\n', 'the spill file lacks the whole output');
	const headUpdates: ShellOutputUpdate[] = [];
	const head = await env.exec(
		'printf "%s\\n" a b c d e',
		{
			capture: { limits: { maxBytes: 1_000_000, maxLines: 2, retain: 'head' } },
			onUpdate: (update) => headUpdates.push(update),
		},
		ctx,
	);
	check(head.ok, 'the head-retained command failed to run');
	const headView = headUpdates[0];
	check(headView?.kind === 'replace', 'onUpdate did not receive a replace view for the head');
	if (headView?.kind !== 'replace') return;
	check(headView.output.truncation.truncated === true, 'a head-retained command was not truncated');
	check(headView.output.text === 'a\nb', 'the head-retained view kept the wrong lines');
}

async function temporaryNames(env: WorkspaceEnv): Promise<void> {
	const file = await env.createTempFile(undefined, ctx);
	check(file.ok && file.value.startsWith('/tmp/'), 'a temp file did not land under /tmp');
	const otherFile = await env.createTempFile(undefined, ctx);
	check(
		file.ok && otherFile.ok && file.value !== otherFile.value,
		'two temp files got the same name',
	);
	const dir = await env.createTempDir(undefined, ctx);
	check(dir.ok && dir.value.startsWith('/tmp/'), 'a temp directory did not land under /tmp');
	const otherDir = await env.createTempDir(undefined, ctx);
	check(
		dir.ok && otherDir.ok && dir.value !== otherDir.value,
		'two temp directories got the same name',
	);
}

const CASES: readonly [string, Body][] = [
	['renameFile replaces an existing target', renameReplacesTarget],
	['createDir with recursive creates missing parent directories', recursiveCreateDir],
	['remove succeeds with force on a missing path, and recursive removes a tree', forcedRemove],
	['classifies not_found, is_directory, and not_directory as FileError codes', fileErrorCodes],
	['~ and ~/x expand to the home, and a relative path resolves under cwd', tildeAndRelativePaths],
	['tells an aborted context signal apart from a timeout', abortApartFromTimeout],
	[
		'bounds exec output for onUpdate, with truncation metadata and a spill file',
		boundedOutputWithSpill,
	],
	['creates temp files and directories under /tmp with distinct names', temporaryNames],
];

/** Connects one agent through `harness`, runs `body`, and cleans up. */
async function runCase(harness: ConformanceBackend, body: Body): Promise<void> {
	const { backend, dispose } = await harness.open();
	try {
		const env = await backend.connect({ name: 'conformance' });
		try {
			await body(env);
		} finally {
			await env.cleanup();
		}
	} finally {
		await dispose();
	}
}

/**
 * The cases every `BashBackend` must pass. The order is stable and the
 * names are the contract.
 */
export function workspaceConformance(harness: ConformanceBackend): readonly ConformanceCase[] {
	return CASES.map(([name, body]) => ({ name, run: () => runCase(harness, body) }));
}

// -- the SQL backend cases ----------------------------------------------------

/** A SQL backend under test. `open` runs inside every case, the same as `ConformanceBackend`. */
export interface SqlConformanceBackend {
	readonly name: string;
	open(): Promise<{ backend: SqlBackend; dispose(): Promise<void> }>;
}

/** The files a case hands the backend: an in-memory map, keyed by absolute path. */
interface CaseFiles {
	forAgent(agent: string): WorkspaceFiles;
	read(path: string): string | undefined;
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
			writeFile: async (path, chunks) => {
				let text = '';
				for await (const chunk of chunks) text += chunk;
				const target = absolute(agent, path);
				stored.set(target, text);
				return target;
			},
		}),
		read: (path) => stored.get(path),
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
	['a refused statement is an ok: false outcome, and the run stops there', refusedStatement],
	['every agent reads what another agent wrote', oneDatabaseForEveryAgent],
	['an aborted context rejects before the first statement runs', abortBeforeRun],
];

/** Opens the backend through `harness`, runs `body`, and disposes it. */
async function runSqlCase(harness: SqlConformanceBackend, body: SqlBody): Promise<void> {
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

/**
 * The cases every `SqlBackend` must pass. The order is stable and the names
 * are the contract.
 */
export function sqlConformance(harness: SqlConformanceBackend): readonly ConformanceCase[] {
	return SQL_CASES.map(([name, body]) => ({ name, run: () => runSqlCase(harness, body) }));
}
