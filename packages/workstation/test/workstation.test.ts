/**
 * The workstation beyond the conformance cases: the options it refuses, the
 * pinned host key, one session for each agent and its idle timeout, a
 * dropped connection, the command script, the group kill, the error codes,
 * the private temporary files, and a workspace over it with an audit log, a
 * `sql` export, and the copy of an agent's skills.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AmbionTool, snapshotUri, type ToolContext } from '@ambionframework/ambion';
import {
	loadSkills,
	openWorkspace,
	type ShellOutputView,
	type Workspace,
	type WorkspaceEnv,
} from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type WorkstationOptions, workstationBackend } from '../src/index.ts';
import { startSshServer, type TestServer } from './support/server.ts';
import { hasSetsid } from './support/setsid.ts';

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
	const updates: ShellOutputView[] = [];
	const result = await env.exec(command, { ...options, onUpdate: (view) => updates.push(view) });
	const view = updates[0];
	return {
		result,
		text: view?.text,
		updates: updates.length,
	};
}

/** The `ps` state of `pid`, or an empty string when no such process exists. */
function processState(pid: number): string {
	const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
	return ps.stdout.trim();
}

/** The process has ended: no process has the pid, or a zombie that its parent has not reaped yet. */
const ended = (pid: number): boolean => /^(Z.*)?$/.test(processState(pid));

const until = async (check: () => boolean, ms = 2_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('workstationBackend options', () => {
	const base = {
		server: 'lab.internal',
		hostKey: `SHA256:${'A'.repeat(43)}`,
		layout: { audit: '/srv/audit.jsonl', rooms: '/srv/rooms', snapshots: '/srv/snapshots' },
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
		const ran = await held.exec('true', undefined);
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
		const written = await withEnv(backend, 'ada', (env) => env.writeFile('after.txt', 'x'));
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
			const refused = await env.exec('true', undefined);
			expect(refused).toMatchObject({ ok: false, error: { code: 'unknown' } });
			started.refuseChannels(false);
		});
		const ran = await withEnv(backend, 'ada', (env) => env.exec('true', undefined));
		expect(ran).toMatchObject({ ok: true, value: { exitCode: 0 } });
		expect(started.logins.get('ada')).toBe(2);
	});
});

describe.skipIf(!hasSetsid)('a workstation command', () => {
	it('exports variables, runs in cwd, gives the exit code, and reads an empty input', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			await env.createDir('sub', undefined);
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

	it.each([
		{ shell: "the command's shell", command: 'kill -9 $$' },
		{
			shell: "the script's shell, whose channel then reports the signal",
			command: 'kill -9 $PPID',
		},
	])('gives 128 plus the signal number when a signal ends $shell', async ({ command }) => {
		const started = await server();
		const backend = backendFor(started.options);
		const { result } = await withEnv(backend, 'ada', (env) => run(env, command));
		expect(result).toMatchObject({ ok: true, value: { exitCode: 137 } });
	});

	it('refuses a missing directory and a variable name the shell cannot export', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const missing = await env.exec('true', { cwd: 'nowhere' });
			expect(missing).toMatchObject({ ok: false, error: { code: 'spawn_error' } });
			const bad = await env.exec('true', { env: { 'A;B': 'x' } });
			expect(bad).toMatchObject({ ok: false, error: { code: 'spawn_error' } });
			for (const grace of [-1, Number.NaN, 3_000_000]) {
				const refused = await env.exec('true', { grace });
				expect(refused, String(grace)).toMatchObject({
					ok: false,
					error: { code: 'spawn_error', message: expect.stringContaining('Invalid grace') },
				});
			}
		});
	});

	it.each([
		{
			stop: 'SIGTERM, and a trap that exits inside the grace',
			grace: 3,
			trap: "trap 'echo term > marker; exit 0' TERM",
			marker: true,
			inGrace: true,
		},
		{
			stop: 'SIGTERM, then SIGKILL after the grace to a command that ignores TERM',
			grace: 3,
			trap: "trap '' TERM",
			marker: false,
			inGrace: false,
		},
		{
			stop: 'SIGKILL at once with no grace, so no trap runs',
			grace: undefined,
			trap: "trap 'echo term > marker; exit 0' TERM",
			marker: false,
			inGrace: true,
		},
	])('stops an aborted command with $stop', async ({ grace, trap, marker, inGrace }) => {
		const started = await server();
		const backend = backendFor(started.options);
		const home = started.homes.get('ada') ?? '';
		const controller = new AbortController();
		const command = `${trap}\nsleep 30 & echo $! > child.pid\nwait`;
		const { result, stoppedIn } = await withEnv(backend, 'ada', async (env) => {
			const options = { timeout: 60, ...(grace === undefined ? {} : { grace }) };
			const running = env.exec(command, options, controller.signal);
			await until(() => spawnSync('test', ['-s', join(home, 'child.pid')]).status === 0);
			const abortedAt = Date.now();
			controller.abort();
			return { result: await running, stoppedIn: Date.now() - abortedAt };
		});
		expect(result).toMatchObject({ ok: false });
		expect(stoppedIn < (grace ?? 3) * 1000).toBe(inGrace);
		const pid = Number((await readFile(join(home, 'child.pid'), 'utf8')).trim());
		await until(() => ended(pid));
		expect(ended(pid)).toBe(true);
		expect(spawnSync('test', ['-f', join(home, 'marker')]).status === 0).toBe(marker);
	});

	it('opens one kill channel at a time for each client, and ends every aborted command', async () => {
		const started = await server();
		// Each kill channel stays open for 200 ms, so a second kill channel would overlap the first.
		started.kills.delayMs = 200;
		const backend = backendFor(started.options);
		const controller = new AbortController();
		const results = await withEnv(backend, 'ada', async (env) => {
			const aborted = controller.signal;
			const runs = [1, 2, 3, 4].map(() =>
				env.exec('trap : TERM\nsleep 30 & wait', { timeout: 60, grace: 1 }, aborted),
			);
			// Let each command report its group before the abort.
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			controller.abort();
			return Promise.all(runs);
		});
		for (const result of results) expect(result).toMatchObject({ ok: false });
		// The abort of 4 commands sends 4 TERM signals.
		expect(started.kills.peak).toBe(1);
	}, 20_000);

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
			env.exec('sleep 30 & echo $! > child.pid; sleep 30', { timeout: 0.5 }),
		);
		expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
		const pid = Number((await readFile(join(home, 'child.pid'), 'utf8')).trim());
		// A killed child that no init reaps stays a zombie, and `kill(pid, 0)` still finds it.
		await until(() => ended(pid));
		expect(ended(pid)).toBe(true);
	});
});

describe.skipIf(!hasSetsid)('workstation files', () => {
	it('classifies a coarse SFTP status by the kind of operation', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			await env.createDir('full', undefined);
			await env.writeFile('full/a.txt', 'x');
			const notEmpty = await env.remove('full', undefined);
			expect(notEmpty).toMatchObject({ ok: false, error: { code: 'invalid' } });
			const underFile = await env.readTextFile('full/a.txt/x');
			expect(underFile).toMatchObject({ ok: false, error: { code: 'not_directory' } });
			const noParent = await env.readTextFile('none/a.txt');
			expect(noParent).toMatchObject({ ok: false, error: { code: 'not_found' } });
			const renamed = await env.renameFile('full/a.txt', 'none/b.txt');
			expect(renamed).toMatchObject({ ok: false, error: { code: 'not_found' } });
			const written = await env.writeFile('deep/er/a.txt', 'x');
			expect(written.ok).toBe(true);
			const exists = await env.createDir('full', { recursive: false });
			expect(exists).toMatchObject({ ok: false, error: { code: 'invalid' } });
		});
	});

	it('reads mtime in milliseconds', async () => {
		const started = await server();
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const written = await env.writeFile('mtime.txt', 'x');
			expect(written.ok).toBe(true);
			const info = await env.fileInfo('mtime.txt');
			expect(info.ok && Math.abs(info.value.mtimeMs - Date.now()) < 5_000).toBe(true);
		});
	});

	it('reads a binary file and lists a directory with each entry kind', async () => {
		const started = await server();
		const home = started.homes.get('ada') ?? '';
		await writeFile(join(home, 'image.bin'), Buffer.from([0, 1, 2, 255]));
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const bytes = await env.readBinaryFile('image.bin');
			expect(bytes.ok && [...bytes.value]).toEqual([0, 1, 2, 255]);
			await env.createDir('dir', undefined);
			const listed = await env.listDir('.');
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

describe.skipIf(!hasSetsid)('a workstation read', () => {
	it('returns a file at the limit, and refuses a larger file and a device file with `invalid`', async () => {
		const started = await server();
		const home = started.homes.get('ada') ?? '';
		const limit = 10 * 1024 * 1024;
		await writeFile(join(home, 'edge.bin'), Buffer.alloc(limit, 97));
		await writeFile(join(home, 'big.bin'), Buffer.alloc(limit + 1, 97));
		const backend = backendFor(started.options);
		await withEnv(backend, 'ada', async (env) => {
			const edge = await env.readBinaryFile('edge.bin');
			expect(edge.ok && edge.value.length).toBe(limit);
			for (const path of ['big.bin', '/dev/zero']) {
				const rss = process.memoryUsage().rss;
				const began = Date.now();
				const refused = await env.readBinaryFile(path);
				expect(refused).toMatchObject({ ok: false, error: { code: 'invalid' } });
				expect(refused.ok ? '' : refused.error.message).toContain(path.slice(-8));
				expect(Date.now() - began).toBeLessThan(10_000);
				expect(process.memoryUsage().rss - rss).toBeLessThan(200 * 1024 * 1024);
			}
			const again = await env.readTextFile('edge.bin');
			expect(again.ok).toBe(true);
		});
	});
});

describe.skipIf(!hasSetsid)('a workspace on a workstation', () => {
	it('adopts the live processes of an earlier run from their files, cancels one through its pid, times out the other over a lost stop, and records a lost one', async () => {
		const started = await server(['ada']);
		const home = started.homes.get('ada') ?? '';
		// An earlier run of the host starts two processes, and then goes away.
		const earlier = workstationBackend(started.options);
		const env = await earlier.connect({ name: 'ada' });
		const specOf = async (handle: string, timeout: number, startedAt: string) => {
			const dir = join(home, '.processes', handle);
			await mkdir(dir, { recursive: true });
			const spec = {
				handle,
				kind: 'bash',
				agent: 'ada',
				command: 'exec sleep 30',
				timeout,
				grace: 10,
				startedAt,
			};
			await writeFile(join(dir, 'spec'), JSON.stringify(spec));
			return dir;
		};
		const shell = async (dir: string, on = env) => {
			const script = `echo "$$" > '${dir}/pid'\n(\nexec sleep 30\n) < /dev/null > '${dir}/out' 2>&1`;
			void on.exec(script, { timeout: 60 }).catch(() => undefined);
			await until(() => spawnSync('test', ['-s', join(dir, 'pid')]).status === 0);
			return Number((await readFile(join(dir, 'pid'), 'utf8')).trim());
		};
		const kept = await shell(await specOf('bash-00000000000c', 600, new Date().toISOString()));
		const lateDir = await specOf(
			'bash-00000000000d',
			1,
			new Date(Date.now() - 5_000).toISOString(),
		);
		const late = await shell(lateDir);
		// A read whose ps failed once wrote the lost stop for this live shell.
		await writeFile(
			join(lateDir, 'stop'),
			'failed 2026-01-01T00:00:00.000Z The host run ended before the process did.\n',
		);
		// A process whose shell starts only after the first read: its spec has no pid yet.
		const slow = await specOf('bash-00000000000f', 600, new Date().toISOString());
		// A process whose shell ended and left no end in the files: no run runs it.
		const lost = join(home, '.processes', 'bash-00000000000e');
		await mkdir(lost, { recursive: true });
		const spec = { handle: 'bash-00000000000e', kind: 'bash', agent: 'ada', command: 'true' };
		await writeFile(
			join(lost, 'spec'),
			JSON.stringify({
				...spec,
				timeout: 600,
				grace: 10,
				startedAt: new Date().toISOString(),
			}),
		);
		await writeFile(join(lost, 'pid'), `${spawnSync('true').pid}\n`);
		await env.cleanup();
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
		// A read adopts what it finds: ps reads both. The one past its timeout cancels at once.
		// The pid of the one with the lost stop is in /proc, so the listing runs ps for it.
		const listed = await toolOf(workspace, 'ps').invoke({}, context('ada'));
		if (typeof listed === 'string') throw new Error('A process tool gives a structured result.');
		const running = (listed.details as { processes: Array<{ handle: string; state: string }> })
			.processes;
		expect(running.map((one) => [one.handle, one.state])).toEqual([
			['bash-00000000000d', 'running'],
			['bash-00000000000c', 'running'],
		]);
		expect(await call('wait', { handles: ['bash-00000000000c'], timeout: 0 })).toBe('running');
		// The read that found the lost process wrote its stop. Its pid is not in /proc, so no later
		// listing runs ps for it.
		expect(await readFile(join(lost, 'stop'), 'utf8')).toMatch(
			/^failed \S+ The host run ended before the process did\.\n$/,
		);
		// A lost process ended badly, so a read of it fails, and the text states the loss.
		await expect(call('wait', { handles: ['bash-00000000000e'], timeout: 0 })).rejects.toThrow(
			/Process bash-00000000000e failed: The host run ended before the process did\./,
		);
		// A spec with no pid gets no stop, so the read after its shell writes the pid adopts it.
		await expect(readFile(join(slow, 'stop'), 'utf8')).rejects.toThrow();
		const other = backendFor(started.options);
		const otherEnv = await other.connect({ name: 'ada' });
		cleanups.push(() => otherEnv.cleanup());
		const slowPid = await shell(slow, otherEnv);
		expect(await call('wait', { handles: ['bash-00000000000f'], timeout: 0 })).toBe('running');
		expect(await call('cancel', { handle: 'bash-00000000000f' })).toBe('cancelled');
		expect(ended(slowPid)).toBe(true);
		await until(() => ended(late), 15_000);
		// A process that timed out fails the read, and the text states the timeout.
		await expect(call('wait', { handles: ['bash-00000000000d'], timeout: 0 })).rejects.toThrow(
			/Process bash-00000000000d timed out/,
		);
		expect(await call('cancel', { handle: 'bash-00000000000c' })).toBe('cancelled');
		expect(ended(kept)).toBe(true);
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
		// Each read gives the output after the last one. The test writes the next part itself.
		await appendFile(process.output, 'second\n');
		const later = await call('wait', { handles: [process.handle], timeout: 0 });
		expect(later).toMatch(
			/^second\n\n\[Process .* is running\..* starts at byte 6 of the output\./s,
		);
		expect(await call('wait', { handles: [process.handle], timeout: 0 })).toMatch(
			/^\(no new output\)\n\n/,
		);
		expect(await call('cancel', { handle: process.handle })).toContain('is cancelled.');
		// A wait on one handle gives the result of a read, at once for a process that ended.
		expect(await call('wait', { handles: [process.handle], timeout: 5 })).toMatch(
			/^\(no new output\)\n\n\[Process .* is cancelled\./,
		);
		expect(await readFile(process.output, 'utf8')).toBe('first\nsecond\n');
		// The table holds the timeout, and cancels the process with the cause timed_out.
		const timed = await call('bash', {
			command: 'echo second; exec sleep 30',
			timeout: 1,
			wait: 5,
		});
		expect(timed).toMatch(
			/^ToolFailure: second\n\n\[Process bash-[0-9a-f]{12} timed out after 1 seconds\./,
		);
		expect(await workspace.processes.list({ running: true })).toEqual([]);
	});

	it('runs the file tools as the agent, audits them at the layout path, snapshots a file of the home as the host, and lands a sql export in the home', async () => {
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
		const frozen = await toolOf(workspace, 'snapshot').invoke(
			{ paths: ['notes.txt'] },
			context('ada'),
		);
		const digest = createHash('sha256').update('hello').digest('hex');
		const home = started.homes.get('ada') ?? '';
		const ref = snapshotUri('lab', digest, join(home, 'notes.txt'));
		expect(frozen).toMatchObject({ details: { refs: [ref] } });
		expect(await readFile(join(started.options.layout.snapshots, digest), 'utf8')).toBe('hello');
		expect(new TextDecoder().decode(await workspace.readSnapshot(ref))).toBe('hello');
		await toolOf(workspace, 'sql').invoke(
			{
				sql: 'CREATE TABLE t (x); INSERT INTO t VALUES (1), (2); SELECT x FROM t',
				export: 'out/t.csv',
			},
			context('ada'),
		);
		expect(await readFile(join(home, 'out', 't.csv'), 'utf8')).toBe('x\n1\n2\n');
		const audit = (await readFile(started.options.layout.audit, 'utf8')).trim().split('\n');
		expect(audit.map((line) => JSON.parse(line).tool)).toEqual([
			'write',
			'bash',
			'snapshot',
			'sql',
		]);
		expect(workspace.mirrorAgent).toEqual({ name: 'lab-host' });
	});

	it("copies the agent's skills into its home over SFTP, and marks each script executable", async () => {
		const started = await server(['ada']);
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: workstationBackend(started.options) },
		});
		cleanups.push(() => workspace.dispose());
		const skills = await loadSkills({
			'pour-plan/SKILL.md':
				'---\nname: pour-plan\ndescription: Check a pour.\n---\nRun the script.\n',
			'pour-plan/scripts/tonnage.sh': '#!/bin/sh\necho "$1 t"\n',
		});
		const bundle = workspace.tools({ skills });
		await bundle.remind?.(
			{ agent: 'ada', room: 'lobby', activation: 'a1' },
			new AbortController().signal,
		);
		const ran = await toolOf(workspace, 'bash').invoke(
			{ command: '~/.skills/pour-plan/scripts/tonnage.sh 48' },
			context('ada'),
		);
		expect(JSON.stringify(ran)).toContain('48 t');
		const home = started.homes.get('ada') ?? '';
		const script = await stat(join(home, '.skills', 'pour-plan', 'scripts', 'tonnage.sh'));
		const skill = await stat(join(home, '.skills', 'pour-plan', 'SKILL.md'));
		expect([script.mode & 0o111, skill.mode & 0o111]).toEqual([0o111, 0]);
	});
});
