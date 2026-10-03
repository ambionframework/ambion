/**
 * A workspace with a git backend: the `repos` and `fork` tools and their
 * texts, a clone made with `bash`, the host's `commitRef`, the tool line and
 * the order of the notes, the audit entry of a call, and a room in which a
 * seat forks a template, clones it, edits, commits, and pushes. The backend is `justGitBackend`, reached by
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
import { openWorkspace } from '../src/index.ts';
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
	const git = justGitBackend({
		storage: sqliteGitStorage(await tempFile()),
		secret: 'test-secret',
		templates: options.templates ?? TEMPLATES,
	});
	const bash = memoryBackend({ git });
	const workspace = openWorkspace({
		name: 'lab',
		backend: { bash, ...(options.sql ? { sql: sqliteBackend(':memory:') } : {}) },
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
			'ps',
			'wait',
			'cancel',
			'snapshot',
			'restore',
			'sql',
			'repos',
			'fork',
		]);
		const guidance = workspace.tools().guidance ?? '';
		expect(
			guidance.startsWith(defaultToolGuidance(workspace.tools().tools.map((t) => t.name))),
		).toBe(true);
		expect(guidance).toContain(
			'twelve tools: read, write, edit, bash, ps, wait, cancel, snapshot, restore, sql, repos and fork.',
		);
		const git = guidance.indexOf(gitToolGuidance(SERVER, 'lab'));
		expect(git).toBeGreaterThan(-1);
		expect(git).toBeGreaterThan(guidance.indexOf('sql runs statements'));
		expect(git).toBeLessThan(guidance.indexOf('The shell is a simulated Unix shell'));
		expect(guidance.endsWith(roomMirrorGuidance('/rooms'))).toBe(true);
	});

	it('states the full guidance of a bundle with sql, git and audit', async () => {
		const { workspace } = await lab({ sql: true, audit: true });
		expect(workspace.tools().guidance).toMatchInlineSnapshot(`
			"Your workspace gives you twelve tools: read, write, edit, bash, ps, wait, cancel, snapshot, restore, sql, repos and fork.
			read, write, edit and bash work on shared files. Other agents connected to this
			workspace read and write the same files.

			bash starts each command as a background process and returns its handle, such as bash-1a2b3c4d5e6f.
			Give a long-running process a name, such as tests or dev-server, so you can tell your processes apart.
			The call waits up to wait seconds, 30 by default, and then gives the state of the process and its output.
			The whole output of a process goes to ~/.processes/<handle>/out. Read it with read.
			Each process has a directory, ~/.processes/<handle>/, with its spec, its out, and its exit code when it ends.
			ls ~/.processes lists every process you started that the workspace still keeps.
			wait takes a list of handles and waits for the first of them to end.
			wait with one handle and timeout 0 gives the state and the new output of that process at once.
			cancel takes a handle and stops its process. ps lists your running processes.
			A process keeps running after your activation ends. It stops after timeout seconds, 600 by default.
			A stop sends SIGTERM, then SIGKILL after grace seconds, 10 by default. Raise grace for a process that must clean up.
			No message tells you when a process ends. When your answer needs the result, call wait before you answer.
			A wait stops before your activation ends.
			A process that outlives your activation shows in the reminder at the start of your next activation.
			To check a long process later, call schedule with delaySeconds. The room wakes you with it then.

			To cite a file, call snapshot with its path, and put the ref it gives in the refs of a
			say. The ref has the form ambion://workspace/lab/snapshot/<digest>/<path>. It
			names the bytes the file holds at the snapshot, and a later change to the file does not
			change them. To read a cited snapshot, call restore with its ref: restore puts the bytes in
			a file of your own and gives its path.

			sql runs statements on one shared database, :memory:. Every agent queries this
			database. Put structured data that a colleague needs here as a named table or view:
			the colleague queries it by its name at once, with no copy. Reach this database with
			sql alone. The
			tool shows the last result as a table and keeps the data in the database. Set export to
			write the full result as a CSV file in your workspace for another tool or script.
			Set import to read a CSV file with a header from your workspace, up to 32 MiB. Its rows
			are the table import.rows for that call alone: every value is text, and \\N is NULL. Copy
			them in the same call with INSERT INTO ... SELECT, and CAST each value. Wait for the
			process that writes the file before you import it. Give a value that comes from outside, such
			as a name or a label, in params: write ? in the statement, and list the values in order.
			params takes one statement.

			The database is SQLite: dates are functions, || joins text, and a column type is an
			affinity. Attach a private scratch database with ATTACH ':memory:' inside one call;
			ATTACH opens no file, and VACUUM INTO is refused. Commit a transaction within the call
			that begins it. sqlite_master holds the definition of each view. A call stops after 30
			seconds.

			repos and fork reach the git server of this workspace, http://git.ambion.invalid.
			templates/<name> is a read-only template. shared/<name> is a repository every agent can write.
			<agent>/<name> belongs to that agent. You can read every repository.
			You push to <your name>/<name> and to shared/<name>. Before a shared push, fetch and rebase onto origin/main.
			If a push is rejected because another agent pushed first, fetch, rebase, resolve conflicts, and retry.
			To check out a repository without forking it, take its clone URL from repos and run git clone <url> <path> with bash.
			Its origin is the source, with the source's push permissions. A clone of shared/<name> pushes back to it.
			A clone of a template or of another agent's fork is read-only. Raise wait for a large repository.
			To make work of your own that you can push, call fork with clone.
			In that clone, make a branch, commit, and push to origin with git in bash.
			An edit persists only after you commit it and push it. Push before you finish.
			To cite a commit you pushed, put its full hash from git rev-parse in the refs of a say:
			ambion://workspace/lab/repo/<repository>/branch/<branch>/commit/<hash>. Use
			/tag/<tag> for a tag, or leave both out. Percent-encode the branch or tag name as one URI part, so / is %2F and # is %23.

			The shell is a simulated Unix shell: the common coreutils (ls, cat, grep, sed, awk, find,
			tar, and more), plus jq for JSON, yq for YAML and TOML, xan for CSV, and sqlite3. Run a
			script with js-exec (JavaScript) or python3 (Python).

			git is available: init, clone, add, commit, status, log, diff, show, branch, checkout,
			switch, merge, rebase, cherry-pick, stash, tag, reset, fetch, pull, push, and more. Each
			command supports a subset of the flags of real git. Your commits carry your name as the
			author, and git config does not change it. A remote is a path in this filesystem, or a URL
			that this guidance names. git reaches no other host.

			The shell has no network: curl and every other network command are disabled. Your home is
			/home/<your name>, and there is no wall between one agent's home and another's.

			Every tool call on this workspace is recorded at /workspace/audit.jsonl, one JSON line per
			call: the room, the agent, the tool, the activation and the exchange it ran in,
			its full arguments, and its full result or error. Read it to see what happened
			here, including calls other agents and other rooms made. Filter it with jq:
			select on room, tool, agent, or activation to find one call among many. Past
			5 MiB the file rotates: it moves beside itself under a
			timestamped name, and a new file starts at /workspace/audit.jsonl.

			This workspace may hold /rooms/<room name>/messages.jsonl for any room
			that mirrors its record here. Read a room's file with read or bash
			cat. It can hold messages your own context has trimmed or folded
			into a summary, and the history of a room you are not seated in.
			Each line carries the message's own seq. A message ref names the
			same seq: ambion://room/<name>/message/<seq>. Filter it with jq:
			jq 'select(.seq == <seq>)' finds the line a ref or the ask line
			names. jq also filters by kind or from."
		`);
	});

	it('counts eleven tools with no SQL backend, states the form of a commit ref, and states the shell sentence that holds with a git backend', async () => {
		const { workspace } = await lab();
		const guidance = workspace.tools().guidance ?? '';
		expect(guidance).toContain(
			'eleven tools: read, write, edit, bash, ps, wait, cancel, snapshot, restore, repos and fork.',
		);
		expect(guidance).toContain(
			'ambion://workspace/lab/repo/<repository>/branch/<branch>/commit/<hash>',
		);
		expect(guidance).toContain('or a URL\nthat this guidance names. git reaches no other host.');
		expect(guidance).toContain(`repos and fork reach the git server of this workspace, ${SERVER}.`);
		const plain = openWorkspace({ name: 'plain', backend: { bash: memoryBackend() } });
		expect(plain.tools().guidance).toContain('git reaches no other host.');
		expect(plain.tools().tools.map((tool) => tool.name)).not.toContain('fork');
		expect(plain.git).toBeUndefined();
	});
});

describe('the audit log', () => {
	it('gets one entry from every tool of a bundle with sql and git, also for a call that fails', async () => {
		const { workspace } = await lab({ sql: true, audit: true });
		const who = callAs('analyst');
		const names = workspace.tools().tools.map((tool) => tool.name);
		// An empty argument object fails validation for most tools. The entry exists either way.
		for (const tool of workspace.tools().tools)
			await Promise.resolve(tool.invoke({}, who)).catch(() => undefined);
		const log = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('/workspace/audit.jsonl'),
		);
		const entries = (log.ok ? log.value : '')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { tool: string });
		expect(entries.map((entry) => entry.tool)).toEqual(names);
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
			env.exec(`cd ~/report && ${branches.join(' && ')}`, undefined),
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
			env.readTextFile('/home/analyst/report/report.md'),
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

	it('keeps the fork when the clone fails, and says how to clone it with bash', async () => {
		const { workspace } = await lab();
		await workspace.use({ name: 'analyst' }, (env) =>
			env.writeFile('/home/analyst/busy/file.txt', 'in the way'),
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
			/^The clone into \/home\/analyst\/busy failed: .+\. The fork stays\. Run git clone http:\/\/git\.ambion\.invalid\/analyst\/report <path> with bash, at a path that does not exist yet\.$/s,
		);
		const fork = await workspace.git?.use({ name: 'analyst' }, (env) => env.get('analyst/report'));
		expect(fork?.source).toBe('templates/weekly-report');
	});

	it('records a fork call in the audit log on the shell', async () => {
		const { workspace } = await lab({ audit: true });
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		const log = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('/workspace/audit.jsonl'),
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

describe('a clone made with bash', () => {
	const pushOf = (workspace: Awaited<ReturnType<typeof lab>>['workspace'], command: string) =>
		workspace.use({ name: 'analyst' }, (env) => env.exec(command, undefined));

	it('checks out a repository without making a fork and keeps the source as origin', async () => {
		const { workspace } = await lab();
		const before = await text(workspace, 'repos', {});
		const checkout = await text(workspace, 'bash', {
			command: `git clone ${SERVER}/templates/weekly-report ~/weekly-report && cd ~/weekly-report && git remote get-url origin && git branch --show-current && cat report.md`,
		});
		expect(checkout).toContain(`${SERVER}/templates/weekly-report`);
		expect(checkout).toContain('main');
		expect(checkout).toContain('# Week');
		expect(await text(workspace, 'repos', {})).toBe(before);
	});

	it('pushes to a clone of the repository of an agent with the permissions of the source', async () => {
		const { workspace } = await lab();
		await text(workspace, 'fork', { source: 'templates/weekly-report', name: 'report' });
		const pushed = await pushOf(
			workspace,
			`git clone ${SERVER}/analyst/report ~/copy && cd ~/copy && git switch -c cloned-work && git commit --allow-empty -m copied && git push origin cloned-work`,
		);
		expect(pushed.ok && pushed.value.exitCode).toBe(0);
		const repository = await workspace.git?.use({ name: 'analyst' }, (env) =>
			env.get('analyst/report'),
		);
		expect(repository?.branches['cloned-work']).toMatch(/^[0-9a-f]{40}$/);
	});

	it('refuses a push from a clone of a template', async () => {
		const { workspace } = await lab();
		const cloned = await pushOf(
			workspace,
			`git clone ${SERVER}/templates/weekly-report ~/template`,
		);
		expect(cloned.ok && cloned.value.exitCode).toBe(0);
		const pushed = await pushOf(
			workspace,
			'cd ~/template && git switch -c edit && git commit --allow-empty -m edit && git push origin edit',
		);
		expect(pushed.ok).toBe(true);
		expect(pushed.ok ? pushed.value.exitCode : 0).not.toBe(0);
	});

	it('rejects an aborted fork with a clone, and creates no destination', async () => {
		const { workspace } = await lab();
		const controller = new AbortController();
		controller.abort(new Error('cut'));
		await expect(
			toolOf(workspace, 'fork').invoke(
				{ source: 'templates/weekly-report', name: 'report', clone: '~/aborted' },
				callAs('analyst', { signal: controller.signal }),
			),
		).rejects.toThrow();
		const destination = await workspace.use({ name: 'analyst' }, (env) =>
			env.exists('/home/analyst/aborted'),
		);
		expect(destination.ok && destination.value).toBe(false);
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
			analyst: (context, _who, request) => {
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
				if (request <= steps.length) return steps[request - 1] ?? quiet();
				// The agent writes the ref from the form that the git note states.
				const hash = /[0-9a-f]{40}/.exec(toolResults(context).at(-1)?.text ?? '')?.[0] ?? '';
				const ref = `ambion://workspace/lab/repo/analyst/report/branch/week-39/commit/${hash}`;
				if (request === steps.length + 1)
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
