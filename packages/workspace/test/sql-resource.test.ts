import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { afterEach, describe, expect, it } from 'vitest';
import { openWorkspace } from '../src/index.ts';
import { memoryBackend } from '../src/just-bash.ts';
import type { WorkspaceResource } from '../src/resource.ts';
import { openSqlResource, type SqlResource } from '../src/sql-resource.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	id INTEGER PRIMARY KEY,
	label TEXT NOT NULL,
	agent TEXT,
	room TEXT,
	activation TEXT,
	exchange_owner TEXT,
	exchange_from TEXT,
	at TEXT
);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT);
`;

const context: ToolContext = {
	agent: { name: 'design', identity: 'design' },
	callId: 'call-1',
	room: 'bringup',
	activation: 'act-7',
	exchange: { owner: 'mira', from: 3 },
};

const directories: string[] = [];
const opened: SqlResource[] = [];

function open(options: Partial<Parameters<typeof openSqlResource>[0]> = {}): SqlResource {
	const resource = openSqlResource({
		name: 'lab',
		location: ':memory:',
		schema: SCHEMA,
		writable: ['runs'],
		...options,
	});
	opened.push(resource);
	return resource;
}

function toolOf(resource: SqlResource, name: string): AmbionTool {
	const found = resource.tools().tools.find((tool) => tool.name === name);
	if (!found) throw new Error(`No tool ${name}`);
	return found;
}

afterEach(async () => {
	await Promise.all(opened.splice(0).map((resource) => resource.dispose()));
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Invoke the tool `name` on `resource`, with a synchronous throw turned into a rejection. */
const invoke = async (
	resource: SqlResource,
	name: string,
	params: unknown,
	toolContext = context,
) => toolOf(resource, name).invoke(params, toolContext);

describe('the SQL resource', () => {
	it('records a row with provenance from the tool context, and reads it back as a Markdown table', async () => {
		const resource = open();
		expect(await invoke(resource, 'record', { table: 'runs', values: { label: 'first' } })).toBe(
			'Recorded row 1 in runs.',
		);
		const shown = await invoke(resource, 'query', { sql: 'SELECT id, label FROM runs' });
		expect(shown).toContain('| id | label |');
		expect(shown).toContain('| 1 | first |');
		expect(shown).toContain('1 row.');
		const rows = await resource.use(context.agent, (env) => env.query('SELECT * FROM runs'));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			label: 'first',
			agent: 'design',
			room: 'bringup',
			activation: 'act-7',
			exchange_owner: 'mira',
			exchange_from: '3',
		});
		expect(Date.parse(String(rows[0]?.at))).not.toBeNaN();
	});

	it('refuses a write sent through query, also after a PRAGMA tries to lift the guard', async () => {
		const resource = open();
		await invoke(resource, 'query', { sql: 'PRAGMA query_only = OFF' }).catch(() => undefined);
		for (const sql of [
			"INSERT INTO runs (label) VALUES ('x')",
			"UPDATE runs SET label = 'y'",
			'CREATE TABLE extra (a)',
			'DROP TABLE notes',
		]) {
			await expect(invoke(resource, 'query', { sql }), sql).rejects.toThrow();
		}
		await expect(
			resource.use(context.agent, (env) => env.query('SELECT * FROM runs')),
		).resolves.toEqual([]);
	});

	it.each([
		['notes', { body: 'x' }, /does not accept records/],
		['sqlite_master', { name: 'x' }, /does not accept records/],
		['runs', { label: 'x', nope: 1 }, /no column 'nope'/],
		['runs', { label: 'x', agent: 'someone' }, /reserved for provenance/],
	])('refuses a record into %s of %j', async (table, values, error) => {
		await expect(invoke(open(), 'record', { table, values })).rejects.toThrow(error);
	});

	it('shows a truncation footer past the row cap', async () => {
		const resource = open({ maxRows: 2 });
		for (const label of ['a', 'b', 'c']) {
			await invoke(resource, 'record', { table: 'runs', values: { label } });
		}
		const shown = await invoke(resource, 'query', { sql: 'SELECT label FROM runs' });
		expect(shown).toContain('Shows 2 of 3 rows.');
		expect(String(shown)).not.toContain('| c |');
	});

	it('serializes calls through the owner, closes once on dispose, and refuses a late call', async () => {
		const resource = open();
		const calls = ['a', 'b', 'c'].map((label) =>
			invoke(resource, 'record', { table: 'runs', values: { label } }),
		);
		await expect(Promise.all(calls)).resolves.toEqual([
			'Recorded row 1 in runs.',
			'Recorded row 2 in runs.',
			'Recorded row 3 in runs.',
		]);
		await resource.dispose();
		await resource.dispose();
		await expect(
			invoke(resource, 'record', { table: 'runs', values: { label: 'late' } }),
		).rejects.toThrow(/no longer available/);
		await expect(resource.use(context.agent, (env) => env.query('SELECT 1'))).rejects.toThrow(
			/no longer available/,
		);
	});

	it('honors an abort signal before it queries', async () => {
		const controller = new AbortController();
		controller.abort(new Error('cut'));
		await expect(
			invoke(open(), 'query', { sql: 'SELECT 1' }, { ...context, signal: controller.signal }),
		).rejects.toThrow('cut');
	});

	it('keeps its records across a restart of the database file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-sql-'));
		directories.push(dir);
		const location = join(dir, 'lab.db');
		const first = open({ location });
		await invoke(first, 'record', { table: 'runs', values: { label: 'kept' } });
		await first.dispose();
		const second = open({ location });
		const rows = await second.use(context.agent, (env) => env.query('SELECT label FROM runs'));
		expect(rows).toEqual([{ label: 'kept' }]);
	});

	it('is a second resource on the one contract beside a workspace', async () => {
		const drive = openWorkspace({ name: 'drive', backend: { bash: memoryBackend() } });
		const sql = open();
		const resources: WorkspaceResource[] = [drive, sql];
		expect(resources.map((resource) => resource.name)).toEqual(['drive', 'lab']);
		expect(sql.tools().tools.map((tool) => tool.name)).toEqual(['query', 'record']);
		expect(drive.tools().tools.map((tool) => tool.name)).not.toContain('query');
		await drive.dispose();
	});
});
