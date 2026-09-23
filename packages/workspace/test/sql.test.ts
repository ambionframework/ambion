import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../src/index.ts';
import { BACKGROUND_CONTEXT, openWorkspace } from '../src/index.ts';
import { memoryBackend } from '../src/just-bash.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';

const agent = (name: string) => ({ name, identity: `${name} identity` });

/** Call the `sql` tool as one agent, and return its text and details. */
async function sql(
	site: Workspace,
	who: string,
	params: Record<string, unknown>,
): Promise<{ text: string; details: { database: string; rows: number; export?: string } }> {
	const tool = site.tools().tools.find((t) => t.name === 'sql');
	if (tool === undefined) throw new Error('The sql tool is missing.');
	const result = await tool.invoke(params, { agent: agent(who), callId: 'call' });
	if (typeof result === 'string') throw new Error('The sql tool must return a structured result.');
	const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
	return { text, details: result.details as { database: string; rows: number; export?: string } };
}

describe('the sql tool', () => {
	it('lists sql among the workspace tools', () => {
		const site = openWorkspace({
			name: 'tools',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		expect(site.tools().tools.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'bash', 'sql']);
	});

	it('shares a table and a view across agents, and shows a Markdown preview', async () => {
		const site = openWorkspace({
			name: 'share',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		const made = await sql(site, 'alpha', {
			sql: `CREATE TABLE pour(id INTEGER, grade TEXT, tonnes REAL);
INSERT INTO pour VALUES (1,'C30',12.5),(2,'C40',8.0);
SELECT * FROM pour ORDER BY id;`,
		});
		expect(made.text).toContain('| id | grade | tonnes |');
		expect(made.text).toContain('| 1 | C30 | 12.5 |');
		expect(made.details).toMatchObject({ database: ':memory:', rows: 2 });

		// A second agent queries the same shared database, no copy.
		const read = await sql(site, 'beta', {
			sql: 'SELECT grade, sum(tonnes) AS t FROM pour GROUP BY grade ORDER BY grade;',
		});
		expect(read.text).toContain('| C30 | 12.5 |');
		expect(read.text).toContain('| C40 | 8 |');

		// A view alpha creates is data beta reads, and its definition is on record.
		await sql(site, 'alpha', {
			sql: 'CREATE VIEW light AS SELECT id, grade FROM pour WHERE tonnes < 10;',
		});
		const view = await sql(site, 'beta', { sql: 'SELECT * FROM light ORDER BY id;' });
		expect(view.text).toContain('| 2 | C40 |');
		const provenance = await sql(site, 'beta', {
			sql: "SELECT sql FROM sqlite_master WHERE name='light';",
		});
		expect(provenance.text).toContain('CREATE VIEW light AS SELECT id, grade FROM pour');
		await site.dispose();
	});

	it('renders a NULL value as NULL in the preview', async () => {
		const site = openWorkspace({
			name: 'nulls',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		const result = await sql(site, 'alpha', {
			sql: "SELECT 1 AS id, NULL AS note UNION ALL SELECT 2, 'set' ORDER BY id;",
		});
		expect(result.text).toContain('| 1 | NULL |');
		expect(result.text).toContain('| 2 | set |');
		await site.dispose();
	});

	it('joins the shared database with a private in-memory scratch in one statement', async () => {
		const site = openWorkspace({
			name: 'attach',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', {
			sql: "CREATE TABLE part(id INTEGER, name TEXT); INSERT INTO part VALUES (1,'a'),(2,'b'),(3,'c');",
		});
		const joined = await sql(site, 'alpha', {
			sql: `ATTACH ':memory:' AS scratch;
CREATE TABLE scratch.pick(id INTEGER);
INSERT INTO scratch.pick VALUES (1),(3);
SELECT p.id, p.name FROM part p JOIN scratch.pick USING(id) ORDER BY p.id;`,
		});
		expect(joined.text).toContain('| 1 | a |');
		expect(joined.text).toContain('| 3 | c |');
		expect(joined.text).not.toContain('| 2 | b |');
		await site.dispose();
	});

	it('reports no rows for a query that returns none', async () => {
		const site = openWorkspace({
			name: 'empty',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', { sql: 'CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1);' });
		const result = await sql(site, 'alpha', { sql: 'SELECT * FROM t WHERE id > 99;' });
		expect(result.text).toContain('No rows');
		expect(result.details.rows).toBe(0);
		await site.dispose();
	});

	it('returns a SQL error as content, so the agent can correct it', async () => {
		const site = openWorkspace({
			name: 'error',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		const result = await sql(site, 'alpha', { sql: 'SELECT * FROM missing_table;' });
		expect(result.text).toContain('SQL error');
		expect(result.text).toContain('missing_table');
		await site.dispose();
	});

	it('writes the full result as CSV when export is set, and shows the head', async () => {
		const site = openWorkspace({
			name: 'export',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', {
			sql: "CREATE TABLE m(id INTEGER, kind TEXT, amt REAL); INSERT INTO m VALUES (1,'a',1.5),(2,'b',NULL),(3,'c',3.5);",
		});
		const result = await sql(site, 'alpha', {
			sql: 'SELECT * FROM m ORDER BY id;',
			export: '~/out/m.csv',
		});
		expect(result.details.export).toBe('/home/alpha/out/m.csv');
		expect(result.details.rows).toBe(3);
		expect(result.text).toContain('```csv');
		expect(result.text).toContain('id,kind,amt');
		expect(result.text).toContain('2,b,\\N');
		expect(result.text).toContain('Wrote 3 rows');

		// The CSV lands on the shared filesystem and python reads it.
		await site.use(agent('alpha'), async (env) => {
			const csv = await env.readTextFile('/home/alpha/out/m.csv', BACKGROUND_CONTEXT);
			expect(csv.ok && csv.value).toContain('1,a,1.5');
			let output = '';
			const py = await env.exec(
				`python3 - <<'PY'
import csv
rows=list(csv.DictReader(open('/home/alpha/out/m.csv')))
print(len(rows), rows[1]['amt'])
PY`,
				{
					onUpdate: (update) => {
						if (update.kind === 'replace') output = update.output.text;
					},
				},
				BACKGROUND_CONTEXT,
			);
			expect(py.ok && output.trim()).toBe('3 \\N');
		});
		await site.dispose();
	});

	it('caps the preview and points at export for a large result', async () => {
		const site = openWorkspace({
			name: 'cap',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', {
			sql: `CREATE TABLE big(id INTEGER);
WITH RECURSIVE seq(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM seq WHERE id < 200)
INSERT INTO big SELECT id FROM seq;`,
		});
		const result = await sql(site, 'alpha', { sql: 'SELECT * FROM big ORDER BY id;', maxRows: 5 });
		expect(result.text).toContain('Shows 5 of 200 rows');
		expect(result.details.rows).toBe(200);
		await site.dispose();
	});

	it('previews the last query when the script has several', async () => {
		const site = openWorkspace({
			name: 'multi',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		const result = await sql(site, 'alpha', { sql: 'SELECT 1 AS a; SELECT 2 AS b, 3 AS c;' });
		expect(result.text).toContain('| b | c |');
		expect(result.text).toContain('| 2 | 3 |');
		expect(result.text).not.toContain('| a |');
		expect(result.details.rows).toBe(1);
		await site.dispose();
	});

	it('scans the export for RFC 4180 records, so an embedded newline does not inflate the count', async () => {
		const site = openWorkspace({
			name: 'count',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', {
			sql: "CREATE TABLE m(id INTEGER, note TEXT); INSERT INTO m VALUES (1,'line one\nline two'),(2,'plain');",
		});
		const result = await sql(site, 'alpha', {
			sql: 'SELECT * FROM m ORDER BY id;',
			export: '~/m.csv',
		});
		expect(result.details.rows).toBe(2);
		expect(result.text).toContain('Wrote 2 rows');
		await site.dispose();
	});

	it('keeps a quoted newline inside its preview record and its row count exact', async () => {
		const site = openWorkspace({
			name: 'quoted-newline',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', {
			sql: "CREATE TABLE m(id INTEGER, note TEXT); INSERT INTO m VALUES (1,'line one\nline two'),(2,'plain');",
		});
		const result = await sql(site, 'alpha', {
			sql: 'SELECT * FROM m ORDER BY id;',
			export: '~/m.csv',
		});
		expect(result.text).toContain('```csv\nid,note\n1,"line one\nline two"\n2,plain\n```');
		expect(result.details.rows).toBe(2);
		await site.dispose();
	});

	it('keeps an escaped double quote inside a preview value', async () => {
		const site = openWorkspace({
			name: 'escaped-quote',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', {
			sql: `CREATE TABLE m(id INTEGER, note TEXT); INSERT INTO m VALUES (1,'a"b'),(2,'plain');`,
		});
		const result = await sql(site, 'alpha', {
			sql: 'SELECT * FROM m ORDER BY id;',
			export: '~/m.csv',
		});
		expect(result.text).toContain('```csv\nid,note\n1,"a""b"\n2,plain\n```');
		expect(result.details.rows).toBe(2);
		await site.dispose();
	});

	it('leaves an existing export file unchanged when the query fails', async () => {
		const site = openWorkspace({
			name: 'safe-export',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		await sql(site, 'alpha', { sql: 'CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1);' });
		const good = await sql(site, 'alpha', { sql: 'SELECT * FROM t;', export: '~/keep.csv' });
		expect(good.details.rows).toBe(1);
		const bad = await sql(site, 'alpha', { sql: 'SELECT * FROM nope;', export: '~/keep.csv' });
		expect(bad.text).toContain('SQL error');
		// The earlier good file is intact.
		await site.use(agent('alpha'), async (env) => {
			const csv = await env.readTextFile('/home/alpha/keep.csv', BACKGROUND_CONTEXT);
			expect(csv.ok && csv.value).toContain('1');
		});
		await site.dispose();
	});

	it('keeps a file database across workspaces, and creates its directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-sqlite-file-'));
		const location = join(dir, 'data', 'lab.db');
		const first = openWorkspace({
			name: 'first',
			backend: { bash: memoryBackend(), sql: sqliteBackend(location) },
		});
		await sql(first, 'alpha', { sql: "CREATE TABLE kept(v TEXT); INSERT INTO kept VALUES ('x');" });
		await first.dispose();
		const second = openWorkspace({
			name: 'second',
			backend: { bash: memoryBackend(), sql: sqliteBackend(location) },
		});
		const read = await sql(second, 'beta', { sql: 'SELECT v FROM kept;' });
		expect(read.text).toContain('| x |');
		expect(read.details.database).toBe(location);
		await second.dispose();
		await rm(dir, { recursive: true, force: true });
	});
});
