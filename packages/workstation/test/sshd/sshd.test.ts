/**
 * The integration tier: the workstation against OpenSSH, with one Unix
 * account for each agent. `setup.sh` provisions the accounts and starts
 * `sshd` as root, and this tier runs only when `AMBION_WORKSTATION_SSHD`
 * names the file that `setup.sh` writes. It proves what only a real server
 * can: the rename and the group kill on OpenSSH, its status codes, the
 * channel limit, the bounded output view, the permissions between
 * accounts, and the adoption of a process that outlives the run of the host
 * that started it.
 */

import { parseSnapshotUri, type ToolContext } from '@ambionframework/ambion';
import {
	openWorkspace,
	type ProcessRecord,
	type Workspace,
	type WorkspaceEnv,
} from '@ambionframework/workspace';
import {
	type ConformanceFixture,
	type WorkspaceConformanceStore,
	workspaceConformance,
} from '@ambionframework/workspace/conformance';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type WorkstationOptions, workstationBackend } from '../../src/index.ts';
import { type Backend, configPath, options, run, WIPE, withEnv } from '../support/sshd.ts';

const fixture: ConformanceFixture<WorkspaceConformanceStore> = {
	name: 'workstation on OpenSSH',
	async open() {
		const backend = workstationBackend(await options());
		await withEnv(backend, 'conformance', (env) => env.exec(WIPE, undefined));
		return { backend, dispose: async () => backend.dispose?.() };
	},
};

describe.skipIf(configPath === undefined)('integration tier', () => {
	describe(fixture.name, () => {
		for (const c of workspaceConformance(fixture)) it(c.name, c.run);
	});

	let backend: Backend;
	let layout: WorkstationOptions['layout'];
	beforeAll(async () => {
		const resolved = await options();
		layout = resolved.layout;
		backend = workstationBackend(resolved);
		for (const agent of ['surveyor', 'planner']) {
			await withEnv(backend, agent, (env) => env.exec(WIPE, undefined));
		}
		await withEnv(backend, 'lab-host', (env) =>
			env.exec(`rm -rf -- ${layout.rooms}/* ${layout.snapshots}/*`, undefined),
		);
	});
	afterAll(async () => backend.dispose?.());

	it('classifies the status codes of OpenSSH by the kind of operation', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			await env.createDir('full', undefined);
			await env.writeFile('full/a.txt', 'x');
			expect(await env.remove('full', undefined)).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
			expect(await env.readTextFile('full/a.txt/x')).toMatchObject({
				ok: false,
				error: { code: 'not_directory' },
			});
			expect(await env.readTextFile('none/a.txt')).toMatchObject({
				ok: false,
				error: { code: 'not_found' },
			});
			expect(await env.renameFile('full/a.txt', 'none/b.txt')).toMatchObject({
				ok: false,
				error: { code: 'not_found' },
			});
			expect(await env.writeFile('deep/er/a.txt', 'x')).toMatchObject({ ok: true });
			expect(await env.createDir('full', { recursive: false })).toMatchObject({
				ok: false,
				error: { code: 'invalid' },
			});
		});
	});

	it('kills the whole process group on a timeout', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			const timedOut = await env.exec('sleep 30 & echo $! > child.pid; sleep 30', { timeout: 0.5 });
			expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
			// A killed child that no init reaps stays a zombie, and `kill -0` still finds it.
			const gone = await env.exec(
				'sleep 0.2; case "$(ps -o stat= -p "$(cat child.pid)")" in "" | Z*) exit 0 ;; *) exit 1 ;; esac',
				undefined,
			);
			expect(gone).toMatchObject({ ok: true, value: { exitCode: 0 } });
		});
	});

	it('stays under MaxSessions over many commands, timeouts, and aborts on one client', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			for (let i = 0; i < 12; i += 1) {
				expect(await env.exec('true', undefined)).toMatchObject({ ok: true });
				const timedOut = await env.exec('sleep 30', { timeout: 0.05 });
				expect(timedOut).toMatchObject({ ok: false, error: { code: 'timeout' } });
			}
			expect(await env.exec('echo done', undefined)).toMatchObject({
				ok: true,
				value: { exitCode: 0 },
			});
		});
	});

	it('keeps one account out of another account home', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			await env.writeFile('secret.txt', 'mine');
		});
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.readTextFile('/home/surveyor/secret.txt')).toMatchObject({
				ok: false,
				error: { code: 'permission_denied' },
			});
			const cat = await env.exec('cat /home/surveyor/secret.txt', undefined);
			expect(cat).toMatchObject({ ok: true, value: { exitCode: 1 } });
		});
	});

	it('bounds a large output to the view', async () => {
		await withEnv(backend, 'surveyor', async (env) => {
			const result = await env.exec('seq 1 200000', {
				capture: { limits: { maxBytes: 2_000, maxLines: 50 } },
			});
			if (!result.ok) throw result.error;
			expect(result.value.truncation).toMatchObject({ truncated: true, totalLines: 200_000 });
		});
	});

	it('keeps each new file in the audit folder writable for every agent', async () => {
		const first = `${layout.audit}.first`;
		const rotated = `${layout.audit}.rotated`;
		await withEnv(backend, 'surveyor', (env) => env.writeFile(first, 'a\n'));
		await withEnv(backend, 'planner', async (env) => {
			expect(await env.appendFile(first, 'b\n')).toMatchObject({ ok: true });
			expect(await env.renameFile(first, rotated)).toMatchObject({ ok: true });
			expect(await env.writeFile(first, 'c\n')).toMatchObject({ ok: true });
		});
		await withEnv(backend, 'surveyor', async (env) => {
			expect(await env.appendFile(first, 'd\n')).toMatchObject({ ok: true });
			expect(await env.readTextFile(rotated)).toMatchObject({ ok: true, value: 'a\nb\n' });
			await env.remove(first, undefined);
			await env.remove(rotated, undefined);
		});
	});

	it.each(['rooms', 'snapshots'] as const)(
		'lets the host account write the %s folder, and no agent',
		async (folder) => {
			const path = `${layout[folder]}/lobby.jsonl`;
			await withEnv(backend, 'surveyor', async (env) => {
				expect(await env.writeFile(`${layout[folder]}/x.txt`, 'x')).toMatchObject({
					ok: false,
					error: { code: 'permission_denied' },
				});
			});
			await withEnv(backend, 'lab-host', (env) => env.writeFile(path, 'entry\n'));
			await withEnv(backend, 'planner', async (env) => {
				expect(await env.readTextFile(path)).toMatchObject({ ok: true, value: 'entry\n' });
				expect(await env.appendFile(path, 'forged\n')).toMatchObject({
					ok: false,
					error: { code: 'permission_denied' },
				});
			});
		},
	);
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
				env.readTextFile(resolved.layout.audit),
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

	it("snapshots a file of an agent's home as that agent, every agent reads the copy and none changes it, and restore writes it into another home", async () => {
		const resolved = await options();
		const bashBackend = workstationBackend(resolved);
		const workspace = openWorkspace({ name: 'lab', backend: { bash: bashBackend } });
		try {
			await withEnv(bashBackend, 'surveyor', (env) => env.writeFile('plan.md', 'pour\n'));
			const [ref] = await workspace.snapshot(['plan.md'], { agent: { name: 'surveyor' } });
			const digest = parseSnapshotUri(ref ?? '')?.digest ?? '';
			const copy = `${resolved.layout.snapshots}/${digest}`;
			await withEnv(bashBackend, 'planner', async (env) => {
				expect(await env.readTextFile(copy)).toMatchObject({ ok: true, value: 'pour\n' });
				expect(await env.writeFile(copy, 'forged\n')).toMatchObject({
					ok: false,
					error: { code: 'permission_denied' },
				});
			});
			// restore reads the object as the host and writes it into the home of planner, as planner.
			const restore = workspace.tools().tools.find((tool) => tool.name === 'restore');
			if (restore === undefined) throw new Error('No restore tool.');
			await restore.invoke({ ref, path: 'plan.md' }, context('planner'));
			await withEnv(bashBackend, 'planner', async (env) => {
				expect(await env.readTextFile('plan.md')).toMatchObject({ ok: true, value: 'pour\n' });
			});
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
	const dir = await env.absolutePath(`~/.processes/${handle}`);
	if (!dir.ok) throw dir.error;
	const spec = { handle, kind: 'bash', agent: OWNER, command, timeout, grace: 10, startedAt };
	expect(await env.createDir(dir.value, { recursive: true })).toMatchObject({ ok: true });
	expect(await env.writeFile(`${dir.value}/spec`, JSON.stringify(spec))).toMatchObject({
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
		'trap : TERM',
		`echo "$$" > '${dir}/pid'`,
		'(',
		command,
		`) < /dev/null > '${dir}/out' 2>&1`,
		`echo "$? $(date -u +%Y-%m-%dT%H:%M:%SZ)" > '${dir}/exit.tmp' && mv '${dir}/exit.tmp' '${dir}/exit'`,
	].join('\n');
	void env.exec(script, { timeout: 120 });
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const pid = await env.readTextFile(`${dir}/pid`);
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
	const details = result.details as { process?: ProcessRecord; processes?: ProcessRecord[] };
	return { process: details.process, processes: details.processes ?? [], text };
}

/**
 * A status call on a lost process fails, and its text states the loss. The
 * host reads the same table, so it gives the final state of the process.
 */
async function lostStatus(workspace: Workspace, handle: string) {
	await expect(call(workspace, 'status', { handle })).rejects.toThrow(
		`Process ${handle} failed: ${LOST}`,
	);
	return (await workspace.processes.list({ agent: OWNER })).find((one) => one.handle === handle);
}

describe.skipIf(configPath === undefined)('processes on OpenSSH', () => {
	it('adopts the live processes of an earlier run, reads and waits for one, and cancels each through its process group', async () => {
		// An earlier run of the host starts two processes over OpenSSH, and then goes away.
		const earlier = workstationBackend(await options());
		const pids = await withEnv(earlier, OWNER, async (env) => {
			await env.exec(WIPE, undefined);
			const kept = 'sleep 300 &\necho "$!" > child\necho adopted\nwait';
			const late = 'exec sleep 300';
			const lateStart = new Date(Date.now() - 5_000).toISOString();
			const lateDir = await specOf(env, 'bash-0000000000a2', late, 1, lateStart);
			const shells = [
				await shellOf(env, await specOf(env, 'bash-0000000000a1', kept), kept),
				await shellOf(env, lateDir, late),
			];
			// A read whose ps failed once wrote the lost stop for the live shell of the late one.
			const line = `failed ${new Date().toISOString()} ${LOST}\n`;
			expect(await env.writeFile(`${lateDir}/stop`, line)).toMatchObject({ ok: true });
			return shells;
		}).finally(() => earlier.dispose?.());
		const { workspace, backend } = await nextRun();
		try {
			// The first read adopts both: the pid of the late one is in /proc, so the listing runs ps
			// for it despite its lost stop. The one past its timeout cancels at once.
			const listed = await call(workspace, 'ps', {});
			expect(listed.processes.map((one) => one.handle).sort()).toEqual([
				'bash-0000000000a1',
				'bash-0000000000a2',
			]);
			const status = await call(workspace, 'status', { handle: 'bash-0000000000a1' });
			expect(status.process?.state).toBe('running');
			expect(status.text).toMatch(/^adopted\n/);
			const waited = await call(workspace, 'wait', {
				handles: ['bash-0000000000a1'],
				timeout: 1,
			});
			expect(waited.process?.state).toBe('running');
			// A process that timed out fails the wait, and the text states the timeout.
			await expect(
				call(workspace, 'wait', { handles: ['bash-0000000000a2'], timeout: 20 }),
			).rejects.toThrow(/Process bash-0000000000a2 timed out/);
			const cancelled = await call(workspace, 'cancel', { handle: 'bash-0000000000a1' });
			expect(cancelled.process?.state).toBe('cancelled');
			// The kill reaches the whole group: each wrapper shell, and the child that one started.
			await withEnv(backend, OWNER, async (env) => {
				const child = await env.readTextFile('child');
				if (!child.ok) throw child.error;
				expect(await allEnded(env, [...pids, Number(child.value.trim())])).toBe(true);
			});
			expect((await call(workspace, 'ps', {})).text).toBe('No running processes.');
		} finally {
			await workspace.dispose();
		}
	});

	it('writes the lost stop at the first read of a process with a dead pid, runs no ps for it while the pid is out of /proc, and adopts it when the pid is back', async () => {
		const { workspace, backend } = await nextRun();
		try {
			const [lost, pending, decoy] = await withEnv(backend, OWNER, async (env) => {
				await env.exec(WIPE, undefined);
				// A process whose shell ended and left no end in the files, and a spec with no pid yet.
				const dir = await specOf(env, 'bash-0000000000b1', 'true');
				expect(await run(env, `sh -c 'echo "$$"' > '${dir}/pid'`)).toMatchObject({ code: 0 });
				// A live process whose command line names the handle. A ps of its pid finds it.
				const started = await run(
					env,
					`bash -c 'sleep 300; : bash-0000000000b1' < /dev/null > /dev/null 2>&1 &\necho "$!"`,
				);
				return [dir, await specOf(env, 'bash-0000000000b2', 'true'), Number(started.output.trim())];
			});
			const first = await lostStatus(workspace, 'bash-0000000000b1');
			expect(first).toMatchObject({ state: 'failed', error: LOST });
			expect(first?.endedAt).toBeUndefined();
			await withEnv(backend, OWNER, async (env) => {
				expect(await env.readTextFile(`${lost}/stop`)).toMatchObject({
					ok: true,
					value: expect.stringMatching(
						/^failed \S+ The host run ended before the process did\.\n$/,
					),
				});
				// A process with no pid costs no ps, and its shell can still start: it gets no stop.
				expect(await env.readTextFile(`${pending}/stop`)).toMatchObject({
					ok: false,
					error: { code: 'not_found' },
				});
			});
			// The dead pid is out of /proc, so the next read skips the process and it stays failed.
			expect(await lostStatus(workspace, 'bash-0000000000b1')).toMatchObject({
				state: 'failed',
				error: LOST,
			});
			// The pid file now names the decoy twice, as a list: ps reads the list, and /proc has no
			// directory of that name. Only the skip keeps the decoy from the listing.
			await withEnv(backend, OWNER, (env) => env.writeFile(`${lost}/pid`, `${decoy},${decoy}\n`));
			expect((await call(workspace, 'ps', {})).processes).toEqual([]);
			expect(await lostStatus(workspace, 'bash-0000000000b1')).toMatchObject({
				state: 'failed',
				error: LOST,
			});
			// With the pid of the decoy alone, /proc has it: the listing runs ps and adopts it.
			await withEnv(backend, OWNER, (env) => env.writeFile(`${lost}/pid`, `${decoy}\n`));
			const found = await call(workspace, 'status', { handle: 'bash-0000000000b1' });
			expect(found.process?.state).toBe('running');
			const cancelled = await call(workspace, 'cancel', { handle: 'bash-0000000000b1' });
			expect(cancelled.process?.state).toBe('cancelled');
			await withEnv(backend, OWNER, async (env) => {
				// The stop of the cancel writes over the lost line.
				expect(await env.readTextFile(`${lost}/stop`)).toMatchObject({
					ok: true,
					value: expect.stringMatching(/^cancelled /),
				});
				expect(await allEnded(env, [decoy])).toBe(true);
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('cancels an owned process with SIGTERM: a trap ends it inside the grace, and SIGKILL ends one that ignores TERM', async () => {
		const { workspace, backend } = await nextRun();
		try {
			await withEnv(backend, OWNER, (env) => env.exec(WIPE, undefined));
			const clean = "trap 'echo cleanup; exit 0' TERM\nsleep 300 &\nwait";
			const started = await call(workspace, 'bash', { command: clean, wait: 0 });
			const cancelled = await call(workspace, 'cancel', { handle: started.process?.handle });
			expect(cancelled.process).toMatchObject({ state: 'exited', exitCode: 0 });
			expect(cancelled.text).toMatch(/^cleanup\n\n\[Process /);
			const stubborn = 'trap \'\' TERM\nsleep 300 &\necho "$!" > child\nwait';
			const ignoring = await call(workspace, 'bash', { command: stubborn, wait: 1 });
			const began = Date.now();
			const killed = await call(workspace, 'cancel', { handle: ignoring.process?.handle });
			expect(Date.now() - began).toBeGreaterThanOrEqual(10_000);
			expect(killed.process?.state).toBe('cancelled');
			await withEnv(backend, OWNER, async (env) => {
				const child = await env.readTextFile('child');
				if (!child.ok) throw child.error;
				expect(await allEnded(env, [Number(child.value.trim())])).toBe(true);
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('cancels an owned process that ignores TERM after the grace of its call', async () => {
		const { workspace, backend } = await nextRun();
		try {
			await withEnv(backend, OWNER, (env) => env.exec(WIPE, undefined));
			const stubborn = 'trap \'\' TERM\nsleep 300 &\necho "$!" > child\nwait';
			const started = await call(workspace, 'bash', { command: stubborn, grace: 2, wait: 1 });
			expect(started.process).toMatchObject({ state: 'running', grace: 2 });
			const began = Date.now();
			const killed = await call(workspace, 'cancel', { handle: started.process?.handle });
			const elapsed = Date.now() - began;
			// The default grace of 10 s would hold the cancel for longer.
			expect(elapsed).toBeGreaterThanOrEqual(2_000);
			expect(elapsed).toBeLessThan(9_000);
			expect(killed.process?.state).toBe('cancelled');
			await withEnv(backend, OWNER, async (env) => {
				const child = await env.readTextFile('child');
				if (!child.ok) throw child.error;
				expect(await allEnded(env, [Number(child.value.trim())])).toBe(true);
			});
		} finally {
			await workspace.dispose();
		}
	});

	it('disposes 4 processes of one agent that ignore TERM in about one grace, inside the channel limit', async () => {
		const { workspace } = await nextRun();
		const checker = workstationBackend(await options());
		try {
			await withEnv(checker, OWNER, (env) => env.exec(WIPE, undefined));
			const names = ['one', 'two', 'three', 'four'];
			for (const name of names) {
				const command = `trap '' TERM\nsleep 300 &\necho "$!" > child-${name}\nwait`;
				await call(workspace, 'bash', { command, wait: 1 });
			}
			const began = Date.now();
			await workspace.dispose();
			const elapsed = Date.now() - began;
			expect(elapsed).toBeGreaterThanOrEqual(10_000);
			expect(elapsed).toBeLessThan(25_000);
			await withEnv(checker, OWNER, async (env) => {
				const pids: number[] = [];
				for (const name of names) {
					const child = await env.readTextFile(`child-${name}`);
					if (!child.ok) throw child.error;
					pids.push(Number(child.value.trim()));
				}
				expect(await allEnded(env, pids)).toBe(true);
			});
		} finally {
			await workspace.dispose();
			await checker.dispose?.();
		}
	}, 60_000);
});
