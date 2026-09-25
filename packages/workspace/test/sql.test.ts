/**
 * A workspace with a SQL backend: the `sql` tool over SQLite, its preview
 * and its export into the shell, the audit entry, the two owners, and
 * disposal, and the import of a CSV file from the shell. A workspace with
 * no SQL backend has no `sql` tool. The SQL conformance cases run in
 * `conformance.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { sh } from '../../just-bash/test/support/backends.ts';
import { openWorkspace, type SqlBackend, type Workspace } from '../src/index.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';
import { toolOf } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;

type Details = {
	database: string;
	rows: number;
	export?: string;
	import?: string;
	imported?: number;
};

/** `inner`, and a record of the agents that connected and of each disposal. */
function counted(inner: SqlBackend) {
	const agents: string[] = [];
	let disposals = 0;
	const backend: SqlBackend = {
		...inner,
		connect: (agent, files, signal) => {
			agents.push(agent.name);
			return inner.connect(agent, files, signal);
		},
		dispose: async () => {
			disposals += 1;
			await inner.dispose?.();
		},
	};
	return { ...backend, agents, disposals: () => disposals };
}

function withSql(options: { audit?: boolean; location?: string } = {}) {
	const sql = counted(sqliteBackend(options.location ?? ':memory:'));
	const workspace = openWorkspace({
		name: 'lab',
		backend: { bash: memoryBackend(), sql },
		...(options.audit ? { audit: {} } : {}),
	});
	return { sql, workspace };
}

/** Call the `sql` tool as one agent, and return its text and details. */
async function call(
	workspace: Workspace,
	params: Record<string, unknown>,
	agent = 'ada',
): Promise<{ text: string; details: Details }> {
	const result = await toolOf(workspace, 'sql').invoke(params, {
		agent: { name: agent, identity: `${agent} identity` },
		callId: 'call-1',
		room: 'lobby',
	});
	if (typeof result === 'string') throw new Error('The sql tool must return a structured result.');
	const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	return { text, details: result.details as Details };
}

async function shellText(workspace: Workspace, path: string): Promise<string | undefined> {
	return workspace.use({ name: 'host' }, async (env) => {
		const read = await env.readTextFile(path, ctx);
		return read.ok ? read.value : undefined;
	});
}

/** A promise that stays open, as a shell operation that holds the bash owner, until released. */
function holdShell(workspace: Workspace) {
	let release = (): void => {};
	const held = workspace.use({ name: 'host' }, () => new Promise<void>((done) => (release = done)));
	return async () => {
		release();
		await held;
	};
}

describe('a workspace with a SQL backend', () => {
	it('keeps the eight default tools, names no database file in sql, and states the backend database', () => {
		const { workspace } = withSql();
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'ps',
			'status',
			'wait',
			'cancel',
			'sql',
		]);
		const properties = Object.keys(
			(toolOf(workspace, 'sql').parameters as { properties: Record<string, unknown> }).properties,
		);
		expect(properties.sort()).toEqual(['export', 'import', 'maxRows', 'sql']);
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain('one shared database, :memory:');
		expect(guidance).toContain('The database is SQLite: dates are functions');
	});

	it('runs statements as the calling agent on one database the agents share, views and their definitions included', async () => {
		const { sql, workspace } = withSql();
		const made = await call(workspace, {
			sql: `CREATE TABLE pour(id INTEGER, grade TEXT, tonnes REAL);
INSERT INTO pour VALUES (1,'C30',12.5),(2,'C40',8.0);
SELECT * FROM pour ORDER BY id;`,
		});
		expect(made.text).toContain('| id | grade | tonnes |');
		expect(made.text).toContain('| 1 | C30 | 12.5 |');
		expect(made.details).toMatchObject({ database: ':memory:', rows: 2 });

		const read = await call(
			workspace,
			{ sql: 'SELECT grade, sum(tonnes) AS t FROM pour GROUP BY grade ORDER BY grade;' },
			'bob',
		);
		expect(read.text).toContain('| C30 | 12.5 |');
		expect(read.text).toContain('| C40 | 8 |');

		await call(workspace, {
			sql: 'CREATE VIEW light AS SELECT id, grade FROM pour WHERE tonnes < 10;',
		});
		const view = await call(workspace, { sql: 'SELECT * FROM light ORDER BY id;' }, 'bob');
		expect(view.text).toContain('| 2 | C40 |');
		const definition = await call(
			workspace,
			{ sql: "SELECT sql FROM sqlite_master WHERE name='light';" },
			'bob',
		);
		expect(definition.text).toContain('CREATE VIEW light AS SELECT id, grade FROM pour');
		expect(sql.agents).toEqual(['ada', 'bob', 'ada', 'bob', 'bob']);
	});

	it.each([
		{
			name: 'renders a NULL value as NULL',
			sql: "SELECT 1 AS id, NULL AS note UNION ALL SELECT 2, 'set' ORDER BY id;",
			shows: ['| 1 | NULL |', '| 2 | set |'],
		},
		{
			name: 'reports no rows for a query that returns none',
			setup: 'CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1);',
			sql: 'SELECT * FROM t WHERE id > 99;',
			shows: ['No rows'],
			rows: 0,
		},
		{
			name: 'previews the last query when the script has several',
			sql: 'SELECT 1 AS a; SELECT 2 AS b, 3 AS c;',
			shows: ['| b | c |', '| 2 | 3 |'],
			hides: ['| a |'],
			rows: 1,
		},
		{
			name: 'caps the preview for a large result',
			setup: `CREATE TABLE big(id INTEGER);
WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 200)
INSERT INTO big SELECT id FROM seq;`,
			sql: 'SELECT * FROM big ORDER BY id;',
			maxRows: 5,
			shows: ['Shows 5 of 200 rows'],
			rows: 200,
		},
		{
			name: 'joins the shared database with a private in-memory scratch in one statement',
			setup:
				"CREATE TABLE part(id INTEGER, name TEXT); INSERT INTO part VALUES (1,'a'),(2,'b'),(3,'c');",
			sql: `ATTACH ':memory:' AS scratch;
CREATE TABLE scratch.pick(id INTEGER);
INSERT INTO scratch.pick VALUES (1),(3);
SELECT p.id, p.name FROM part p JOIN scratch.pick USING(id) ORDER BY p.id;`,
			shows: ['| 1 | a |', '| 3 | c |'],
			hides: ['| 2 | b |'],
		},
		{
			name: 'returns a refused statement as content with the database name, so the agent can correct it',
			sql: 'SELECT * FROM missing_table',
			match: /^SQL error on :memory::\n.*missing_table/,
		},
	])('$name', async ({ setup, sql, maxRows, shows = [], hides = [], rows, match }) => {
		const { workspace } = withSql();
		if (setup !== undefined) await call(workspace, { sql: setup });
		const result = await call(workspace, { sql, ...(maxRows === undefined ? {} : { maxRows }) });
		for (const text of shows) expect(result.text).toContain(text);
		for (const text of hides) expect(result.text).not.toContain(text);
		if (rows !== undefined) expect(result.details.rows).toBe(rows);
		if (match !== undefined) expect(result.text).toMatch(match);
		await workspace.dispose();
	});

	it('exports the full result as RFC 4180 CSV into the shell, previews its head, and counts records exactly', async () => {
		const { workspace } = withSql();
		await call(workspace, {
			sql: `CREATE TABLE t (id INTEGER, note TEXT); INSERT INTO t VALUES (1, 'a, "b"'), (2, NULL), (3, 'x\ny')`,
		});
		const csv = 'id,note\n1,"a, ""b"""\n2,\\N\n3,"x\ny"\n';
		const full = await call(workspace, {
			sql: 'SELECT id, note FROM t ORDER BY id',
			export: '~/out/t.csv',
		});
		expect(full.details).toMatchObject({ rows: 3, export: '/home/ada/out/t.csv' });
		expect(full.text).toContain('Wrote 3 rows to /home/ada/out/t.csv.');
		expect(full.text).toContain(`\`\`\`csv\n${csv}\`\`\``);
		const head = await call(workspace, {
			sql: 'SELECT id, note FROM t ORDER BY id',
			export: '~/out/head.csv',
			maxRows: 1,
		});
		expect(head.text).toContain('Wrote 3 rows to /home/ada/out/head.csv.');
		expect(head.text).toContain('id,note\n1,"a, ""b"""');
		expect(head.text).not.toContain('2,\\N');
		expect(await shellText(workspace, '/home/ada/out/t.csv')).toBe(csv);
		expect(await shellText(workspace, '/home/ada/out/head.csv')).toBe(csv);
		const python = await workspace.use({ name: 'ada' }, (env) =>
			sh(
				env,
				`python3 - <<'PY'
import csv
rows=list(csv.DictReader(open('/home/ada/out/t.csv')))
print(len(rows), rows[1]['note'], repr(rows[2]['note']))
PY`,
			),
		);
		expect(python.output.trim()).toBe("3 \\N 'x\\ny'");
	});

	it('imports an exported CSV back through import.rows, copies it with INSERT ... SELECT, and drops it after the call', async () => {
		const { workspace } = withSql({ audit: true });
		await call(workspace, {
			sql: `CREATE TABLE t (id INTEGER, note TEXT); INSERT INTO t VALUES (1, 'a, "b"'), (2, NULL), (3, 'x\ny'), (4, ''), (5, '\\N')`,
		});
		await call(workspace, { sql: 'SELECT id, note FROM t ORDER BY id', export: '~/out/t.csv' });
		expect(await shellText(workspace, '/home/ada/out/t.csv')).toContain(
			'\n2,\\N\n3,"x\ny"\n4,\n5,"\\N"\n',
		);
		const copied = await call(workspace, {
			sql: `CREATE TABLE t2 (id INTEGER, note TEXT);
INSERT INTO t2 SELECT CAST(id AS INTEGER), note FROM import.rows;
SELECT (SELECT count(*) FROM t2) AS copied,
  (SELECT count(*) FROM (SELECT id, note FROM t EXCEPT SELECT id, note FROM t2)) AS differ,
  (SELECT typeof(id) FROM import.rows LIMIT 1) AS staged;`,
			import: 'out/t.csv',
		});
		expect(copied.text).toMatch(
			/^Imported 5 rows from \/home\/ada\/out\/t\.csv into import\.rows\.\n\n/,
		);
		expect(copied.text).toContain('| copied | differ | staged |');
		expect(copied.text).toContain('| 5 | 0 | text |');
		expect(copied.details).toMatchObject({
			rows: 1,
			import: '/home/ada/out/t.csv',
			imported: 5,
		});
		const exported = await call(workspace, {
			sql: 'SELECT count(*) AS n FROM import.rows',
			import: 'out/t.csv',
			export: 'out/n.csv',
		});
		expect(exported.text).toMatch(/^Imported 5 rows .*\n\n```csv\nn\n5\n```/);
		expect(exported.details).toMatchObject({ export: '/home/ada/out/n.csv', imported: 5 });
		const later = await call(workspace, { sql: 'SELECT * FROM import.rows' }, 'bob');
		expect(later.text).toContain('SQL error');
		const log = (await shellText(workspace, '/workspace/audit.jsonl')) ?? '';
		const entries = log
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { arguments: Record<string, unknown> });
		expect(entries[2]?.arguments.import).toBe('out/t.csv');
		const missing = await call(workspace, { sql: 'SELECT 1', import: 'none.csv' });
		expect(missing.text).toMatch(/^SQL error on :memory::\nCannot read \/home\/ada\/none\.csv: /);
		const nul = await call(workspace, { sql: 'SELECT 1;\0', import: 'none.csv' });
		expect(nul.text).toContain('The SQL holds a NUL character.');
	});

	it('reads a CSV that a script in the shell writes, with CRLF line ends', async () => {
		const { workspace } = withSql();
		await workspace.use({ name: 'ada' }, (env) =>
			sh(
				env,
				`python3 - <<'PY'
import csv
with open('/home/ada/sweep.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['step', 'ohms', 'ma'])
    for step in range(10):
        w.writerow([step, 100 + step * 10, round(3.3 / (100 + step * 10) * 1000, 3)])
PY`,
			),
		);
		const result = await call(workspace, {
			sql: `CREATE TABLE sweep (step INTEGER, ohms REAL, ma REAL);
INSERT INTO sweep SELECT CAST(step AS INTEGER), CAST(ohms AS REAL), CAST(ma AS REAL) FROM import.rows;
SELECT count(*) AS n, max(ohms) AS top, typeof(max(ohms)) AS kind FROM sweep;`,
			import: '~/sweep.csv',
		});
		expect(result.text).toContain('Imported 10 rows from /home/ada/sweep.csv');
		expect(result.text).toContain('| 10 | 190 | real |');
	});

	it('leaves an existing export file unchanged when the query fails', async () => {
		const { workspace } = withSql();
		await call(workspace, { sql: 'CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1);' });
		const good = await call(workspace, { sql: 'SELECT * FROM t;', export: '~/keep.csv' });
		expect(good.details.rows).toBe(1);
		const bad = await call(workspace, { sql: 'SELECT * FROM nope;', export: '~/keep.csv' });
		expect(bad.text).toContain('SQL error');
		expect(await shellText(workspace, '/home/ada/keep.csv')).toBe('id\n1\n');
	});

	it('records a sql call in the audit log on the shell', async () => {
		const { workspace } = withSql({ audit: true });
		await call(workspace, { sql: 'SELECT 1 AS one' });
		const log = await shellText(workspace, '/workspace/audit.jsonl');
		const entry = JSON.parse((log ?? '').trim()) as Record<string, unknown>;
		expect(entry).toMatchObject({ agent: 'ada', tool: 'sql', room: 'lobby', callId: 'call-1' });
		expect(entry.arguments).toEqual({ sql: 'SELECT 1 AS one' });
	});

	it('runs a query while a shell operation holds the shell owner, and makes an export wait for it', async () => {
		const { workspace } = withSql();
		const release = holdShell(workspace);
		expect((await call(workspace, { sql: 'SELECT 42 AS answer' })).text).toContain('| 42 |');
		let finished = false;
		const exporting = call(workspace, { sql: 'SELECT 1 AS one', export: '~/one.csv' }).then(
			(result) => {
				finished = true;
				return result.text;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(finished).toBe(false);
		await release();
		expect(await exporting).toContain('Wrote 1 row to /home/ada/one.csv.');
	});

	it('exposes the SQL owner for host code, which exports as the host agent', async () => {
		const { workspace } = withSql();
		const run = (options: { maxRows: number; export?: string }) =>
			workspace.sql?.use({ name: 'host' }, (env) => env.run('SELECT 7 AS n', options, ctx));
		expect(await run({ maxRows: 50 })).toEqual({
			ok: true,
			columns: ['n'],
			rows: [{ n: 7 }],
			rowCount: 1,
		});
		expect(await run({ maxRows: 0, export: '~/n.csv' })).toMatchObject({
			ok: true,
			rows: [],
			rowCount: 1,
			export: '/home/host/n.csv',
		});
		expect(await shellText(workspace, '/home/host/n.csv')).toBe('n\n7\n');
	});

	it('disposes both owners, and the SQL backend once', async () => {
		const { sql, workspace } = withSql();
		await Promise.all([workspace.dispose(), workspace.dispose()]);
		expect(sql.disposals()).toBe(1);
		await expect(call(workspace, { sql: 'SELECT 1' })).rejects.toThrow(/no longer available/);
		await expect(workspace.use({ name: 'host' }, () => undefined)).rejects.toThrow(
			/no longer available/,
		);
	});

	it('keeps a file database across workspaces, and creates its directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-sqlite-file-'));
		const location = join(dir, 'data', 'lab.db');
		const first = withSql({ location }).workspace;
		await call(first, { sql: "CREATE TABLE kept(v TEXT); INSERT INTO kept VALUES ('x');" });
		await first.dispose();
		const second = withSql({ location }).workspace;
		const read = await call(second, { sql: 'SELECT v FROM kept;' }, 'beta');
		expect(read.text).toContain('| x |');
		expect(read.details.database).toBe(location);
		await second.dispose();
		await rm(dir, { recursive: true, force: true });
	});
});

describe('the import of a CSV file', () => {
	/** Write `text` to ada's `in.csv`, import it as ada, and give the staged rows or the message. */
	async function imported(text: string): Promise<unknown> {
		const { workspace } = withSql();
		await workspace.use({ name: 'host' }, (env) => env.writeFile('/home/ada/in.csv', text, ctx));
		const owner = workspace.sql;
		if (owner === undefined) throw new Error('The workspace has no SQL backend.');
		const outcome = await owner.use({ name: 'ada' }, (env) =>
			env.run('SELECT * FROM import.rows', { maxRows: 50, import: 'in.csv' }, ctx),
		);
		await workspace.dispose();
		return outcome.ok ? outcome.rows.map((row) => ({ ...row })) : outcome.message;
	}

	it.each([
		{
			name: 'skips a byte order mark, reads CRLF, and needs no last line break',
			csv: '﻿a,b\r\n1,2\r\n3,4',
			rows: [
				{ a: '1', b: '2' },
				{ a: '3', b: '4' },
			],
		},
		{ name: 'reads a lone CR as a line end', csv: 'a\r1\r', rows: [{ a: '1' }] },
		{
			name: 'reads quoted commas, quotes, and line breaks, \\N as NULL, and an empty value as text',
			csv: 'a,b\n"x,""y""","1\n2"\n\\N,\n',
			rows: [
				{ a: 'x,"y"', b: '1\n2' },
				{ a: null, b: '' },
			],
		},
		{ name: 'stages a header alone as no rows', csv: 'a,b\n', rows: [] },
		{
			name: 'reads an empty line of one column as an empty value',
			csv: 'a\n\n1\n',
			rows: [{ a: '' }, { a: '1' }],
		},
		{
			name: 'keeps a quote inside a bare value as text',
			csv: 'a\n5" pipe\n',
			rows: [{ a: '5" pipe' }],
		},
		{ name: 'reads a quoted \\N as the text \\N', csv: 'a\n"\\N"\n', rows: [{ a: '\\N' }] },
	])('$name', async ({ csv, rows }) => {
		expect(await imported(csv)).toEqual(rows);
	});

	it.each([
		{ name: 'an empty file', csv: '', message: 'The file is empty. It needs a header.' },
		{
			name: 'a column with no name',
			csv: 'a,,c\n',
			message: 'Column 2 of the header has no name.',
		},
		{
			name: 'two names that match without regard to case',
			csv: 'id,ID\n',
			message: "The header names the column 'ID' twice.",
		},
		{
			name: 'a row with the wrong count of values',
			csv: 'a,b\n1,2\n3\n',
			message: 'Row 2 has 1 value, and the header has 2 columns.',
		},
		{
			name: 'a NUL character in a header name',
			csv: 'a\0b\n1\n',
			message: 'Column 1 of the header holds a NUL character.',
		},
		{
			name: 'a quoted value with no end',
			csv: 'a\n"open\n',
			message: 'The file ends inside a quoted value.',
		},
		{
			name: 'text after a closing quote',
			csv: 'a,b\n"x"y,1\n',
			message: 'A quoted value must end at a comma or at a line break.',
		},
	])('refuses $name, and names the file', async ({ csv, message }) => {
		expect(await imported(csv)).toBe(`The import of /home/ada/in.csv failed. ${message}`);
	});
});

describe('a workspace with no SQL backend and no audit log', () => {
	it('has no SQL owner, no sql tool, and no sql or audit guidance', () => {
		const workspace = openWorkspace({ name: 'lab', backend: { bash: memoryBackend() } });
		expect(workspace.sql).toBeUndefined();
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'ps',
			'status',
			'wait',
			'cancel',
		]);
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain(
			'eight tools: read, write, edit, bash, ps, status, wait and cancel.',
		);
		expect(guidance).not.toMatch(/\bsql\b/);
		expect(guidance).not.toContain('audit');
	});
});
