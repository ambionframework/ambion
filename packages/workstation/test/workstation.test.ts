/**
 * The workstation beyond the conformance cases: the options it refuses, the
 * pinned host key, one session for each agent and its idle timeout, a
 * dropped connection, the command script, the group kill, the error codes,
 * the private temporary files, and a workspace over it with an audit log and
 * a `sql` export.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { openWorkspace, type Workspace, type WorkspaceEnv } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { BACKGROUND_CONTEXT, type ShellOutputUpdate } from '@earendil-works/pi-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type WorkstationOptions, workstationBackend } from '../src/index.ts';
import { startSshServer, type TestServer } from './support/server.ts';
import { hasSetsid } from './support/setsid.ts';

const ctx = BACKGROUND_CONTEXT;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(accounts: readonly string[] = ['ada']): Promise<TestServer> {
	const started = await startSshServer(accounts);
	cleanups.push(() => started.stop());
	return started;
}

function backendFor(options: WorkstationOptions) {
	const backend = workstationBackend(options);
	cleanups.push(async () => backend.dispose?.());
	return backend;
}

/** Connect `agent`, run `body`, and hand the session back. */
async function withEnv<T>(
	backend: ReturnType<typeof workstationBackend>,
	agent: string,
	body: (env: WorkspaceEnv) => Promise<T>,
): Promise<T> {
	const env = await backend.connect({ name: agent });
	try {
		return await body(env);
	} finally {
		await env.cleanup();
	}
}

/** The one view a command hands to `onUpdate`, and its result. */
async function run(
	env: WorkspaceEnv,
	command: string,
	options: Parameters<WorkspaceEnv['exec']>[1] = {},
) {
	const updates: ShellOutputUpdate[] = [];
	const result = await env.exec(
		command,
		{ ...options, onUpdate: (update) => updates.push(update) },
		ctx,
	);
	const view = updates[0];
	return {
		result,
		text: view?.kind === 'replace' ? view.output.text : undefined,
		updates: updates.length,
	};
}

/** The `ps` state of `pid`, or an empty string when no such process exists. */
function processState(pid: number): string {
	const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
	return ps.stdout.trim();
}

const until = async (check: () => boolean, ms = 2_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('workstationBackend options', () => {
	const base = {
		host: 'lab.internal',
		hostKey: `SHA256:${'A'.repeat(43)}`,
		layout: { audit: '/srv/audit.jsonl', rooms: '/srv/rooms' },
		credentialFor: () => ({ username: 'x', privateKey: 'x' }),
	};

	it('refuses a host key that is not a SHA256 fingerprint', () => {
		expect(() => workstationBackend({ ...base, hostKey: 'ssh-ed25519 AAAA' })).toThrow('SHA256');
		expect(() => workstationBackend({ ...base, hostKey: '' })).toThrow('SHA256');
	});

	it('refuses a port and an idle timeout out of range', () => {
		for (const port of [0, 65_536, 1.5]) {
			expect(() => workstationBackend({ ...base, port }), String(port)).toThrow(RangeError);
		}
		for (const idleTimeout of [0, -1, Number.NaN, 3_000_000]) {
			expect(() => workstationBackend({ ...base, idleTimeout }), String(idleTimeout)).toThrow(
				RangeError,
			);
		}
	});

	it('states the facts of a real server in its guidance, and names its layout', () => {
		const backend = workstationBackend(base);
		expect(backend.guidance).toContain('real shell');
		expect(backend.layout).toEqual(base.layout);
		expect(backend.tools).toBeUndefined();
	});
});

describe.skipIf(!hasSetsid)('a workstation session', () => {
	it('refuses a server whose host key does not match the pin, and names both keys', async () => {
		const started = await server();
		const backend = backendFor({ ...started.options, hostKey: `SHA256:${'B'.repeat(43)}` });
		await expect(backend.connect({ name: 'ada' })).rejects.toThrow(/pins SHA256:B+/);
		expect(started.logins.get('ada')).toBeUndefined();
	});

	it('reuses one session for each agent, and gives each agent its own home', async () => {
		const started = await server(['ada', 'bob']);
		const backend = backendFor(started.options);
		const first = await withEnv(backend, 'ada', async (env) => env.cwd);
		const again = await withEnv(backend, 'ada', async (env) => env.cwd);
		const other = await withEnv(backend, 'bob', async (env) => env.cwd);
		expect([first, again, other]).toEqual([
			started.homes.get('ada'),
			started.homes.get('ada'),
			started.homes.get('bob'),
		]);
		expect(started.logins.get('ada')).toBe(1);
		expect(started.logins.get('bob')).toBe(1);
	});

	it('keeps a session open while an env is open over it, closes it after its idle timeout, and the next connect logs in again', async () => {
		const started = await server();
		const backend = backendFor({ ...started.options, idleTimeout: 0.05 });
		// A background process holds an env past the operations that start and end beside it.
		const held = await backend.connect({ name: 'ada' });
		await withEnv(backend, 'ada', async () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const ran = await held.exec('true', undefined, ctx);
		await held.cleanup();
		expect(ran).toMatchObject({ ok: true, value: { exitCode: 0 } });
		expect(started.logins.get('ada')).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await withEnv(backend, 'ada', async () => undefined);
		expect(started.logins.get('ada')).toBe(2);
	});

	it('builds a new session after the connection drops', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async () => undefined);
		started.dropClients();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const written = await withEnv(backend, 'ada', (env) => env.writeFile('after.txt', 'x', ctx));
		expect(written.ok).toBe(true);
		expect(started.logins.get('ada')).toBe(2);
	});
});

describe.skipIf(!hasSetsid)('a workstation channel', () => {
	it('closes a client that cannot open a channel, and the next connect logs in again', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			started.refuseChannels(true);
			const refused = await env.exec('true', undefined, ctx);
			expect(refused).toMatchObject({ ok: false, error: { code: 'unknown' } });
			started.refuseChannels(false);
		});
		const ran = await withEnv(backend, 'ada', (env) => env.exec('true', undefined, ctx));
		expect(ran).toMatchObject({ ok: true, value: { exitCode: 0 } });
		expect(started.logins.get('ada')).toBe(2);
	});
});

describe.skipIf(!hasSetsid)('a workstation command', () => {
	it('exports variables, runs in cwd, gives the exit code, and reads an empty input', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			await env.createDir('sub', undefined, ctx);
			const vars = await run(env, 'printf "%s|%s\\n" "$GREETING" "$(pwd)"; cat; exit 3', {
				env: { GREETING: "it's here" },
				cwd: 'sub',
			});
			expect(vars.result).toMatchObject({ ok: true, value: { exitCode: 3 } });
			expect(vars.text).toBe(`it's here|${env.cwd}/sub\n`);
			expect(vars.updates).toBe(1);
		});
	});

	it('keeps stderr and removes the process group line from it', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		const { text } = await withEnv(backend, 'ada', (env) => run(env, 'echo out; echo err >&2'));
		expect(text).toBe('out\nerr\n');
	});

	it('runs a command with a line that is its own heredoc delimiter shape, a function, and a heredoc', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		const command = ['f() {', '  echo in-f', '}', 'f', 'cat <<EOF', 'AMBION_x', 'EOF'].join('\n');
		const { text } = await withEnv(backend, 'ada', (env) => run(env, command));
		expect(text).toBe('in-f\nAMBION_x\n');
	});

	it('gives 128 plus the signal number for a command a signal ends', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		const { result } = await withEnv(backend, 'ada', (env) => run(env, 'kill -9 $$'));
		expect(result).toMatchObject({ ok: true, value: { exitCode: 137 } });
	});

	it('refuses a missing directory and a variable name the shell cannot export', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const missing = await env.exec('true', { cwd: 'nowhere' }, ctx);
			expect(missing).toMatchObject({ ok: false, error: { code: 'spawn_error' } });
			const bad = await env.exec('true', { env: { 'A;B': 'x' } }, ctx);
			expect(bad).toMatchObject({ ok: false, error: { code: 'spawn_error' } });
		});
	});

	it.each([
		{ noise: '', shell: 'a quiet login shell' },
		{ noise: 'Welcome to the lab.\n', shell: 'a login shell that writes to stderr first' },
		{ noise: 'Welcome to the lab.', shell: 'a login shell that writes no newline at its end' },
		{ noise: 'x'.repeat(70_000), shell: 'a login shell that writes past the cap' },
	])('kills the whole process group on a timeout, under $shell', async ({ noise }) => {
		const started = await server();
		started.setLoginNoise(noise);
		const backend = backendFor(started.options);
		const home = started.homes.get('ada') ?? '';
		const timedOut = await withEnv(backend, 'ada', (env) =>
			env.exec('sleep 30 & echo $! > child.pid; sleep 30', { timeout: 0.5 }, ctx),
		);
		expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
		const pid = Number((await readFile(join(home, 'child.pid'), 'utf8')).trim());
		// A killed child that no init reaps stays a zombie, and `kill(pid, 0)` still finds it.
		const gone = () => /^(Z.*)?$/.test(processState(pid));
		await until(gone);
		expect(gone()).toBe(true);
	});
});

describe.skipIf(!hasSetsid)('workstation files', () => {
	it('classifies a coarse SFTP status by the kind of operation', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			await env.createDir('full', undefined, ctx);
			await env.writeFile('full/a.txt', 'x', ctx);
			const notEmpty = await env.remove('full', undefined, ctx);
			expect(notEmpty).toMatchObject({ ok: false, error: { code: 'invalid' } });
			const underFile = await env.readTextFile('full/a.txt/x', ctx);
			expect(underFile).toMatchObject({ ok: false, error: { code: 'not_directory' } });
			const noParent = await env.readTextFile('none/a.txt', ctx);
			expect(noParent).toMatchObject({ ok: false, error: { code: 'not_found' } });
			const renamed = await env.renameFile('full/a.txt', 'none/b.txt', ctx);
			expect(renamed).toMatchObject({ ok: false, error: { code: 'not_found' } });
			const written = await env.writeFile('deep/er/a.txt', 'x', ctx);
			expect(written.ok).toBe(true);
			const exists = await env.createDir('full', { recursive: false }, ctx);
			expect(exists).toMatchObject({ ok: false, error: { code: 'invalid' } });
		});
	});

	it('creates private temporary files and directories, and reads mtime in milliseconds', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const file = await env.createTempFile(undefined, ctx);
			const dir = await env.createTempDir(undefined, ctx);
			if (!file.ok || !dir.ok) throw new Error('no temporary names');
			expect((await stat(file.value)).mode & 0o777).toBe(0o600);
			expect((await stat(dir.value)).mode & 0o777).toBe(0o700);
			const again = await env.writeFile(file.value, 'x', ctx);
			expect(again.ok).toBe(true);
			const info = await env.fileInfo(file.value, ctx);
			expect(info.ok && Math.abs(info.value.mtimeMs - Date.now()) < 5_000).toBe(true);
			await env.remove(file.value, undefined, ctx);
			await env.remove(dir.value, { recursive: true }, ctx);
		});
	});

	it('reads a binary file and lists a directory with each entry kind', async () => {
		const started = await server();
		const home = started.homes.get('ada') ?? '';
		await writeFile(join(home, 'image.bin'), Buffer.from([0, 1, 2, 255]));
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const bytes = await env.readBinaryFile('image.bin', ctx);
			expect(bytes.ok && [...bytes.value]).toEqual([0, 1, 2, 255]);
			await env.createDir('dir', undefined, ctx);
			const listed = await env.listDir('.', ctx);
			const kinds = listed.ok
				? Object.fromEntries(listed.value.map((entry) => [entry.name, entry.kind]))
				: {};
			expect(kinds).toEqual({ 'image.bin': 'file', dir: 'directory' });
		});
	});
});

const context = (agent: string): ToolContext => ({
	agent: { name: agent, identity: agent },
	callId: 'call-1',
	room: 'lobby',
});

function toolOf(workspace: Workspace, name: string): AmbionTool {
	const tool = workspace.tools().tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`No tool named ${name}.`);
	return tool;
}

describe.skipIf(!hasSetsid)('a workspace on a workstation', () => {
	it('adopts the live processes of an earlier run from their files, cancels one through its pid, and times out the other', async () => {
		const started = await server(['ada']);
		const home = started.homes.get('ada') ?? '';
		// An earlier run of the host starts two processes, and then goes away.
		const earlier = workstationBackend(started.options);
		const env = await earlier.connect({ name: 'ada' });
		const launch = async (handle: string, timeout: number, startedAt: string) => {
			const dir = join(home, '.processes', handle);
			await mkdir(dir, { recursive: true });
			const spec = {
				handle,
				kind: 'bash',
				agent: 'ada',
				command: 'exec sleep 30',
				timeout,
				startedAt,
			};
			await writeFile(join(dir, 'spec'), JSON.stringify(spec));
			const script = `echo "$$" > '${dir}/pid'\n(\nexec sleep 30\n) < /dev/null > '${dir}/out' 2>&1`;
			void env.exec(script, { timeout: 60 }, ctx).catch(() => undefined);
			await until(() => spawnSync('test', ['-s', join(dir, 'pid')]).status === 0);
			return Number((await readFile(join(dir, 'pid'), 'utf8')).trim());
		};
		const kept = await launch('bash-00000000000c', 600, new Date().toISOString());
		const late = await launch('bash-00000000000d', 1, new Date(Date.now() - 5_000).toISOString());
		await earlier.dispose?.();
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: workstationBackend(started.options) },
		});
		cleanups.push(() => workspace.dispose());
		const call = async (tool: string, params: unknown) => {
			const result = await toolOf(workspace, tool).invoke(params, context('ada'));
			if (typeof result === 'string') throw new Error('A process tool gives a structured result.');
			return (result.details as { process: { state: string } }).process.state;
		};
		// A read adopts what it finds: ps reads both. The one past its timeout stops at once.
		await toolOf(workspace, 'ps').invoke({}, context('ada'));
		expect(await call('status', { handle: 'bash-00000000000c' })).toBe('running');
		await until(() => processState(late) === '', 15_000);
		expect(await call('status', { handle: 'bash-00000000000d' })).toBe('timed_out');
		expect(await call('cancel', { handle: 'bash-00000000000c' })).toBe('cancelled');
		expect(processState(kept)).toBe('');
	});

	it("writes a running process's output to its file in the home, and a cancel and a timeout kill the process", async () => {
		const started = await server(['ada']);
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: workstationBackend(started.options) },
		});
		cleanups.push(() => workspace.dispose());
		const call = async (tool: string, params: unknown) => {
			const result = await Promise.resolve(
				toolOf(workspace, tool).invoke(params, context('ada')),
			).catch((error: unknown) => ({ content: [{ type: 'text' as const, text: String(error) }] }));
			if (typeof result === 'string') throw new Error('A process tool gives a structured result.');
			return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		};
		const running = await call('bash', { command: 'echo first; exec sleep 30', wait: 1 });
		const [process] = await workspace.processes.list();
		if (process === undefined) throw new Error('No process in the table.');
		expect(process.state).toBe('running');
		expect(running.startsWith('first\n\n[Process')).toBe(true);
		expect(process.output).toBe(
			join(started.homes.get('ada') ?? '', '.processes', process.handle, 'out'),
		);
		expect(await call('cancel', { handle: process.handle })).toContain('is cancelled.');
		expect(await readFile(process.output, 'utf8')).toBe('first\n');
		// The table holds the timeout, and stops the process the way a cancel does.
		const timed = await call('bash', {
			command: 'echo second; exec sleep 30',
			timeout: 1,
			wait: 5,
		});
		expect(timed).toMatch(
			/^Error: second\n\n\[Process bash-[0-9a-f]{12} timed out after 1 seconds\./,
		);
		expect(await workspace.processes.list({ running: true })).toEqual([]);
	});

	it('runs the file tools as the agent, audits them at the layout path, and lands a sql export in the home', async () => {
		const started = await server(['ada', 'lab-host']);
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: workstationBackend(started.options), sql: sqliteBackend(':memory:') },
			audit: {},
		});
		cleanups.push(() => workspace.dispose());
		await toolOf(workspace, 'write').invoke(
			{ path: 'notes.txt', content: 'hello' },
			context('ada'),
		);
		const read = await toolOf(workspace, 'bash').invoke(
			{ command: 'cat notes.txt' },
			context('ada'),
		);
		expect(JSON.stringify(read)).toContain('hello');
		await toolOf(workspace, 'sql').invoke(
			{
				sql: 'CREATE TABLE t (x); INSERT INTO t VALUES (1), (2); SELECT x FROM t',
				export: 'out/t.csv',
			},
			context('ada'),
		);
		const home = started.homes.get('ada') ?? '';
		expect(await readFile(join(home, 'out', 't.csv'), 'utf8')).toBe('x\n1\n2\n');
		const audit = (await readFile(started.options.layout.audit, 'utf8')).trim().split('\n');
		expect(audit.map((line) => JSON.parse(line).tool)).toEqual(['write', 'bash', 'sql']);
		expect(workspace.host).toEqual({ name: 'lab-host' });
	});
});
