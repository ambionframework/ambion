/**
 * A workspace with a SQL backend: the conformance cases on the SQLite
 * backend, the `sql` tool over the backend, the export into the shell, the
 * audit entry, the two owners, and disposal. A workspace with no SQL
 * backend has no `sql` tool.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { type SqlConformanceBackend, sqlConformance } from '../src/conformance.ts';
import { openWorkspace, type SqlBackend, type Workspace } from '../src/index.ts';
import { memoryBackend } from '../src/just-bash.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';

const ctx = BACKGROUND_CONTEXT;

const harnesses: readonly SqlConformanceBackend[] = [
	{
		name: 'sqlite in memory',
		open: async () => ({ backend: sqliteBackend(':memory:'), dispose: async () => {} }),
	},
	{
		name: 'sqlite on a file',
		open: async () => {
			const dir = await mkdtemp(join(tmpdir(), 'ambion-sqlite-'));
			return {
				backend: sqliteBackend(join(dir, 'nested', 'lab.db')),
				dispose: () => rm(dir, { recursive: true, force: true }),
			};
		},
	},
];

describe.each(harnesses)('$name', (harness) => {
	for (const c of sqlConformance(harness)) it(c.name, c.run);
});

/** `inner`, and a record of the agents that connected and of each disposal. */
function counted(inner: SqlBackend) {
	const agents: string[] = [];
	let disposals = 0;
	const backend: SqlBackend = {
		...inner,
		connect: (agent, signal) => {
			agents.push(agent.name);
			return inner.connect(agent, signal);
		},
		dispose: async () => {
			disposals += 1;
			await inner.dispose?.();
		},
	};
	return { ...backend, agents, disposals: () => disposals };
}

function toolOf(workspace: Workspace, name: string): AmbionTool {
	const tool = workspace.tools().tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`No tool named ${name}.`);
	return tool;
}

const context = (agent: string, callId = 'call-1'): ToolContext => ({
	agent: { name: agent, identity: `${agent} identity` },
	callId,
	room: 'lobby',
});

async function call(workspace: Workspace, params: unknown, agent = 'ada'): Promise<string> {
	const result = await toolOf(workspace, 'sql').invoke(params, context(agent));
	if (typeof result === 'string') return result;
	return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

async function shellText(workspace: Workspace, path: string): Promise<string | undefined> {
	return workspace.use({ name: 'host' }, async (env) => {
		const read = await env.readTextFile(path, ctx);
		return read.ok ? read.value : undefined;
	});
}

function withSql(options: { audit?: boolean } = {}) {
	const sql = counted(sqliteBackend(':memory:'));
	const workspace = openWorkspace({
		name: 'lab',
		backend: { bash: memoryBackend(), sql },
		...(options.audit ? { audit: {} } : {}),
	});
	return { sql, workspace };
}

describe('a workspace with a SQL backend', () => {
	it('keeps the five default tools, and its sql tool names no database file', () => {
		const { workspace } = withSql();
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'sql',
		]);
		const properties = Object.keys(
			(toolOf(workspace, 'sql').parameters as { properties: Record<string, unknown> }).properties,
		);
		expect(properties.sort()).toEqual(['export', 'maxRows', 'sql']);
	});

	it('states the backend database and its guidance, and not the shell database', () => {
		const { workspace } = withSql();
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain('one shared database, :memory:');
		expect(guidance).toContain('The database is SQLite: dates are functions');
	});

	it('runs statements on the backend as the calling agent', async () => {
		const { sql, workspace } = withSql();
		await call(workspace, { sql: "CREATE TABLE runs (label TEXT); INSERT INTO runs VALUES ('a')" });
		const text = await call(workspace, { sql: 'SELECT label FROM runs' }, 'bob');
		expect(text).toContain('| label |');
		expect(text).toContain('| a |');
		expect(sql.agents).toEqual(['ada', 'bob']);
	});

	it('reports a refused statement with the database name', async () => {
		const { workspace } = withSql();
		const text = await call(workspace, { sql: 'SELECT * FROM missing_table' });
		expect(text).toMatch(/^SQL error on :memory::\n.*missing_table/);
	});

	it('exports the full result as CSV into the shell, where bash reads it', async () => {
		const { workspace } = withSql();
		await call(workspace, {
			sql: `CREATE TABLE t (id INTEGER, note TEXT); INSERT INTO t VALUES (1, 'a, "b"'), (2, NULL), (3, 'x\ny')`,
		});
		const text = await call(workspace, {
			sql: 'SELECT id, note FROM t ORDER BY id',
			export: '~/out/t.csv',
			maxRows: 1,
		});
		expect(text).toContain('Wrote 3 rows to /home/ada/out/t.csv.');
		expect(text).toContain('id,note\n1,"a, ""b"""');
		expect(text).not.toContain('2,\\N');
		expect(await shellText(workspace, '/home/ada/out/t.csv')).toBe(
			'id,note\n1,"a, ""b"""\n2,\\N\n3,"x\ny"\n',
		);
	});

	it('records a sql call in the audit log on the shell', async () => {
		const { workspace } = withSql({ audit: true });
		await call(workspace, { sql: 'SELECT 1 AS one' });
		const log = await shellText(workspace, '/workspace/audit.jsonl');
		const entry = JSON.parse((log ?? '').trim()) as Record<string, unknown>;
		expect(entry).toMatchObject({ agent: 'ada', tool: 'sql', room: 'lobby', callId: 'call-1' });
		expect(entry.arguments).toEqual({ sql: 'SELECT 1 AS one' });
	});

	it('runs a query while a shell operation holds the shell owner', async () => {
		const { workspace } = withSql();
		let release = (): void => {};
		const held = workspace.use(
			{ name: 'host' },
			() => new Promise<void>((done) => (release = done)),
		);
		const text = await call(workspace, { sql: 'SELECT 42 AS answer' });
		expect(text).toContain('| 42 |');
		release();
		await held;
	});

	it('exposes the SQL owner for host code', async () => {
		const { workspace } = withSql();
		const outcome = await workspace.sql?.use({ name: 'host' }, (env) =>
			env.run('SELECT 7 AS n', ctx),
		);
		expect(outcome).toEqual({ ok: true, rows: [{ n: 7 }] });
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
});

describe('a workspace with no SQL backend', () => {
	it('has no SQL owner, no sql tool, and no sql guidance', () => {
		const workspace = openWorkspace({ name: 'lab', backend: { bash: memoryBackend() } });
		expect(workspace.sql).toBeUndefined();
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
		]);
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain('four tools: read, write, edit and bash');
		expect(guidance).not.toMatch(/\bsql\b/);
	});
});
