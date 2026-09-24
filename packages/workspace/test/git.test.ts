/**
 * A workspace with a git backend: the `repos` and `fork` tools and their
 * texts, the tool line and the order of the notes, the audit entry of a
 * call, and a room in which a seat forks a template, clones it, edits,
 * commits, and pushes. The backend is `gitBackend`, reached by relative
 * path the same way as the just-bash source; its own package runs the
 * conformance cases.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { callTool, quiet, speak } from '../../ambion/test/support/scripted.ts';
import { gitBackend, sqliteGitStorage } from '../../git/src/index.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { defaultToolGuidance } from '../src/default-tools.ts';
import { gitToolGuidance } from '../src/git-tools.ts';
import { BACKGROUND_CONTEXT, openWorkspace } from '../src/index.ts';
import { roomMirrorGuidance } from '../src/mirror.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';
import { callAs, invokeText, toolOf } from './support/backends.ts';
import { agent, run, toolResults } from './support/room.ts';

const SERVER = 'http://git.ambion.invalid';
const TEMPLATES = {
	'weekly-report': {
		description: 'A weekly status report.',
		source: { 'report.md': '# Week\n' },
	},
};

async function tempFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-git-ws-'));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return join(dir, 'git.db');
}

async function lab(options: { sql?: boolean; audit?: boolean; templates?: typeof TEMPLATES } = {}) {
	const git = gitBackend({
		storage: sqliteGitStorage(await tempFile()),
		secret: 'test-secret',
		templates: options.templates ?? TEMPLATES,
	});
	const bash = memoryBackend();
	const workspace = openWorkspace({
		name: 'lab',
		backend: { bash, git, ...(options.sql ? { sql: sqliteBackend(':memory:') } : {}) },
		...(options.audit ? { audit: {} } : {}),
	});
	onTestFinished(() => workspace.dispose());
	return { workspace, bash };
}

const text = (
	workspace: Awaited<ReturnType<typeof lab>>['workspace'],
	tool: string,
	params: unknown,
	who = 'analyst',
) => invokeText(toolOf(workspace, tool), params, callAs(who));

describe('the tools and the guidance', () => {
	it('adds repos and fork after sql, counts the tools, and places the git note after the SQL notes', async () => {
		const { workspace } = await lab({ sql: true });
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'status',
			'wait',
			'cancel',
			'sql',
			'repos',
			'fork',
		]);
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance.startsWith(defaultToolGuidance(['sql', 'repos', 'fork']))).toBe(true);
		expect(guidance).toContain(
			'ten tools: read, write, edit, bash, status, wait, cancel, sql, repos and fork.',
		);
		const git = guidance.indexOf(gitToolGuidance(SERVER));
		expect(git).toBeGreaterThan(guidance.indexOf('sql runs statements'));
		expect(git).toBeLessThan(guidance.indexOf('The shell is a simulated Unix shell'));
		expect(guidance.endsWith(roomMirrorGuidance('/rooms'))).toBe(true);
	});

	it('counts nine tools with no SQL backend, and states the shell sentence that holds with a git backend', async () => {
		const { workspace } = await lab();
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain(
			'nine tools: read, write, edit, bash, status, wait, cancel, repos and fork.',
		);
		expect(guidance).toContain('or a URL\nthat this guidance names. git reaches no other host.');
		expect(guidance).toContain(`repos and fork reach the git server of this workspace, ${SERVER}.`);
		const plain = openWorkspace({ name: 'plain', backend: { bash: memoryBackend() } });
		expect(plain.tools().guidance).toContain('git reaches no other host.');
		expect(plain.tools().tools.map((tool) => tool.name)).not.toContain('fork');
		expect(plain.git).toBeUndefined();
	});
});

describe('repos', () => {
	it('lists each repository as a table line, with a count', async () => {
		const { workspace } = await lab();
		await workspace.git?.use({ name: 'analyst' }, (env) =>
			env.fork('templates/weekly-report', 'report'),
		);
		const listed = await text(workspace, 'repos', {});
		const lines = listed.split('\n');
		expect(lines[0]).toBe('| Repository | Description | Forked from | Branches | URL |');
		expect(lines[2]).toMatch(
			/^\| analyst\/report \| {2}\| templates\/weekly-report \| main [0-9a-f]{7} \| http:\/\/git\.ambion\.invalid\/analyst\/report \|$/,
		);
		expect(lines[3]).toContain('| templates/weekly-report | A weekly status report. |  | main ');
		expect(listed.endsWith('\n\n2 repositories.')).toBe(true);
		expect(await text(workspace, 'repos', { namespace: 'nobody' })).toBe(
			`No repositories on ${SERVER}.`,
		);
	});

	it('shows five branches of a repository, and counts the others', async () => {
		const { workspace } = await lab();
		await text(workspace, 'fork', {
			source: 'templates/weekly-report',
			name: 'report',
			clone: '~/report',
		});
		const branches = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map(
			(name) => `git branch ${name} && git push origin ${name}`,
		);
		const pushed = await workspace.use({ name: 'analyst' }, (env) =>
			env.exec(`cd ~/report && ${branches.join(' && ')}`, undefined, BACKGROUND_CONTEXT),
		);
		expect(pushed.ok && pushed.value.exitCode).toBe(0);
		const line = (await text(workspace, 'repos', { namespace: 'analyst' })).split('\n')[2] ?? '';
		expect(line).toMatch(
			/\| main [0-9a-f]{7}, b1 [0-9a-f]{7}, b2 [0-9a-f]{7}, b3 [0-9a-f]{7}, b4 [0-9a-f]{7}, and 2 more \|/,
		);
	});
});

describe('fork', () => {
	it('forks, clones on the default branch, and gives the clone URL', async () => {
		const { workspace } = await lab();
		const forked = await text(workspace, 'fork', {
			source: 'templates/weekly-report',
			name: 'report',
			clone: '~/report',
		});
		expect(forked).toBe(
			[
				`Forked templates/weekly-report to analyst/report. Clone URL: ${SERVER}/analyst/report`,
				'Cloned it into /home/analyst/report on branch main. origin is the fork.',
			].join('\n'),
		);
		const read = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('/home/analyst/report/report.md', BACKGROUND_CONTEXT),
		);
		expect(read.ok && read.value).toBe('# Week\n');
	});

	it('refuses a missing source, and clones a taken name only when the path is free', async () => {
		const { workspace } = await lab();
		expect(await text(workspace, 'fork', { source: 'templates/none', name: 'x' })).toBe(
			'templates/none does not exist. Call repos to list the repositories.',
		);
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		const again = await text(workspace, 'fork', {
			source: 'templates/weekly-report',
			name: 'report',
			clone: 'report',
		});
		expect(again).toBe(
			[
				`analyst/report exists. Clone URL: ${SERVER}/analyst/report.`,
				'Cloned it into /home/analyst/report on branch main. origin is the fork.',
			].join('\n'),
		);
		const third = await text(workspace, 'fork', {
			source: 'templates/weekly-report',
			name: 'report',
			clone: 'report',
		});
		expect(third.split('\n')[1]).toBe(
			'/home/analyst/report already exists, so the tool made no clone.',
		);
	});

	it('keeps the fork when the clone fails, and says how to clone it', async () => {
		const { workspace } = await lab();
		await workspace.use({ name: 'analyst' }, (env) =>
			env.writeFile('/home/analyst/busy/file.txt', 'in the way', BACKGROUND_CONTEXT),
		);
		const forked = await text(workspace, 'fork', {
			source: 'templates/weekly-report',
			name: 'report',
			clone: '~/busy',
		});
		const [, failure] = forked.split('\n');
		expect(failure).toMatch(
			/^The clone into \/home\/analyst\/busy failed: .+\. The fork stays; clone http:\/\/git\.ambion\.invalid\/analyst\/report\.$/s,
		);
		const fork = await workspace.git?.use({ name: 'analyst' }, (env) => env.get('analyst/report'));
		expect(fork?.source).toBe('templates/weekly-report');
	});

	it('records a fork call in the audit log on the shell', async () => {
		const { workspace } = await lab({ audit: true });
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		const log = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('/workspace/audit.jsonl', BACKGROUND_CONTEXT),
		);
		const entries = (log.ok ? log.value : '')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(entries).toMatchObject([
			{
				tool: 'fork',
				agent: 'analyst',
				arguments: { source: 'templates/weekly-report', name: 'report' },
			},
		]);
	});
});

describe('a seat in a room', () => {
	it('forks a template, clones it, edits, commits, and pushes a branch that the host reads', async () => {
		const { workspace } = await lab();
		const results: { tool: string; text: string; failed: boolean }[][] = [];
		await run([agent('analyst', { bundles: [workspace.tools()] })], {
			analyst: (context, _who, call) => {
				results.push(toolResults(context));
				const steps = [
					callTool('fork', {
						source: 'templates/weekly-report',
						name: 'report',
						clone: '~/report',
					}),
					callTool('bash', { command: 'cd ~/report && git switch -c week-39' }),
					callTool('edit', {
						path: '~/report/report.md',
						oldText: '# Week\n',
						newText: '# Week 39\n\nThe numbers are in.\n',
					}),
					callTool('bash', { command: 'cd ~/report && git add -A && git commit -m "Week 39"' }),
					callTool('bash', { command: 'cd ~/report && git push origin week-39' }),
				];
				if (call <= steps.length) return steps[call - 1] ?? quiet();
				if (call === steps.length + 1) return speak('Pushed week-39.');
				return quiet();
			},
		});
		const seen = (results.at(-1) ?? []).filter((result) => result.tool !== 'say');
		expect(seen.map((result) => [result.tool, result.failed])).toEqual([
			['fork', false],
			['bash', false],
			['edit', false],
			['bash', false],
			['bash', false],
		]);
		const fork = await workspace.git?.use({ name: 'analyst' }, (env) => env.get('analyst/report'));
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['main', 'week-39']);
		expect(fork?.branches['week-39']).not.toBe(fork?.branches.main);
	});
});
