import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlResource } from '../src/index.ts';
import type { SqlResource } from '../src/sql-resource.ts';

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

describe('the SQL resource', () => {
	it('records a row and reads it back as a Markdown table', async () => {
		const resource = open();
		const recorded = await toolOf(resource, 'record').invoke(
			{ table: 'runs', values: { label: 'first' } },
			context,
		);
		expect(recorded).toBe('Recorded row 1 in runs.');
		const shown = await toolOf(resource, 'query').invoke(
			{ sql: 'SELECT id, label FROM runs' },
			context,
		);
		expect(shown).toContain('| id | label |');
		expect(shown).toContain('| 1 | first |');
		expect(shown).toContain('1 row.');
	});

	it('refuses a write sent through query', async () => {
		const resource = open();
		const query = toolOf(resource, 'query');
		for (const sql of [
			"INSERT INTO runs (label) VALUES ('x')",
			"UPDATE runs SET label = 'y'",
			'CREATE TABLE extra (a)',
			'DROP TABLE notes',
		]) {
			await expect(Promise.resolve().then(() => query.invoke({ sql }, context))).rejects.toThrow();
		}
		await expect(
			resource.use(context.agent, (env) => env.query('SELECT * FROM runs')),
		).resolves.toEqual([]);
	});

	it('keeps query read-only after a PRAGMA tries to lift the guard', async () => {
		const resource = open();
		const query = toolOf(resource, 'query');
		await Promise.resolve(query.invoke({ sql: 'PRAGMA query_only = OFF' }, context)).catch(
			() => undefined,
		);
		await expect(
			Promise.resolve().then(() =>
				query.invoke({ sql: "INSERT INTO runs (label) VALUES ('x')" }, context),
			),
		).rejects.toThrow();
	});

	it('refuses a record outside the writable tables', async () => {
		const resource = open();
		await expect(
			Promise.resolve().then(() =>
				toolOf(resource, 'record').invoke({ table: 'notes', values: { body: 'x' } }, context),
			),
		).rejects.toThrow(/does not accept records/);
		await expect(
			Promise.resolve().then(() =>
				toolOf(resource, 'record').invoke(
					{ table: 'sqlite_master', values: { name: 'x' } },
					context,
				),
			),
		).rejects.toThrow(/does not accept records/);
	});

	it('refuses an unknown column and a forged provenance column', async () => {
		const resource = open();
		const record = toolOf(resource, 'record');
		await expect(
			Promise.resolve().then(() =>
				record.invoke({ table: 'runs', values: { label: 'x', nope: 1 } }, context),
			),
		).rejects.toThrow(/no column 'nope'/);
		await expect(
			Promise.resolve().then(() =>
				record.invoke({ table: 'runs', values: { label: 'x', agent: 'someone' } }, context),
			),
		).rejects.toThrow(/reserved for provenance/);
	});

	it('stamps provenance from the tool context', async () => {
		const resource = open();
		await toolOf(resource, 'record').invoke({ table: 'runs', values: { label: 'a' } }, context);
		const rows = await resource.use(context.agent, (env) => env.query('SELECT * FROM runs'));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			label: 'a',
			agent: 'design',
			room: 'bringup',
			activation: 'act-7',
			exchange_owner: 'mira',
			exchange_from: '3',
		});
		expect(Date.parse(String(rows[0]?.at))).not.toBeNaN();
	});

	it('shows a truncation footer past the row cap', async () => {
		const resource = open({ maxRows: 2 });
		const record = toolOf(resource, 'record');
		for (const label of ['a', 'b', 'c']) {
			await record.invoke({ table: 'runs', values: { label } }, context);
		}
		const shown = await toolOf(resource, 'query').invoke(
			{ sql: 'SELECT label FROM runs' },
			context,
		);
		expect(shown).toContain('Shows 2 of 3 rows.');
		expect(String(shown)).not.toContain('| c |');
	});

	it('serializes calls through the owner and refuses a late call', async () => {
		const resource = open();
		const record = toolOf(resource, 'record');
		const calls = ['a', 'b', 'c'].map((label) =>
			record.invoke({ table: 'runs', values: { label } }, context),
		);
		await expect(Promise.all(calls)).resolves.toEqual([
			'Recorded row 1 in runs.',
			'Recorded row 2 in runs.',
			'Recorded row 3 in runs.',
		]);
		await resource.dispose();
		await expect(
			Promise.resolve().then(() =>
				record.invoke({ table: 'runs', values: { label: 'late' } }, context),
			),
		).rejects.toThrow(/no longer available/);
	});

	it('closes the handles once on destroy and refuses a later use', async () => {
		const resource = open();
		await resource.destroy();
		await resource.destroy();
		await resource.dispose();
		await expect(resource.use(context.agent, (env) => env.query('SELECT 1'))).rejects.toThrow(
			/no longer available/,
		);
	});

	it('honors an abort signal before it queries', async () => {
		const resource = open();
		const controller = new AbortController();
		controller.abort(new Error('cut'));
		await expect(
			Promise.resolve().then(() =>
				toolOf(resource, 'query').invoke(
					{ sql: 'SELECT 1' },
					{ ...context, signal: controller.signal },
				),
			),
		).rejects.toThrow('cut');
	});

	it('keeps its records across a restart of the database file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-sql-'));
		directories.push(dir);
		const location = join(dir, 'lab.db');
		const first = open({ location });
		await toolOf(first, 'record').invoke({ table: 'runs', values: { label: 'kept' } }, context);
		await first.dispose();
		const second = open({ location });
		const rows = await second.use(context.agent, (env) => env.query('SELECT label FROM runs'));
		expect(rows).toEqual([{ label: 'kept' }]);
	});
});
