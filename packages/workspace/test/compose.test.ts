/**
 * The declared outputs of the workspace tools, read through `compose` over a
 * real workspace: a directory-free memory shell, a real SQLite file, and a
 * real git backend. Each result passes the check of its declared output, so
 * a drift between a tool and its schema fails here. The `compose` field must
 * survive `audited` and `withSkills`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmbionTool, ToolBundle } from '@ambionframework/ambion';
import { describe, expect, it, onTestFinished } from 'vitest';
import { justGitBackend, sqliteGitStorage } from '../../just-bash/src/git/index.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { fromDirectory, loadSkills, openWorkspace, type Workspace } from '../src/index.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';
import { composed } from './support/compose.ts';

let serial = 0;

/** A temporary directory that the test removes at its end. */
async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-compose-ws-'));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

interface Lab {
	readonly workspace: Workspace;
}

/** A workspace with a memory shell, a SQLite file, and a git backend with one template. */
async function lab(options: { audit?: boolean } = {}): Promise<Lab> {
	const dir = await scratch();
	serial += 1;
	const workspace = openWorkspace({
		name: `compose-${serial}`,
		backend: {
			bash: memoryBackend({
				git: justGitBackend({
					storage: sqliteGitStorage(join(dir, 'git.db')),
					secret: 'test-secret',
					templates: {
						'weekly-report': { description: 'A report.', source: { 'report.md': '# Week\n' } },
					},
				}),
			}),
			sql: sqliteBackend(join(dir, 'lab.db')),
		},
		...(options.audit ? { audit: {} } : {}),
	});
	onTestFinished(() => workspace.dispose());
	return { workspace };
}

/** Write `content` to `path` as `agent`. */
async function put(workspace: Workspace, path: string, content: string, agent = 'ada') {
	await workspace.use({ name: agent }, async (env) => {
		const made = await env.createDir(path.slice(0, path.lastIndexOf('/')) || '/', undefined);
		if (!made.ok) throw made.error;
		const written = await env.writeFile(path, content);
		if (!written.ok) throw written.error;
	});
}

/** The value that a completed compose call returned. */
async function returned(workspace: Workspace, uses: string[], code: string) {
	const result = await composed(workspace.tools(), uses, code);
	expect(result.status).toBe('completed');
	expect(result.calls.every((call) => call.status === 'completed')).toBe(true);
	return result.value;
}

describe('a compose call over the workspace', () => {
	it('binds sql and snapshot over a real SQLite file, and returns the count and the refs', async () => {
		const { workspace } = await lab();
		await put(workspace, '/shared/a.md', 'alpha\n');
		await put(workspace, '/shared/b.md', 'beta\n');
		await put(workspace, '/shared/c.md', 'gamma\n');
		await composed(
			workspace.tools(),
			['sql'],
			`await tools.sql({ sql: "CREATE TABLE runs(label TEXT, path TEXT); INSERT INTO runs VALUES ('drift','/shared/a.md'), ('ok','/shared/b.md'), ('drift','/shared/c.md')" });`,
		);
		const value = await returned(
			workspace,
			['sql', 'snapshot'],
			`const drift = await tools.sql({ sql: "SELECT path FROM runs WHERE label = 'drift' ORDER BY path", rows: 500 });
const { refs } = await tools.snapshot({ paths: drift.rows.map((row) => row.path) });
return { runs: drift.count, columns: drift.columns, refs };`,
		);
		const { runs, columns, refs } = value as { runs: number; columns: string[]; refs: string[] };
		expect([runs, columns, refs.length]).toEqual([2, ['path'], 2]);
		expect(refs).toEqual(await workspace.snapshot(['/shared/a.md', '/shared/c.md']));
	});

	it('gives every sql detail: the count, the columns, the preview rows, and the export and import facts', async () => {
		const { workspace } = await lab();
		await put(workspace, '/home/ada/in.csv', 'id,note\n1,a\n2,b\n');
		const value = await returned(
			workspace,
			['sql'],
			`await tools.sql({ sql: "CREATE TABLE t(id INTEGER, note TEXT, blob BLOB, ratio REAL); INSERT INTO t VALUES (1,'x',x'00ff10',0.5),(2,NULL,x'',2.0),(3,'z',NULL,NULL)" });
const preview = await tools.sql({ sql: 'SELECT id, note, blob, ratio FROM t ORDER BY id', rows: 2 });
const exported = await tools.sql({ sql: 'SELECT id FROM t ORDER BY id', rows: 1, export: '~/t.csv' });
const imported = await tools.sql({ sql: 'SELECT count(*) AS n FROM import.rows', import: '~/in.csv' });
return { preview, exported, imported };`,
		);
		expect(value).toEqual({
			preview: {
				database: expect.any(String),
				count: 3,
				columns: ['id', 'note', 'blob', 'ratio'],
				rows: [
					{ id: 1, note: 'x', blob: '00ff10', ratio: 0.5 },
					{ id: 2, note: null, blob: '', ratio: 2 },
				],
			},
			exported: {
				database: expect.any(String),
				count: 3,
				columns: ['id'],
				rows: [{ id: 1 }],
				export: '/home/ada/t.csv',
			},
			imported: {
				database: expect.any(String),
				count: 1,
				columns: ['n'],
				rows: [{ n: 2 }],
				import: '/home/ada/in.csv',
				imported: 2,
			},
		});
	});

	it('gives the facts of a process: the handle, the state, the output read, and the cut', async () => {
		const { workspace } = await lab();
		const value = (await returned(
			workspace,
			['bash'],
			`const quick = await tools.bash({ command: 'echo hi', wait: 20 });
const long = await tools.bash({ command: 'seq 1 5000', wait: 20 });
return { quick, long };`,
		)) as Record<
			'quick' | 'long',
			{ process: object; text: string; read: object; truncation?: object }
		>;
		expect(value.quick).toEqual({
			process: expect.objectContaining({
				handle: expect.stringMatching(/^bash-[0-9a-f]{12}$/),
				state: 'exited',
				exitCode: 0,
				command: 'echo hi',
				kind: 'bash',
				agent: 'ada',
			}),
			text: 'hi',
			read: { from: 0, to: 3 },
		});
		expect(value.long.text).toContain('5000');
		expect(value.long.truncation).toMatchObject({ truncated: true, truncatedBy: 'lines' });
	});

	it('gives the processes of ps, and the details of status, cancel, and wait for one and for several handles', async () => {
		const { workspace } = await lab();
		const value = (await returned(
			workspace,
			['bash', 'ps', 'status', 'cancel', 'wait'],
			`const sleeper = await tools.bash({ command: 'sleep 30', wait: 0 });
const quick = await tools.bash({ command: 'echo done', wait: 0 });
const one = await tools.wait({ handles: [quick.process.handle], timeout: 20 });
const running = await tools.ps({});
const several = await tools.wait({
  handles: [sleeper.process.handle, quick.process.handle],
  timeout: 20,
});
const status = await tools.status({ handle: sleeper.process.handle });
let cancelled;
try {
  cancelled = await tools.cancel({ handle: sleeper.process.handle });
} catch (error) {
  cancelled = error.details;
}
return {
  running: running.processes.map((p) => p.state),
  one: one.process.state,
  several: { processes: several.processes.map((p) => p.state), ended: several.ended.length },
  status: status.process.state,
  cancelled: cancelled.process.state,
};`,
		)) as Record<string, unknown>;
		expect(value.running).toEqual(['running']);
		expect(value.one).toBe('exited');
		expect(value.several).toEqual({ processes: ['running', 'exited'], ended: 1 });
		expect(value.status).toBe('running');
		expect(value.cancelled).toBe('cancelled');
	});

	it('gives the repository that fork made, and the path of its clone', async () => {
		const { workspace } = await lab();
		const value = await returned(
			workspace,
			['fork'],
			`return await tools.fork({ source: 'templates/weekly-report', name: 'report', clone: 'report' });`,
		);
		expect(value).toEqual({
			repository: expect.stringMatching(/report$/),
			source: 'templates/weekly-report',
			url: expect.stringContaining('report'),
			clone: '/home/ada/report',
		});
	});
});

describe('the declared outputs of the file, snapshot, and git tools', () => {
	it('gives read the text with no notice, and where the text sits in the file', async () => {
		const { workspace } = await lab();
		await put(workspace, '/home/ada/five.txt', 'a\nb\nc\nd\ne');
		await put(workspace, '/home/ada/big.txt', `${'x'.repeat(100)}\n`.repeat(3000));
		await put(workspace, '/home/ada/wide.txt', `${'y'.repeat(60_000)}\nnext\n`);
		await put(workspace, '/home/ada/pic.gif', 'GIF89a');
		const value = (await returned(
			workspace,
			['read'],
			`const whole = await tools.read({ path: 'five.txt' });
const limited = await tools.read({ path: 'five.txt', offset: 2, limit: 2 });
const big = await tools.read({ path: 'big.txt' });
const wide = await tools.read({ path: 'wide.txt' });
const pic = await tools.read({ path: 'pic.gif' });
return { whole, limited, big, wide, pic };`,
		)) as Record<'whole' | 'limited' | 'big' | 'wide' | 'pic', Record<string, unknown>>;
		expect(value.whole).toEqual({
			path: '/home/ada/five.txt',
			text: 'a\nb\nc\nd\ne',
			from: 1,
			to: 5,
			lines: 5,
		});
		expect(value.limited).toEqual({
			path: '/home/ada/five.txt',
			text: 'b\nc',
			from: 2,
			to: 3,
			lines: 5,
			next: 4,
		});
		expect(value.big).toMatchObject({ from: 1, lines: 3000, truncation: { truncated: true } });
		expect(value.big.next).toBe((value.big.to as number) + 1);
		expect(String(value.big.text)).not.toContain('Use offset');
		expect(value.wide).toEqual({
			path: '/home/ada/wide.txt',
			text: '',
			from: 1,
			to: 0,
			lines: 2,
			truncation: expect.objectContaining({ firstLineExceedsLimit: true }),
		});
		expect(value.pic).toEqual({
			path: '/home/ada/pic.gif',
			text: '',
			image: { mimeType: 'image/gif' },
		});
	});

	it('gives restore the ref, the path, and the size, and clone and repos their facts', async () => {
		const { workspace } = await lab();
		await put(workspace, '/home/ada/a.md', 'alpha\n');
		const value = (await returned(
			workspace,
			['snapshot', 'restore', 'clone', 'repos'],
			`const { refs } = await tools.snapshot({ paths: ['/home/ada/a.md'] });
const restored = await tools.restore({ ref: refs[0], path: '~/back.md' });
const cloned = await tools.clone({ source: 'templates/weekly-report', path: '~/copy' });
const listed = await tools.repos({ namespace: 'templates' });
return { ref: refs[0], restored, cloned, listed };`,
		)) as { ref: string; restored: unknown; cloned: unknown; listed: unknown };
		expect(value.restored).toEqual({ ref: value.ref, path: '/home/ada/back.md', bytes: 6 });
		expect(value.cloned).toEqual({
			repository: 'templates/weekly-report',
			source: 'templates/weekly-report',
			url: expect.stringContaining('weekly-report'),
			clone: '/home/ada/copy',
		});
		expect(value.listed).toEqual({
			server: expect.any(String),
			repositories: [
				{
					id: 'templates/weekly-report',
					description: 'A report.',
					defaultBranch: expect.any(String),
					branches: {
						[(value.listed as { repositories: [{ defaultBranch: string }] }).repositories[0]
							.defaultBranch]: expect.stringMatching(/^[0-9a-f]{40,64}$/),
					},
					url: expect.stringContaining('weekly-report'),
				},
			],
		});
	});
});

describe('the compose field of the workspace tools', () => {
	/** The tools of `bundle` that declare an output, with the schema they declare. */
	const declared = (bundle: ToolBundle): Record<string, AmbionTool['compose']> =>
		Object.fromEntries(
			bundle.tools.filter((tool) => tool.compose).map((tool) => [tool.name, tool.compose]),
		);

	it('names the outputs, and survives audited and withSkills', async () => {
		const { workspace } = await lab();
		const { workspace: audited } = await lab({ audit: true });
		const dir = await scratch();
		await mkdir(join(dir, 'tidy'));
		await writeFile(
			join(dir, 'tidy', 'SKILL.md'),
			'---\nname: tidy\ndescription: Tidy up.\n---\nTidy up.\n',
		);
		const skills = await loadSkills(fromDirectory(dir));
		const plain = declared(workspace.tools());
		expect(Object.keys(plain).sort()).toEqual([
			'bash',
			'cancel',
			'clone',
			'fork',
			'ps',
			'read',
			'repos',
			'restore',
			'snapshot',
			'sql',
			'status',
			'wait',
		]);
		expect(declared(audited.tools())).toEqual(plain);
		expect(declared(workspace.tools({ skills }))).toEqual(plain);
		expect(declared(audited.tools({ skills }))).toEqual(plain);
	});
});
