/**
 * A workspace with a git backend: the `repos`, `clone` and `fork` tools and their
 * texts, the host's `commitRef`, the tool line and the order of the notes, the refusal of a bash
 * backend that does not carry the transport, the audit entry of a call,
 * and a room in which a seat forks a template, clones it, edits,
 * commits, and pushes. The backend is `justGitBackend`, reached by
 * relative path the same way as the just-bash source; its own package runs
 * the conformance cases.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitUri } from '@ambionframework/ambion';
import { describe, expect, it, onTestFinished } from 'vitest';
import { callTool, quiet } from '../../ambion/test/support/scripted.ts';
import { justGitBackend, sqliteGitStorage } from '../../just-bash/src/git/index.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { defaultToolGuidance } from '../src/default-tools.ts';
import { validRefName } from '../src/git-names.ts';
import { gitToolGuidance } from '../src/git-tools.ts';
import { BACKGROUND_CONTEXT, openWorkspace } from '../src/index.ts';
import { roomMirrorGuidance } from '../src/mirror.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';
import { callAs, invokeText, toolOf, wrapped } from './support/backends.ts';
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
	const git = justGitBackend({
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
	it('adds repos, clone and fork after sql, counts the tools, and places the git note after the SQL notes', async () => {
		const { workspace } = await lab({ sql: true });
		expect(workspace.tools().tools.map((tool) => tool.name)).toEqual([
			'read',
			'write',
			'edit',
			'bash',
			'ps',
			'status',
			'wait',
			'cancel',
			'snapshot',
			'restore',
			'sql',
			'repos',
			'clone',
			'fork',
		]);
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance.startsWith(defaultToolGuidance(['sql', 'repos', 'clone', 'fork']))).toBe(true);
		expect(guidance).toContain(
			'fourteen tools: read, write, edit, bash, ps, status, wait, cancel, snapshot, restore, sql, repos, clone and fork.',
		);
		const git = guidance.indexOf(gitToolGuidance(SERVER, 'lab'));
		expect(git).toBeGreaterThan(-1);
		expect(git).toBeGreaterThan(guidance.indexOf('sql runs statements'));
		expect(git).toBeLessThan(guidance.indexOf('The shell is a simulated Unix shell'));
		expect(guidance.endsWith(roomMirrorGuidance('/rooms'))).toBe(true);
	});

	it('counts thirteen tools with no SQL backend, states the form of a commit ref, and states the shell sentence that holds with a git backend', async () => {
		const { workspace } = await lab();
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain(
			'thirteen tools: read, write, edit, bash, ps, status, wait, cancel, snapshot, restore, repos, clone and fork.',
		);
		expect(guidance).toContain(
			'ambion://workspace/lab/repo/<repository>/branch/<branch>/commit/<hash>',
		);
		expect(guidance).toContain('or a URL\nthat this guidance names. git reaches no other host.');
		expect(guidance).toContain(
			`repos, clone and fork reach the git server of this workspace, ${SERVER}.`,
		);
		const plain = openWorkspace({ name: 'plain', backend: { bash: memoryBackend() } });
		expect(plain.tools().guidance).toContain('git reaches no other host.');
		expect(plain.tools().tools.map((tool) => tool.name)).not.toContain('fork');
		expect(plain.git).toBeUndefined();
	});
});

describe('the pair', () => {
	it.each<[string, readonly string[] | undefined, string]>([
		["['ssh']", ['ssh'], 'ssh'],
		['[]', [], 'no git transport'],
		['absent', undefined, 'no git transport'],
	])(
		'refuses justGitBackend beside a bash backend whose gitTransports is %s',
		(_name, gitTransports, carried) => {
			const git = justGitBackend({ storage: sqliteGitStorage(':memory:'), secret: 'test-secret' });
			const bash = wrapped(() => ({ gitTransports }));
			expect(() => openWorkspace({ name: 'lab', backend: { bash, git } })).toThrow(
				`The bash backend cannot reach the git backend at ${SERVER}: the git backend uses the transport in-process, and the bash backend carries ${carried}.`,
			);
		},
	);
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
		await expect(text(workspace, 'fork', { source: 'templates/none', name: 'x' })).rejects.toThrow(
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
		// The fork stands, and the failed clone fails the call.
		const forked = await text(workspace, 'fork', {
			source: 'templates/weekly-report',
			name: 'report',
			clone: '~/busy',
		}).then(
			() => 'The clone must fail.',
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
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

describe('clone', () => {
	it('checks out a repository without making a fork and keeps the source as origin', async () => {
		const { workspace } = await lab({ audit: true });
		const before = await text(workspace, 'repos', {});
		const result = await toolOf(workspace, 'clone').invoke(
			{ source: 'templates/weekly-report', path: '~/weekly report' },
			callAs('analyst'),
		);
		if (typeof result === 'string')
			throw new Error('The clone tool must return a structured result.');
		const cloned = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		expect(result.details).toMatchObject({
			repository: 'templates/weekly-report',
			source: 'templates/weekly-report',
			url: `${SERVER}/templates/weekly-report`,
			clone: '/home/analyst/weekly report',
		});
		expect(cloned).toBe(
			'Cloned templates/weekly-report into /home/analyst/weekly report on branch main. origin is the source.',
		);
		expect(await text(workspace, 'repos', {})).toBe(before);
		const checkout = await text(workspace, 'bash', {
			command: `cd '/home/analyst/weekly report' && git remote get-url origin && git branch --show-current && cat report.md`,
		});
		expect(checkout).toContain(`${SERVER}/templates/weekly-report`);
		expect(checkout).toContain('main');
		expect(checkout).toContain('# Week');
		const log = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('/workspace/audit.jsonl', BACKGROUND_CONTEXT),
		);
		const entry = (log.ok ? log.value : '')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.find((candidate) => candidate.tool === 'clone');
		expect(entry).toMatchObject({
			tool: 'clone',
			result: {
				details: {
					repository: 'templates/weekly-report',
					source: 'templates/weekly-report',
					url: `${SERVER}/templates/weekly-report`,
					clone: '/home/analyst/weekly report',
				},
			},
		});
	});

	it('can clone an existing agent repository and push with its inherited permissions', async () => {
		const { workspace } = await lab();
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		await text(workspace, 'clone', { source: 'analyst/report', path: '~/copy' });
		const pushed = await workspace.use({ name: 'analyst' }, (env) =>
			env.exec(
				'cd ~/copy && git switch -c cloned-work && git commit --allow-empty -m copied && git push origin cloned-work',
				undefined,
				BACKGROUND_CONTEXT,
			),
		);
		expect(pushed.ok && pushed.value.exitCode).toBe(0);
		const repository = await workspace.git?.use({ name: 'analyst' }, (env) =>
			env.get('analyst/report'),
		);
		expect(repository?.branches['cloned-work']).toMatch(/^[0-9a-f]{40}$/);
	});

	it('fails for a missing source or busy path and audits standalone clone calls', async () => {
		const { workspace } = await lab({ audit: true });
		await expect(
			text(workspace, 'clone', { source: 'templates/none', path: '~/missing' }),
		).rejects.toThrow('templates/none does not exist. Call repos to list the repositories.');
		await workspace.use({ name: 'analyst' }, (env) =>
			env.writeFile('/home/analyst/busy/file.txt', 'in the way', BACKGROUND_CONTEXT),
		);
		await expect(
			text(workspace, 'clone', { source: 'templates/weekly-report', path: '~/busy' }),
		).rejects.toThrow(/^The clone into \/home\/analyst\/busy failed: .+\.$/s);
		const log = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('/workspace/audit.jsonl', BACKGROUND_CONTEXT),
		);
		const entries = (log.ok ? log.value : '')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(entries).toMatchObject([
			{
				tool: 'clone',
				arguments: { source: 'templates/none', path: '~/missing' },
				error: { message: expect.any(String) },
			},
			{
				tool: 'clone',
				arguments: { source: 'templates/weekly-report', path: '~/busy' },
				error: { message: expect.any(String) },
			},
		]);
		expect(await text(workspace, 'repos', {})).toContain('1 repository.');
	});

	it('rejects an aborted clone without creating a destination or changing repositories', async () => {
		const { workspace } = await lab();
		const before = await text(workspace, 'repos', {});
		const controller = new AbortController();
		controller.abort(new Error('cut'));
		await expect(
			toolOf(workspace, 'clone').invoke(
				{ source: 'templates/weekly-report', path: '~/aborted' },
				callAs('analyst', { signal: controller.signal }),
			),
		).rejects.toThrow();
		const destination = await workspace.use({ name: 'analyst' }, (env) =>
			env.exists('/home/analyst/aborted', BACKGROUND_CONTEXT),
		);
		expect(destination.ok && destination.value).toBe(false);
		expect(await text(workspace, 'repos', {})).toBe(before);
	});
});

describe('commitRef', () => {
	it.each([
		['main', true],
		['feature/pour', true],
		['v1.0', true],
		['', false],
		['@', false],
		['a..b', false],
		['a@{1}', false],
		['main~1', false],
		['a b', false],
		['a\tb', false],
		['a\u007fb', false],
		['a//b', false],
		['/a', false],
		['a/', false],
		['.hidden', false],
		['a/.b', false],
		['a.lock', false],
		['a.', false],
	])('reads %j as a git ref name: %s', (name, valid) => {
		expect(validRefName(name)).toBe(valid);
	});

	it.each([
		[{ branch: 'none' }, "analyst/report has no branch 'none'."],
		[{ tag: 'v1' }, "analyst/report has no tag 'v1'."],
		[{ commit: 'abc' }, "'abc' is not a commit hash of 7 to 64 lowercase hex digits."],
		[{ branch: 'main~1' }, "'main~1' is not a valid git branch name."],
	])('refuses %j', async (at, refusal) => {
		const { workspace } = await lab();
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		await expect(workspace.commitRef('analyst/report', at)).rejects.toThrow(refusal);
	});

	it('gives a host the same ref, and refuses a missing repository, a workspace with no git backend, and a ref that readCommit does not read', async () => {
		const { workspace } = await lab();
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		const fork = await workspace.git?.use({ name: 'analyst' }, (env) => env.get('analyst/report'));
		const main = fork?.branches.main ?? '';
		expect(await workspace.commitRef('analyst/report', { commit: main.slice(0, 8) })).toBe(
			commitUri('lab', 'analyst/report', main),
		);
		await expect(workspace.commitRef('analyst/none', { branch: 'main' })).rejects.toThrow(
			"analyst/none has no branch 'main'.",
		);
		const plain = openWorkspace({ name: 'plain', backend: { bash: memoryBackend() } });
		onTestFinished(() => plain.dispose());
		await expect(plain.commitRef('analyst/report', { branch: 'main' })).rejects.toThrow(
			"Workspace 'plain' has no git backend.",
		);
		const long = 'b'.repeat(2000);
		await text(workspace, 'bash', {
			command: `cd ~ && git clone ${fork?.url} long && cd long && git push origin main:refs/heads/${long}`,
			wait: 60,
		});
		await expect(workspace.commitRef('analyst/report', { branch: long })).rejects.toThrow(
			/has 2\d{3} characters, and a ref has at most 2048/,
		);
		await expect(workspace.readCommit('https://x/a')).rejects.toThrow(
			'https://x/a is not a commit ref.',
		);
		await expect(
			workspace.readCommit(commitUri('elsewhere', 'analyst/report', main)),
		).rejects.toThrow("names the workspace 'elsewhere', not 'lab'.");
	});
});

describe('a seat in a room', () => {
	it('forks a template, clones it, edits, commits, pushes a branch that the host reads, and cites the commit that the host checks', async () => {
		const { workspace } = await lab();
		const results: { tool: string; text: string; failed: boolean }[][] = [];
		const room = await run([agent('analyst', { bundles: [workspace.tools()] })], {
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
					callTool('bash', { command: 'cd ~/report && git rev-parse HEAD' }),
				];
				if (call <= steps.length) return steps[call - 1] ?? quiet();
				// The agent writes the ref from the form that the git note states.
				const hash = /[0-9a-f]{40}/.exec(toolResults(context).at(-1)?.text ?? '')?.[0] ?? '';
				const ref = `ambion://workspace/lab/repo/analyst/report/branch/week-39/commit/${hash}`;
				if (call === steps.length + 1)
					return callTool('say', { text: 'Pushed week-39.', refs: [ref] });
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
			['bash', false],
		]);
		const fork = await workspace.git?.use({ name: 'analyst' }, (env) => env.get('analyst/report'));
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['main', 'week-39']);
		const week = fork?.branches['week-39'] ?? '';
		expect(week).not.toBe(fork?.branches.main);
		const said = (await room.read()).messages.find(
			(message) => message.kind === 'said' && message.from === 'analyst',
		);
		// The host checks the cited commit against the server.
		const onServer = await workspace.commitRef('analyst/report', { branch: 'week-39' });
		expect(onServer).toBe(commitUri('lab', 'analyst/report', week, { branch: 'week-39' }));
		expect(said).toMatchObject({ refs: [onServer] });
	});
});
