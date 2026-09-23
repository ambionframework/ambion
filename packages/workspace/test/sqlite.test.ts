/**
 * The SQLite backend's own rules: no statement opens a host file, with the
 * engine's authorizer and without it; a call commits its own transaction;
 * a result keeps one value per column name; a call stops on an abort and
 * past its time limit; and an export lands on a directory workspace.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkspace, type SqlOutcome, type Workspace } from '../src/index.ts';
import { directoryBackend, memoryBackend } from '../src/just-bash.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-sqlite-'));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function workspace(location = ':memory:', timeout?: number): Workspace {
	const options = timeout === undefined ? {} : { timeout };
	const site = openWorkspace({
		name: 'sqlite',
		backend: { bash: memoryBackend(), sql: sqliteBackend(location, options) },
	});
	cleanups.push(() => site.dispose());
	return site;
}

/** Run `sql` on the SQL owner as `agent`, as host code does. */
async function run(
	site: Workspace,
	sql: string,
	options: { maxRows?: number; export?: string; signal?: AbortSignal; agent?: string } = {},
): Promise<SqlOutcome> {
	const owner = site.sql;
	if (owner === undefined) throw new Error('The workspace has no SQL backend.');
	const context =
		options.signal === undefined
			? BACKGROUND_CONTEXT
			: withAbortSignal(options.signal, BACKGROUND_CONTEXT);
	const runOptions = {
		maxRows: options.maxRows ?? 50,
		...(options.export === undefined ? {} : { export: options.export }),
	};
	return owner.use({ name: options.agent ?? 'alpha' }, (env) => env.run(sql, runOptions, context));
}

const messageOf = (outcome: SqlOutcome): string => (outcome.ok ? '' : outcome.message);

type AuthorizerHolder = { setAuthorizer?: unknown };

/** Run `body` with `node:sqlite` as it is on Node before 24.10: no `setAuthorizer`. */
async function withoutAuthorizer(body: () => Promise<void>): Promise<void> {
	const prototype = DatabaseSync.prototype as unknown as AuthorizerHolder;
	const saved = prototype.setAuthorizer;
	delete prototype.setAuthorizer;
	try {
		await body();
	} finally {
		if (saved !== undefined) prototype.setAuthorizer = saved;
	}
}

const engines = [
	{
		name: 'with the engine authorizer, where Node has one',
		wrap: (body: () => Promise<void>) => body(),
	},
	{ name: 'with the text check alone', wrap: withoutAuthorizer },
];

describe.each(engines)('no statement opens a host file, $name', ({ wrap }) => {
	it("refuses every ATTACH of a file and every VACUUM INTO, runs no later statement, and still attaches ':memory:'", () =>
		wrap(async () => {
			const dir = await tempDir();
			const target = join(dir, 'escape.db');
			const upper = join(process.cwd(), ':MEMORY:');
			cleanups.push(() => rm(upper, { force: true }));
			const site = workspace();
			for (const statement of [
				`ATTACH '${target}' AS escape`,
				`ATTACH DATABASE '${dir}/' || 'escape.db' AS escape`,
				`/* note */ attach '${target}' as escape`,
				`;ATTACH '${target}' AS escape`,
				`; ; -- lead\n ATTACH '${target}' AS escape`,
				"ATTACH ':MEMORY:' AS escape",
				"ATTACH '' AS escape",
				`CREATE TABLE IF NOT EXISTS t(x); VACUUM INTO '${target}'`,
				`CREATE TABLE IF NOT EXISTS t(x); ;VACUUM INTO '${target}'`,
			]) {
				const outcome = await run(site, `${statement}; CREATE TABLE after(x);`);
				expect(outcome.ok, statement).toBe(false);
			}
			const after = await run(site, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'after'");
			expect(after.ok && after.rows[0]?.n).toBe(0);
			expect(existsSync(target)).toBe(false);
			expect(existsSync(upper)).toBe(false);
			const scratch = await run(
				site,
				"ATTACH ':memory:' AS scratch; CREATE TABLE scratch.t(x); INSERT INTO scratch.t VALUES (1); SELECT x FROM scratch.t",
			);
			expect(scratch).toMatchObject({ ok: true, rowCount: 1 });
		}));
});

describe('the SQLite backend', () => {
	it('keeps a transaction the call commits, and rolls back one a call leaves open', async () => {
		const location = join(await tempDir(), 'lab.db');
		const first = workspace(location);
		const committed = await run(
			first,
			'BEGIN; CREATE TABLE t(a); INSERT INTO t VALUES (1); COMMIT;',
		);
		expect(committed.ok).toBe(true);
		const failed = await run(
			first,
			'BEGIN; CREATE TABLE u(a); INSERT INTO u VALUES (1); SELECT * FROM missing_table;',
		);
		expect(messageOf(failed)).toContain('missing_table');
		expect(messageOf(failed)).toContain('rolled it back');
		const open = await run(first, 'BEGIN; CREATE TABLE w(a); INSERT INTO w VALUES (1)');
		expect(messageOf(open)).toContain('rolled it back');
		const kept = await run(first, 'CREATE TABLE v(a); INSERT INTO v VALUES (2)', { agent: 'beta' });
		expect(kept.ok).toBe(true);
		await first.dispose();

		const second = workspace(location);
		const tables = await run(second, "SELECT name FROM sqlite_master WHERE type = 'table'");
		expect(tables.ok && tables.rows.map((row) => row.name)).toEqual(['t', 'v']);
		const count = await run(second, 'SELECT count(*) AS n FROM t');
		expect(count.ok && count.rows[0]?.n).toBe(1);
	});

	it.each([
		[
			'refuses a result with two columns of one name',
			'SELECT 1 AS a, 2 AS a',
			"two columns named 'a'",
		],
		[
			'runs a stray ; after the last statement as nothing',
			'CREATE TABLE t(x); INSERT INTO t VALUES (1); ;',
			{ rowCount: 0 },
		],
		[
			'runs an unterminated comment after a statement as nothing',
			'SELECT 1 AS x; /* open',
			{ rowCount: 1 },
		],
		['runs an unterminated comment alone as nothing', '/* open', { rowCount: 0 }],
		['refuses a NUL character', 'SELECT 1;\0 SELECT 2', 'NUL'],
	])('%s', async (_name, sql, expected) => {
		const outcome = await run(workspace(), sql);
		if (typeof expected === 'string') expect(messageOf(outcome)).toContain(expected);
		else expect(outcome).toMatchObject({ ok: true, ...expected });
	});

	it('rounds maxRows down, and keeps no row for a negative one', async () => {
		const site = workspace();
		const three = 'SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3';
		const rounded = await run(site, three, { maxRows: 2.5 });
		expect(rounded).toMatchObject({ ok: true, rowCount: 3 });
		expect(rounded.ok && rounded.rows.length).toBe(2);
		const none = await run(site, three, { maxRows: -1 });
		expect(none.ok && none.rows.length).toBe(0);
	});

	it('stops a long result when the caller aborts, and rejects', async () => {
		const site = workspace();
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error('cut')), 20);
		const started = Date.now();
		await expect(
			run(site, 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c', {
				signal: controller.signal,
			}),
		).rejects.toThrow('cut');
		expect(Date.now() - started).toBeLessThan(5_000);
		const after = await run(site, 'SELECT 1 AS one');
		expect(after.ok).toBe(true);
	});

	it('streams an export to a directory workspace on disk, as the calling agent', async () => {
		const root = await tempDir();
		const site = openWorkspace({
			name: 'on-disk',
			backend: { bash: directoryBackend(root), sql: sqliteBackend(':memory:') },
		});
		cleanups.push(() => site.dispose());
		const outcome = await run(
			site,
			'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000) SELECT x FROM c',
			{ maxRows: 3, export: '~/out/c.csv', agent: 'ada' },
		);
		expect(outcome).toMatchObject({ ok: true, rowCount: 5000, export: '/home/ada/out/c.csv' });
		expect(outcome.ok && outcome.rows.length).toBe(3);
		const text = await readFile(join(root, 'home', 'ada', 'out', 'c.csv'), 'utf8');
		expect(text.split('\n').length).toBe(5002);
		expect(text.startsWith('x\n1\n2\n')).toBe(true);
	});

	it('detaches a scratch database after its call, so no other call reads it', async () => {
		const site = workspace();
		const made = await run(
			site,
			"ATTACH ':memory:' AS scratch; CREATE TABLE scratch.p(x); INSERT INTO scratch.p VALUES (1); SELECT x FROM scratch.p",
		);
		expect(made).toMatchObject({ ok: true, rowCount: 1 });
		const other = await run(site, 'SELECT x FROM scratch.p', { agent: 'beta' });
		expect(messageOf(other)).toContain('scratch.p');
		for (let call = 0; call < 12; call += 1) {
			const again = await run(site, `ATTACH ':memory:' AS s${call}; SELECT 1 AS one`);
			expect(again.ok, `call ${call}`).toBe(true);
		}
	});

	it('stops a long result past its time limit, as an ok: false outcome, and removes the temporary file of its export', async () => {
		const site = workspace(':memory:', 0.05);
		const endless =
			'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c';
		expect(messageOf(await run(site, endless))).toContain('ran past 0.05 seconds');
		expect(messageOf(await run(site, endless, { export: '~/big.csv' }))).toContain('ran past');
		const left = await site.use({ name: 'alpha' }, async (env) => {
			const listed = await env.listDir('/tmp', BACKGROUND_CONTEXT);
			const exists = await env.exists('/home/alpha/big.csv', BACKGROUND_CONTEXT);
			return {
				parts: listed.ok ? listed.value.filter((file) => file.name.endsWith('.part')) : [],
				target: exists.ok && exists.value,
			};
		});
		expect(left).toEqual({ parts: [], target: false });
	});

	it('refuses a time limit that is not more than 0, or that no timer holds', () => {
		for (const timeout of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 3_000_000]) {
			expect(() => sqliteBackend(':memory:', { timeout }), String(timeout)).toThrow(RangeError);
		}
		expect(() => sqliteBackend(':memory:', { timeout: 0.5 })).not.toThrow();
	});
});
