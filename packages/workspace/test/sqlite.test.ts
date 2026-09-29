/**
 * The SQLite backend as a `SqlBackend` (`support/sql-cases.ts`), on a file
 * and in memory, and its own rules: no statement opens a host file, with the
 * engine's authorizer and without it; a call commits its own transaction;
 * a result keeps one value per column name; a call stops on an abort and
 * past its time limit, an import among them; and an export lands on a
 * directory workspace. With append-only tables, no call creates a trigger
 * or calls a guard function, with the authorizer and without it, and the
 * stamp fills only the row that its INSERT added.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { openWorkspace, type SqlOutcome, type Workspace } from '../src/index.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';
import { callAs, invokeText, sqlBackends, toolOf } from './support/backends.ts';
import { sqlCases } from './support/sql-cases.ts';

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
	options: {
		maxRows?: number;
		export?: string;
		import?: string;
		signal?: AbortSignal;
		agent?: string;
	} = {},
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
		...(options.import === undefined ? {} : { import: options.import }),
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

describe.each(sqlBackends)('$name', (harness) => {
	for (const c of sqlCases(harness)) it(c.name, c.run);
});

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
			const listed = await env.listDir('/home/alpha', BACKGROUND_CONTEXT);
			const exists = await env.exists('/home/alpha/big.csv', BACKGROUND_CONTEXT);
			return {
				parts: listed.ok ? listed.value.filter((file) => file.name.endsWith('.part')) : [],
				target: exists.ok && exists.value,
			};
		});
		expect(left).toEqual({ parts: [], target: false });
	});

	it('stops a long import past its time limit, and leaves no staged table and no open transaction', async () => {
		const site = workspace(':memory:', 0.05);
		const lines = Array.from({ length: 300_000 }, (_, index) => `${index},row ${index}`);
		await site.use({ name: 'alpha' }, (env) =>
			env.writeFile('/home/alpha/big.csv', `id,label\n${lines.join('\n')}\n`, BACKGROUND_CONTEXT),
		);
		const outcome = await run(site, 'SELECT count(*) AS n FROM import.rows', { import: 'big.csv' });
		expect(messageOf(outcome)).toContain('ran past 0.05 seconds');
		expect(messageOf(outcome)).not.toContain('transaction');
		expect(messageOf(await run(site, 'SELECT * FROM import.rows'))).toContain('import.rows');
		expect((await run(site, 'BEGIN; CREATE TABLE after (x); COMMIT')).ok).toBe(true);
	});

	it('refuses a time limit that is not more than 0, or that no timer holds', () => {
		for (const timeout of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 3_000_000]) {
			expect(() => sqliteBackend(':memory:', { timeout }), String(timeout)).toThrow(RangeError);
		}
		expect(() => sqliteBackend(':memory:', { timeout: 0.5 })).not.toThrow();
	});
});

// -- append-only tables and provenance ----------------------------------------

const RECORDS = `
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY,
	label TEXT NOT NULL,
	agent TEXT, room TEXT, activation TEXT, exchange_person TEXT, exchange_from TEXT, at TEXT,
	UNIQUE (label)
);
CREATE TABLE IF NOT EXISTS plain (id INTEGER PRIMARY KEY, body TEXT, agent TEXT);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);
`;

/** A workspace over a database of records: `runs` and `plain` take INSERT alone. */
function records(location = ':memory:', provenance = true): Workspace {
	const site = openWorkspace({
		name: 'records',
		backend: {
			bash: memoryBackend(),
			sql: sqliteBackend(location, {
				schema: RECORDS,
				appendOnly: ['runs', 'plain'],
				provenance,
			}),
		},
	});
	cleanups.push(() => site.dispose());
	return site;
}

const inRoom = callAs('design', {
	room: 'bringup',
	activation: 'act-7',
	exchange: { person: 'mira', from: 3 },
});

/** Call the `sql` tool of `site` as `context`, and give its text. */
const sqlTool = (site: Workspace, sql: string, context = inRoom) =>
	invokeText(toolOf(site, 'sql'), { sql }, context);

describe('the append-only tables of the SQLite backend', () => {
	it('stamps the provenance of each tool call on a new row, and refuses a provenance column in the INSERT', async () => {
		const site = records();
		await sqlTool(site, "INSERT INTO runs (label) VALUES ('first'), ('second')");
		await sqlTool(site, "INSERT INTO runs (label) VALUES ('outside')", callAs('experiments'));
		// An exchange with no person, such as the return of a scheduled say, leaves the column NULL.
		await sqlTool(
			site,
			"INSERT INTO runs (label) VALUES ('scheduled')",
			callAs('design', { room: 'bringup', exchange: { from: 9 } }),
		);
		const rows = await run(site, 'SELECT * FROM runs ORDER BY id');
		expect(rows.ok && rows.rows).toMatchObject([
			{
				label: 'first',
				agent: 'design',
				room: 'bringup',
				activation: 'act-7',
				exchange_person: 'mira',
				exchange_from: '3',
			},
			{ label: 'second', agent: 'design', activation: 'act-7' },
			{ label: 'outside', agent: 'experiments', room: null, exchange_person: null },
			{ label: 'scheduled', agent: 'design', exchange_person: null, exchange_from: '9' },
		]);
		expect(rows.ok && Date.parse(String(rows.rows[0]?.at))).not.toBeNaN();
		await expect(
			sqlTool(site, "INSERT INTO runs (label, agent) VALUES ('forged', 'mira')"),
		).rejects.toThrow(/fills the provenance columns of 'runs': agent, room, activation/);
		// A host call with no provenance leaves the columns NULL.
		const host = await run(site, "INSERT INTO runs (label) VALUES ('host') RETURNING id");
		expect(host.ok && host.rows).toEqual([{ id: 5 }]);
		expect(messageOf(await run(site, "UPDATE runs SET agent = 'alpha' WHERE id = 5"))).toMatch(
			/append-only/,
		);
	});

	it('refuses an UPDATE, a DELETE, a REPLACE, and an upsert of an append-only table, and leaves other tables alone', async () => {
		const site = records();
		await sqlTool(
			site,
			"INSERT INTO runs (label) VALUES ('kept'); INSERT INTO plain (body) VALUES ('b')",
		);
		for (const sql of [
			"UPDATE runs SET label = 'changed'",
			"UPDATE runs SET agent = 'design'",
			'DELETE FROM runs',
			"INSERT OR REPLACE INTO runs (label) VALUES ('kept')",
			"REPLACE INTO runs (id, label) VALUES (1, 'other')",
			"INSERT INTO runs (id, label) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET label = 'x'",
			"UPDATE plain SET body = 'c'",
			'DELETE FROM plain',
		]) {
			await expect(sqlTool(site, sql), sql).rejects.toThrow(
				/is append-only: it accepts INSERT alone/,
			);
		}
		await sqlTool(
			site,
			"INSERT INTO notes (body) VALUES ('a'); UPDATE notes SET body = 'b'; DELETE FROM notes",
		);
		const kept = await run(site, 'SELECT label, agent FROM runs');
		expect(kept.ok && kept.rows).toEqual([{ label: 'kept', agent: 'design' }]);
	});

	it.each([
		'DROP TABLE runs',
		'drop table if exists main."RUNS";',
		'DROP TABLE [plain]',
		'DROP TABLE `runs`',
		'ALTER TABLE runs RENAME TO old_runs',
		'ALTER TABLE main.runs ADD COLUMN extra TEXT',
		'DROP TRIGGER ambion_runs_delete',
		'DROP TRIGGER temp.ambion_runs_update',
		'PRAGMA recursive_triggers = OFF',
		'PRAGMA main.writable_schema = ON',
		'PRAGMA query_only = ON',
		'DROP TABLE"runs"',
		'ALTER TABLE "runs"RENAME TO old_runs',
		'DROP /* a comment */ TABLE notes',
		'PRAGMA/**/recursive_triggers = OFF',
		'EXPLAIN PRAGMA recursive_triggers = OFF',
		'EXPLAIN QUERY PLAN PRAGMA recursive_triggers = 0',
		'EXPLAIN PRAGMA query_only = 1',
	])(
		'refuses %s, which would weaken the guard, runs no later statement, and keeps the guard',
		async (statement) => {
			const site = records();
			await run(site, "INSERT INTO runs (label) VALUES ('kept')");
			const outcome = await run(site, `${statement}; INSERT INTO notes (body) VALUES ('after')`);
			expect(messageOf(outcome)).toMatch(/is refused|cannot read the target/);
			const notes = await run(site, 'SELECT count(*) AS n FROM notes');
			expect(notes.ok && notes.rows).toEqual([{ n: 0 }]);
			// SQLite applies a flag PRAGMA when it compiles one, so the refusal sets the flag back.
			const flags = await run(
				site,
				'SELECT r.recursive_triggers, w.writable_schema, q.query_only FROM pragma_recursive_triggers AS r, pragma_writable_schema AS w, pragma_query_only AS q',
			);
			expect(flags.ok && flags.rows).toEqual([
				{ recursive_triggers: 1, writable_schema: 0, query_only: 0 },
			]);
			expect(messageOf(await run(site, 'DELETE FROM runs'))).toMatch(/append-only/);
			expect(
				messageOf(await run(site, "REPLACE INTO runs (id, label) VALUES (1, 'other')")),
			).toMatch(/append-only/);
			const kept = await run(site, 'SELECT id, label FROM runs');
			expect(kept.ok && kept.rows).toEqual([{ id: 1, label: 'kept' }]);
		},
	);

	it('drops a temporary table or view that would hide an append-only table, and refuses its statement', async () => {
		const site = records();
		for (const sql of [
			'CREATE TEMP TABLE runs (id INTEGER PRIMARY KEY, label TEXT, agent TEXT)',
			'CREATE TEMPORARY VIEW "Plain" AS SELECT 1 AS id',
			'CREATE TEMP TABLE scratch (a); ALTER TABLE temp.scratch RENAME TO RUNS',
			'BEGIN; CREATE TABLE temp.runs (label); COMMIT',
		]) {
			await expect(sqlTool(site, sql), sql).rejects.toThrow(/would hide the append-only table/);
		}
		await sqlTool(site, "CREATE TEMP TABLE mine (a); INSERT INTO runs (label) VALUES ('after')");
		const temp = await run(site, "SELECT name FROM temp.sqlite_master WHERE type = 'table'");
		expect(temp.ok && temp.rows).toEqual([{ name: 'mine' }]);
		const rows = await run(site, 'SELECT label, agent, room FROM main.runs');
		expect(rows.ok && rows.rows).toEqual([{ label: 'after', agent: 'design', room: 'bringup' }]);
	});

	it('runs one call at a time when two workspaces share one backend, so each keeps its provenance', async () => {
		const sql = sqliteBackend(':memory:', {
			schema: RECORDS,
			appendOnly: ['runs'],
			provenance: true,
		});
		const [one, two] = ['one', 'two'].map((name) => {
			const site = openWorkspace({ name, backend: { bash: memoryBackend(), sql } });
			cleanups.push(() => site.dispose());
			return site;
		});
		if (one === undefined || two === undefined) throw new Error('Two workspaces open.');
		await one.use({ name: 'design' }, (env) =>
			env.writeFile('/home/design/in.csv', 'label\nimported\n', BACKGROUND_CONTEXT),
		);
		await Promise.all([
			invokeText(
				toolOf(one, 'sql'),
				{ sql: 'INSERT INTO runs (label) SELECT label FROM import.rows', import: 'in.csv' },
				inRoom,
			),
			sqlTool(two, "INSERT INTO runs (label) VALUES ('other')", callAs('experiments')),
		]);
		const rows = await run(two, 'SELECT label, agent, room FROM runs ORDER BY label');
		expect(rows.ok && rows.rows).toEqual([
			{ label: 'imported', agent: 'design', room: 'bringup' },
			{ label: 'other', agent: 'experiments', room: null },
		]);
	});

	it('runs a DROP, an ALTER, and a PRAGMA that leave the guard in place, as SQLite reads their names', async () => {
		const site = records();
		const outcome = await run(
			site,
			[
				'CREATE TABLE scratch (a); ALTER TABLE scratch ADD COLUMN b; DROP TABLE IF EXISTS scratch',
				'CREATE TABLE t2 (a); ALTER TABLE "t2"RENAME TO données; DROP TABLE données',
				'DROP TABLE IF EXISTS"gone"; PRAGMA table_info(runs)',
			].join('; '),
		);
		expect(outcome.ok && outcome.rows.map((row) => row.name)).toContain('exchange_person');
	});

	it('finds an append-only table by its name in any case, as SQLite does', async () => {
		const site = openWorkspace({
			name: 'upper',
			backend: {
				bash: memoryBackend(),
				sql: sqliteBackend(':memory:', { schema: RECORDS, appendOnly: ['RUNS'], provenance: true }),
			},
		});
		cleanups.push(() => site.dispose());
		await sqlTool(site, "INSERT INTO runs (label) VALUES ('kept')");
		const rows = await run(site, 'SELECT label, agent FROM runs');
		expect(rows.ok && rows.rows).toEqual([{ label: 'kept', agent: 'design' }]);
		expect(messageOf(await run(site, 'DELETE FROM Runs'))).toMatch(/'runs' is append-only/);
		expect(messageOf(await run(site, 'DROP TRIGGER ambion_runs_stamp'))).toMatch(/is refused/);
	});

	it.each([
		[
			'a table WITHOUT ROWID',
			'CREATE TABLE runs (label TEXT PRIMARY KEY, agent TEXT) WITHOUT ROWID',
			"sqliteBackend: the append-only table 'runs' is WITHOUT ROWID",
		],
		[
			'a DEFAULT on a provenance column',
			'CREATE TABLE runs (id INTEGER PRIMARY KEY, label TEXT, agent TEXT, at TEXT DEFAULT CURRENT_TIMESTAMP)',
			"sqliteBackend: the provenance column 'at' of 'runs' has a DEFAULT",
		],
		[
			'no DEFAULT but NULL on a provenance column',
			'CREATE TABLE runs (id INTEGER PRIMARY KEY, label TEXT, agent TEXT DEFAULT NULL)',
			undefined,
		],
	])(
		'refuses at open, with provenance, %s that the stamp cannot fill',
		async (_name, schema, refused) => {
			const open = (provenance: boolean) => {
				const site = openWorkspace({
					name: 'shape',
					backend: {
						bash: memoryBackend(),
						sql: sqliteBackend(':memory:', { schema, appendOnly: ['runs'], provenance }),
					},
				});
				cleanups.push(() => site.dispose());
				return site;
			};
			const insert = "INSERT INTO runs (label) VALUES ('kept')";
			if (refused === undefined) {
				const site = open(true);
				await sqlTool(site, insert);
				const rows = await run(site, 'SELECT label, agent FROM runs');
				expect(rows.ok && rows.rows).toEqual([{ label: 'kept', agent: 'design' }]);
			} else {
				await expect(run(open(true), insert)).rejects.toThrow(refused);
			}
			// Without provenance the table opens, and still accepts INSERT alone.
			const plain = open(false);
			expect((await run(plain, insert)).ok).toBe(true);
			expect(messageOf(await run(plain, 'DELETE FROM runs'))).toMatch(/append-only/);
		},
	);

	it('takes an agent value in a provenance column when provenance is off, and still refuses an UPDATE', async () => {
		const site = records(':memory:', false);
		await sqlTool(site, "INSERT INTO runs (label, agent) VALUES ('given', 'someone')");
		const rows = await run(site, 'SELECT label, agent, room FROM runs');
		expect(rows.ok && rows.rows).toEqual([{ label: 'given', agent: 'someone', room: null }]);
		expect(messageOf(await run(site, "UPDATE runs SET agent = 'design'"))).toMatch(/append-only/);
		expect(site.tools().guidance).toContain('The tables runs, plain accept INSERT alone');
		expect(site.tools().guidance).not.toContain('provenance columns');
	});

	it('names the tables and the provenance columns in the guidance', () => {
		const guidance = records().tools().guidance ?? '';
		expect(guidance).toContain('The tables runs, plain accept INSERT alone');
		expect(guidance).toContain(
			'provenance columns (agent, room, activation, exchange_person, exchange_from, at)',
		);
	});

	it('runs the schema at each open, keeps the records across a restart, and guards them again', async () => {
		const location = join(await tempDir(), 'records.db');
		const first = records(location);
		await sqlTool(first, "INSERT INTO runs (label) VALUES ('kept')");
		await first.dispose();
		const second = records(location);
		await sqlTool(second, "INSERT INTO runs (label) VALUES ('again')");
		const rows = await run(second, 'SELECT label, agent FROM runs ORDER BY id');
		expect(rows.ok && rows.rows).toEqual([
			{ label: 'kept', agent: 'design' },
			{ label: 'again', agent: 'design' },
		]);
		expect(messageOf(await run(second, 'DELETE FROM runs'))).toMatch(/append-only/);
	});

	it('rejects a call when an append-only table does not exist, and opens again at the next call', async () => {
		const location = join(await tempDir(), 'missing.db');
		const site = openWorkspace({
			name: 'missing',
			backend: {
				bash: memoryBackend(),
				sql: sqliteBackend(location, { appendOnly: ['absent'] }),
			},
		});
		cleanups.push(() => site.dispose());
		await expect(run(site, 'SELECT 1')).rejects.toThrow(
			"sqliteBackend: the append-only table 'absent' does not exist.",
		);
		const created = new DatabaseSync(location);
		created.exec('CREATE TABLE absent (a)');
		created.close();
		const deleted = await run(site, 'INSERT INTO absent VALUES (1); DELETE FROM absent');
		expect(messageOf(deleted)).toMatch(/append-only/);
	});
});

// -- no agent trigger, and no call of a guard function ------------------------

const alice = callAs('alice', { room: 'bringup', exchange: { person: 'pat', from: 1 } });
const bob = callAs('bob', { room: 'bringup', exchange: { person: 'pat', from: 1 } });

/** Why the backend refuses an agent trigger: in the text, or in the engine where Node has an authorizer. */
const TRIGGER_REFUSED = /CREATE TRIGGER is refused/;

describe.each(engines)('no agent trigger runs in the call of another agent, $name', ({ wrap }) => {
	it.each([
		[
			'a trigger on a plain table',
			"CREATE TRIGGER evil AFTER INSERT ON notes BEGIN INSERT INTO runs (label) VALUES ('planted by alice ' || NEW.body); END",
			"INSERT INTO notes (body) VALUES ('hello')",
		],
		[
			'a trigger on an append-only table that picks its victim',
			"CREATE TRIGGER evil AFTER INSERT ON runs WHEN ambion_provenance('agent') = 'bob' BEGIN INSERT INTO plain (body) VALUES ('planted by alice ' || NEW.label); END",
			"INSERT INTO runs (label) VALUES ('hello')",
		],
		[
			'an INSTEAD OF trigger on a view',
			"CREATE VIEW inbox AS SELECT body FROM notes; CREATE TRIGGER evil INSTEAD OF INSERT ON inbox BEGIN INSERT INTO runs (label) VALUES ('planted by alice ' || NEW.body); END",
			"INSERT INTO inbox (body) VALUES ('hello')",
		],
		[
			'a temporary trigger',
			"CREATE TEMP TRIGGER evil AFTER INSERT ON main.notes BEGIN INSERT INTO runs (label) VALUES ('planted by alice ' || NEW.body); END",
			"INSERT INTO notes (body) VALUES ('hello')",
		],
	])('refuses %s, so no row lands under the name of bob', (_name, plant, victim) =>
		wrap(async () => {
			const site = records();
			await expect(sqlTool(site, plant, alice)).rejects.toThrow(
				/CREATE TRIGGER is refused|function 'ambion_provenance' is refused/,
			);
			await sqlTool(site, victim, bob).catch(() => undefined);
			const planted = await run(
				site,
				"SELECT 'runs' AS tbl, label AS body, agent FROM runs WHERE label LIKE 'planted%' UNION ALL SELECT 'plain', body, agent FROM plain WHERE body LIKE 'planted%'",
			);
			expect(planted.ok && planted.rows).toEqual([]);
			const triggers = await run(
				site,
				"SELECT name FROM sqlite_master WHERE type = 'trigger' UNION ALL SELECT name FROM temp.sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'ambion_%'",
			);
			expect(triggers.ok && triggers.rows).toEqual([]);
		}),
	);

	it('refuses a trigger that skips the stamp, so each row of alice keeps her provenance', () =>
		wrap(async () => {
			const site = records();
			await expect(
				sqlTool(
					site,
					"CREATE TRIGGER skipme BEFORE UPDATE ON runs WHEN ambion_provenance('agent') = 'alice' BEGIN SELECT RAISE(IGNORE); END",
					alice,
				),
			).rejects.toThrow(/CREATE TRIGGER is refused|function 'ambion_provenance' is refused/);
			await expect(
				sqlTool(
					site,
					'CREATE TRIGGER skipme BEFORE UPDATE ON runs BEGIN SELECT RAISE(IGNORE); END',
					alice,
				),
			).rejects.toThrow(TRIGGER_REFUSED);
			await sqlTool(site, "INSERT INTO runs (label) VALUES ('mine')", alice);
			const rows = await run(site, 'SELECT label, agent, exchange_person FROM runs');
			expect(rows.ok && rows.rows).toEqual([
				{ label: 'mine', agent: 'alice', exchange_person: 'pat' },
			]);
		}));

	it.each([
		'create trigger evil after insert on notes begin select 1; end',
		'CREATE TEMPORARY TRIGGER IF NOT EXISTS evil AFTER INSERT ON main.notes BEGIN SELECT 1; END',
		'CREATE /* a comment */ TRIGGER evil AFTER INSERT ON notes BEGIN SELECT 1; END',
		'CREATE -- a comment\n TEMP/**/TRIGGER evil AFTER INSERT ON main.notes BEGIN SELECT 1; END',
		'/* lead */ Create Temp Trigger "evil" BEFORE DELETE ON main.notes BEGIN SELECT 1; END',
	])('refuses %s, and runs no later statement', (statement) =>
		wrap(async () => {
			const site = records();
			const outcome = await run(site, `${statement}; INSERT INTO notes (body) VALUES ('after')`);
			expect(messageOf(outcome)).toMatch(TRIGGER_REFUSED);
			const notes = await run(site, 'SELECT count(*) AS n FROM notes');
			expect(notes.ok && notes.rows).toEqual([{ n: 0 }]);
		}),
	);

	it.each([
		"SELECT ambion_provenance('agent') AS agent",
		'SELECT "AMBION_PROVENANCE"(\'agent\') AS agent',
		"CREATE TABLE gate (x CHECK (ambion_provenance('agent') IS NOT 'bob'))",
		"CREATE VIEW who AS SELECT [ambion_provenance]('agent') AS agent",
		"SELECT ambion_stamp('runs', 1) AS armed",
	])('refuses %s: the guard alone calls its functions', (statement) =>
		wrap(async () => {
			const site = records();
			await expect(sqlTool(site, statement, bob)).rejects.toThrow(
				/The function 'ambion_(provenance|stamp)' is refused/,
			);
		}),
	);

	it('fills only the row that the INSERT added, so bob cannot claim a row of the host', () =>
		wrap(async () => {
			const site = openWorkspace({
				name: 'claims',
				backend: {
					bash: memoryBackend(),
					sql: sqliteBackend(':memory:', {
						schema: `${RECORDS} CREATE TABLE IF NOT EXISTS claims (id INTEGER PRIMARY KEY, body TEXT, agent TEXT);
							INSERT OR IGNORE INTO claims (id, body) VALUES (7, 'seed')`,
						appendOnly: ['runs', 'claims'],
						provenance: true,
					}),
				},
			});
			cleanups.push(() => site.dispose());
			const host = await run(site, "INSERT INTO runs (id, label) VALUES (5, 'host')");
			expect(host.ok).toBe(true);
			for (const claim of [
				// The row that the connection inserted last is the row of the host.
				"UPDATE claims SET agent = 'bob' WHERE id = 7",
				"INSERT INTO notes (id, body) VALUES (7, 'x'); UPDATE claims SET agent = 'bob' WHERE id = 7",
				"INSERT INTO claims (id, body) VALUES (7, 'x') ON CONFLICT (id) DO UPDATE SET agent = 'bob'",
				"INSERT INTO notes (id, body) VALUES (5, 'x'); UPDATE runs SET agent = ambion_provenance('agent'), room = ambion_provenance('room'), activation = ambion_provenance('activation'), exchange_person = ambion_provenance('exchange_person'), exchange_from = ambion_provenance('exchange_from'), at = ambion_provenance('at') WHERE id = 5",
			]) {
				await expect(sqlTool(site, claim, bob), claim).rejects.toThrow(
					/append-only|function 'ambion_provenance' is refused/,
				);
			}
			const rows = await run(
				site,
				'SELECT id, agent FROM runs UNION ALL SELECT id, agent FROM claims ORDER BY id',
			);
			expect(rows.ok && rows.rows).toEqual([
				{ id: 5, agent: null },
				{ id: 7, agent: null },
			]);
		}));
});

describe('a trigger of the host schema', () => {
	it('opens, and runs in the call of each agent with its provenance', async () => {
		const site = openWorkspace({
			name: 'audited',
			backend: {
				bash: memoryBackend(),
				sql: sqliteBackend(':memory:', {
					schema: `${RECORDS} CREATE TRIGGER IF NOT EXISTS audit AFTER INSERT ON notes
						BEGIN INSERT INTO runs (label) VALUES ('noted ' || NEW.body); END`,
					appendOnly: ['runs'],
					provenance: true,
				}),
			},
		});
		cleanups.push(() => site.dispose());
		await sqlTool(site, "INSERT INTO notes (body) VALUES ('hello')", bob);
		const rows = await run(site, 'SELECT label, agent, exchange_person FROM runs');
		expect(rows.ok && rows.rows).toEqual([
			{ label: 'noted hello', agent: 'bob', exchange_person: 'pat' },
		]);
	});
});
