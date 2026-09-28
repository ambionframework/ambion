/**
 * The integration tier: the workstation against OpenSSH, with one Unix
 * account for each agent. `setup.sh` provisions the accounts and starts
 * `sshd` as root, and this tier runs only when `AMBION_WORKSTATION_SSHD`
 * names the file that `setup.sh` writes. It proves what only a real server
 * can: the rename and the group kill on OpenSSH, its status codes, the
 * channel limit, the spill file, the permissions between accounts, and the
 * adoption of a process that outlives the run of the host that started it.
 */

import type { ToolContext } from '@ambionframework/ambion';
import {
	openWorkspace,
	type ProcessStatus,
	type Workspace,
	type WorkspaceEnv,
} from '@ambionframework/workspace';
import {
	type ConformanceBackend,
	workspaceConformance,
} from '@ambionframework/workspace/conformance';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type WorkstationOptions, workstationBackend } from '../../src/index.ts';
import { type Backend, configPath, options, run, WIPE, withEnv } from '../support/sshd.ts';

const ctx = BACKGROUND_CONTEXT;

const harness: ConformanceBackend = {
	name: 'workstation on OpenSSH',
	async open() {
		const backend = workstationBackend(await options());
		await withEnv(backend, 'conformance', (env) => env.exec(WIPE, undefined, ctx));
		return { backend, dispose: async () => backend.dispose?.() };
	},
};

describe.skipIf(configPath === undefined)('integration tier', () => {
	describe(harness.name, () => {
		for (const c of workspaceConformance(harness)) it(c.name, c.run);
	});

	let backend: Backend;
	let layout: WorkstationOptions['layout'];
	beforeAll(async () => {
		const resolved = await options();
		layout = resolved.layout;
		backend = workstationBackend(resolved);
		for (const agent of ['surveyor', 'planner']) {
			await withEnv(backend, agent, (env) => env.exec(WIPE, undefined, ctx));
		}
		await withEnv(backend, 'lab-host', (env) =>
			env.exec(`rm -rf -- ${layout.rooms}/*`, undefined, ctx),
		);
	});
	afterAll(async () => backend.dispose?.());

	it('classifies the status codes of OpenSSH by the kind of operation', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			await env.createDir('full', undefined, ctx);
			await env.writeFile('full/a.txt', 'x', ctx);
			expect(await env.remove('full', undefined, ctx)).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
			expect(await env.readTextFile('full/a.txt/x', ctx)).toMatchObject({
				ok: false,
				error: { code: 'not_directory' },
			});
			expect(await env.readTextFile('none/a.txt', ctx)).toMatchObject({
				ok: false,
				error: { code: 'not_found' },
			});
			expect(await env.renameFile('full/a.txt', 'none/b.txt', ctx)).toMatchObject({
				ok: false,
				error: { code: 'not_found' },
			});
			expect(await env.writeFile('deep/er/a.txt', 'x', ctx)).toMatchObject({ ok: true });
			expect(await env.createDir('full', { recursive: false }, ctx)).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
		});
	});

	it('kills the whole process group on a timeout', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			const timedOut = await env.exec(
				'sleep 30 & echo $! > child.pid; sleep 30',
				{ timeout: 0.5 },
				ctx,
			);
			expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
			// A killed child that no init reaps stays a zombie, and `kill -0` still finds it.
			const gone = await env.exec(
				'sleep 0.2; case "$(ps -o stat= -p "$(cat child.pid)")" in "" | Z*) exit 0 ;; *) exit 1 ;; esac',
				undefined,
				ctx,
			);
			expect(gone).toMatchObject({ ok: true, value: { exitCode: 0 } });
		});
	});

	it('stays under MaxSessions over many commands, timeouts, and aborts on one client', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			for (let i = 0; i < 12; i += 1) {
				expect(await env.exec('true', undefined, ctx)).toMatchObject({ ok: true });
				const timedOut = await env.exec('sleep 30', { timeout: 0.05 }, ctx);
				expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
			}
			expect(await env.exec('echo done', undefined, ctx)).toMatchObject({
				ok: true,
				value: { exitCode: 0 },
			});
		});
	});

	it('keeps one account out of another account home and temporary files', async () => {
		const temp = await withEnv(backend, 'surveyor', async (env) => {
			await env.writeFile('secret.txt', 'mine', ctx);
			const file = await env.createTempFile(undefined, ctx);
			if (!file.ok) throw new Error('no temporary file');
			await env.writeFile(file.value, 'mine', ctx);
			return file.value;
		});
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile('/home/surveyor/secret.txt', ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
			expect(await env.readTextFile(temp, ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
			const cat = await env.exec('cat /home/surveyor/secret.txt', undefined, ctx);
			expect(cat).toMatchObject({ ok: true, value: { exitCode: 1 } });
		});
	});

	it('spills a large output to a file that only its account reads', async () => {
		const spilled = await withEnv(backend, 'surveyor', async (env) => {
			const result = await env.exec(
				'seq 1 200000',
				{ capture: { limits: { maxBytes: 2_000, maxLines: 50 }, spill: true } },
				ctx,
			);
			if (!result.ok) throw result.error;
			expect(result.value.truncation).toMatchObject({ truncated: true, totalLines: 200_000 });
			const path = result.value.spillPath ?? '';
			const whole = await env.readTextFile(path, ctx);
			expect(whole.ok && whole.value.split('\n').length).toBe(200_001);
			return path;
		});
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile(spilled, ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
		});
		await withEnv(backend, 'surveyor', (env) => env.remove(spilled, undefined, ctx));
	});

	it('keeps each new file in the audit folder writable for every agent', async () => {
		const first = `${layout.audit}.first`;
		const rotated = `${layout.audit}.rotated`;
		await withEnv(backend, 'surveyor', (env) => env.writeFile(first, 'a\n', ctx));
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.appendFile(first, 'b\n', ctx)).toMatchObject({ ok: true });
			expect(await env.renameFile(first, rotated, ctx)).toMatchObject({ ok: true });
			expect(await env.writeFile(first, 'c\n', ctx)).toMatchObject({ ok: true });
		});
		await withEnv(backend, 'surveyor', async (env) => {
			expect(await env.appendFile(first, 'd\n', ctx)).toMatchObject({ ok: true });
			expect(await env.readTextFile(rotated, ctx)).toMatchObject({ ok: true, value: 'a\nb\n' });
			await env.remove(first, undefined, ctx);
			await env.remove(rotated, undefined, ctx);
		});
	});

	it('lets the host account write the rooms folder, and no agent', async () => {
		const path = `${layout.rooms}/lobby.jsonl`;
		await withEnv(backend, 'surveyor', async (env) => {
			expect(await env.writeFile(`${layout.rooms}/x.txt`, 'x', ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
		});
		await withEnv(backend, 'lab-host', (env) => env.writeFile(path, 'entry\n', ctx));
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile(path, ctx)).toMatchObject({ ok: true, value: 'entry\n' });
			expect(await env.appendFile(path, 'forged\n', ctx)).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
		});
	});
});

const context = (agent: string): ToolContext => ({
	agent: { name: agent, identity: agent },
	callId: 'call-1',
	room: 'lobby',
});

describe.skipIf(configPath === undefined)('a workspace on OpenSSH', () => {
	it('audits two agents into one log, each as its own account', async () => {
		const resolved = await options();
		const bashBackend = workstationBackend(resolved);
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: bashBackend, sql: sqliteBackend(':memory:') },
			audit: {},
		});
		try {
			const bash = workspace.tools().tools.find((tool) => tool.name === 'bash');
			if (bash === undefined) throw new Error('No bash tool.');
			const surveyor = await bash.invoke({ command: 'id -un' }, context('surveyor'));
			const planner = await bash.invoke({ command: 'id -un' }, context('planner'));
			expect(JSON.stringify(surveyor)).toContain('surveyor');
			expect(JSON.stringify(planner)).toContain('planner');
			const audit = await withEnv(bashBackend, 'surveyor', (env) =>
				env.readTextFile(resolved.layout.audit, ctx),
			);
			if (!audit.ok) throw audit.error;
			const agents = audit.value
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line).agent);
			expect(agents.slice(-2)).toEqual(['surveyor', 'planner']);
		} finally {
			await workspace.dispose();
		}
	});
});

/** The error of a process that no run of the host runs, and that left no end. */
const LOST = 'The host run ended before the process did.';

/** The agent of the process cases. */
const OWNER = 'planner';

/** Write the spec of a process of an earlier run of the host into the home of `env`. Returns its directory. */
async function specOf(
	env: WorkspaceEnv,
	handle: string,
	command: string,
	timeout = 600,
	startedAt = new Date().toISOString(),
): Promise<string> {
	const dir = await env.absolutePath(`~/.processes/${handle}`, ctx);
	if (!dir.ok) throw dir.error;
	const spec = { handle, kind: 'bash', agent: OWNER, command, timeout, startedAt };
	expect(await env.createDir(dir.value, { recursive: true }, ctx)).toMatchObject({ ok: true });
	expect(await env.writeFile(`${dir.value}/spec`, JSON.stringify(spec), ctx)).toMatchObject({
		ok: true,
	});
	return dir.value;
}

/**
 * Start the wrapper of the process in `dir` over `env`, as the table of an
 * earlier run does, and give the pid that the wrapper writes. The call does
 * not wait for the command.
 */
async function shellOf(env: WorkspaceEnv, dir: string, command: string): Promise<number> {
	const script = [
		`echo "$$" > '${dir}/pid'`,
		'(',
		command,
		`) < /dev/null > '${dir}/out' 2>&1`,
		`echo "$? $(date -u +%Y-%m-%dT%H:%M:%SZ)" > '${dir}/exit.tmp' && mv '${dir}/exit.tmp' '${dir}/exit'`,
	].join('\n');
	void env.exec(script, { timeout: 120 }, ctx);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const pid = await env.readTextFile(`${dir}/pid`, ctx);
		if (pid.ok && pid.value.trim() !== '') return Number(pid.value.trim());
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`No pid in ${dir}.`);
}

/** Whether each of `pids` has ended: no process has it, or a zombie that no init reaps. */
async function allEnded(env: WorkspaceEnv, pids: readonly number[]): Promise<boolean> {
	const check = pids
		.map((pid) => `case "$(ps -o stat= -p ${pid})" in "" | Z*) ;; *) exit 1 ;; esac`)
		.join('\n');
	return (await run(env, check)).code === 0;
}

/** A new run of the host: a workspace over a new backend, and that backend. */
async function nextRun(): Promise<{ workspace: Workspace; backend: Backend }> {
	const backend = workstationBackend(await options());
	return { workspace: openWorkspace({ name: 'lab', backend: { bash: backend } }), backend };
}

/** Call the process tool `name` as the owner, and give the statuses and the text of its result. */
async function call(workspace: Workspace, name: string, params: unknown) {
	const tool = workspace.tools().tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`No tool named ${name}.`);
	const result = await tool.invoke(params, context(OWNER));
	if (typeof result === 'string') throw new Error('A process tool gives a structured result.');
	const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	const details = result.details as { process?: ProcessStatus; processes?: ProcessStatus[] };
	return { process: details.process, processes: details.processes ?? [], text };
}

describe.skipIf(configPath === undefined)('processes on OpenSSH', () => {
	it('adopts the live processes of an earlier run, reads and waits for one, and stops each through its process group', async () => {
		// An earlier run of the host starts two processes over OpenSSH, and then goes away.
		const earlier = workstationBackend(await options());
		const pids = await withEnv(earlier, OWNER, async (env) => {
			await env.exec(WIPE, undefined, ctx);
			const kept = 'sleep 300 &\necho "$!" > child\necho adopted\nwait';
			const late = 'exec sleep 300';
			const lateStart = new Date(Date.now() - 5_000).toISOString();
			return [
				await shellOf(env, await specOf(env, 'bash-0000000000a1', kept), kept),
				await shellOf(env, await specOf(env, 'bash-0000000000a2', late, 1, lateStart), late),
			];
		}).finally(() => earlier.dispose?.());
		const { workspace, backend } = await nextRun();
		try {
			// The first read adopts both. The one past its timeout stops at once.
			const listed = await call(workspace, 'ps', {});
			expect(listed.processes.map((one) => one.handle).sort()).toEqual([
				'bash-0000000000a1',
				'bash-0000000000a2',
			]);
			const status = await call(workspace, 'status', { handle: 'bash-0000000000a1' });
			expect(status.process?.state).toBe('running');
			expect(status.text).toMatch(/^adopted\n/);
			const waited = await call(workspace, 'wait', { handle: 'bash-0000000000a1', timeout: 1 });
			expect(waited.process?.state).toBe('running');
			const late = await call(workspace, 'wait', { handle: 'bash-0000000000a2', timeout: 20 });
			expect(late.process?.state).toBe('timed_out');
			const cancelled = await call(workspace, 'cancel', { handle: 'bash-0000000000a1' });
			expect(cancelled.process?.state).toBe('cancelled');
			// The kill reaches the whole group: each wrapper shell, and the child that one started.
			await withEnv(backend, OWNER, async (env) => {
				const child = await env.readTextFile('child', ctx);
				if (!child.ok) throw child.error;
				expect(await allEnded(env, [...pids, Number(child.value.trim())])).toBe(true);
			});
			expect((await call(workspace, 'ps', {})).text).toBe('No running processes.');
		} finally {
			await workspace.dispose();
		}
	});

	it('writes the lost stop at the first read of a process with a dead pid, and runs no ps for it after', async () => {
		const { workspace, backend } = await nextRun();
		try {
			const [lost, pending] = await withEnv(backend, OWNER, async (env) => {
				await env.exec(WIPE, undefined, ctx);
				// A process whose shell ended and left no end in the files, and a spec with no pid yet.
				const dir = await specOf(env, 'bash-0000000000b1', 'true');
				expect(await run(env, `sh -c 'echo "$$"' > '${dir}/pid'`)).toMatchObject({ code: 0 });
				return [dir, await specOf(env, 'bash-0000000000b2', 'true')];
			});
			const first = await call(workspace, 'status', { handle: 'bash-0000000000b1' });
			expect(first.process).toMatchObject({ state: 'failed', error: LOST });
			expect(first.process?.endedAt).toBeUndefined();
			await withEnv(backend, OWNER, async (env) => {
				expect(await env.readTextFile(`${lost}/stop`, ctx)).toMatchObject({
					ok: true,
					value: expect.stringMatching(
						/^failed \S+ The host run ended before the process did\.\n$/,
					),
				});
				// A process with no pid costs no ps, and its shell can still start: it gets no stop.
				expect(await env.readTextFile(`${pending}/stop`, ctx)).toMatchObject({
					ok: false,
					error: { code: 'not_found' },
				});
				// A live process whose command line names the handle now holds the pid. A ps would find it.
				const decoy = `bash -c 'sleep 300; : bash-0000000000b1' < /dev/null > /dev/null 2>&1 &\necho "$!" > '${lost}/pid'`;
				expect(await run(env, decoy)).toMatchObject({ code: 0 });
			});
			// The stop line keeps the listing from ps, so the process stays failed and out of ps.
			expect((await call(workspace, 'ps', {})).processes).toEqual([]);
			const later = await call(workspace, 'status', { handle: 'bash-0000000000b1' });
			expect(later.process).toMatchObject({ state: 'failed', error: LOST });
			expect(later.process?.endedAt).toBeUndefined();
			// Without the stop line, the next read runs ps, finds the decoy, and adopts it.
			await withEnv(backend, OWNER, (env) => env.remove(`${lost}/stop`, undefined, ctx));
			const found = await call(workspace, 'status', { handle: 'bash-0000000000b1' });
			expect(found.process?.state).toBe('running');
			const cancelled = await call(workspace, 'cancel', { handle: 'bash-0000000000b1' });
			expect(cancelled.process?.state).toBe('cancelled');
			await withEnv(backend, OWNER, async (env) => {
				const pid = await env.readTextFile(`${lost}/pid`, ctx);
				if (!pid.ok) throw pid.error;
				expect(await allEnded(env, [Number(pid.value.trim())])).toBe(true);
			});
		} finally {
			await workspace.dispose();
		}
	});
});
