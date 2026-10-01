/**
 * The graceful stop of a process on a real signal path: the table over the
 * workstation's in-process SSH server, which runs each command in a real
 * shell on this machine. A stop sends `SIGTERM` to the process group, waits
 * for the grace, and then sends `SIGKILL`. The just-bash case, a stop with
 * no signals, is in `processes.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolContext } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { workstationBackend } from '../../workstation/src/index.ts';
import { startSshServer, type TestServer } from '../../workstation/test/support/server.ts';
import { hasSetsid } from '../../workstation/test/support/setsid.ts';
import type { ProcessStatus } from '../src/process-files.ts';
import { openWorkspace, type Workspace } from '../src/workspace.ts';
import { toolOf } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;

async function server(accounts: readonly string[]): Promise<TestServer> {
	const started = await startSshServer(accounts);
	onTestFinished(() => started.stop());
	return started;
}

/** A workspace of one run of the host over the server. */
function workspaceOn(started: TestServer): Workspace {
	const workspace = openWorkspace({
		name: 'lab',
		backend: { bash: workstationBackend(started.options) },
	});
	onTestFinished(() => workspace.dispose());
	return workspace;
}

const context = (agent: string): ToolContext => ({
	agent: { name: agent, identity: agent },
	callId: 'call-1',
	room: 'lobby',
});

/** The process has ended: no process has the pid, or a zombie that its parent has not reaped yet. */
function ended(pid: number): boolean {
	const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
	return /^(Z.*)?$/.test(ps.stdout.trim());
}

const until = async (check: () => boolean, ms = 2_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
};

/** Invoke `tool` as `agent`, and give the text and the process details of the result, or the text of its error. */
const invoke = async (workspace: Workspace, tool: string, params: unknown, agent = 'ada') => {
	const result = await Promise.resolve(
		toolOf(workspace, tool).invoke(params, context(agent)),
	).catch((error: unknown) => ({ content: [{ type: 'text' as const, text: String(error) }] }));
	if (typeof result === 'string') throw new Error('A process tool gives a structured result.');
	const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	const details = 'details' in result ? (result.details as { process?: ProcessStatus }) : {};
	return { text, process: details.process };
};

/**
 * A process that an earlier run of the host started for `agent`: its command
 * runs `onTerm` for each TERM, by default a log line, and goes on. Give its directory and the pid of its wrapper.
 */
async function earlierProcess(
	started: TestServer,
	agent: string,
	handle: string,
	grace = 10,
	onTerm = 'echo term',
) {
	const dir = join(started.homes.get(agent) ?? '', '.processes', handle);
	await mkdir(dir, { recursive: true });
	const spec = { handle, kind: 'bash', agent, command: 'loop' };
	await writeFile(
		join(dir, 'spec'),
		JSON.stringify({
			...spec,
			timeout: 600,
			grace,
			startedAt: new Date().toISOString(),
		}),
	);
	const earlier = workstationBackend(started.options);
	const env = await earlier.connect({ name: agent });
	const script = [
		'trap : TERM',
		`echo "$$" > '${dir}/pid'`,
		'(',
		`trap '${onTerm}' TERM`,
		'while :; do sleep 0.2; done',
		`) < /dev/null > '${dir}/out' 2>&1`,
		`echo "$? x" > '${dir}/exit'`,
	].join('\n');
	void env.exec(script, { timeout: 60 }, ctx).catch(() => undefined);
	await until(() => spawnSync('test', ['-s', join(dir, 'pid')]).status === 0);
	const pid = Number((await readFile(join(dir, 'pid'), 'utf8')).trim());
	await env.cleanup();
	await earlier.dispose?.();
	return { dir, pid };
}

describe.skipIf(!hasSetsid)('a stop on a real signal path', () => {
	it('lets a command that traps TERM end inside the grace: a cancel and a timeout read its own exit code', async () => {
		const started = await server(['ada']);
		const workspace = workspaceOn(started);
		const command = "trap 'echo cleanup; exit 0' TERM\nsleep 30 & wait";
		const running = await invoke(workspace, 'bash', { command, wait: 0 });
		const handle = running.process?.handle ?? '';
		const cancelled = await invoke(workspace, 'cancel', { handle });
		// The cancel stopped the process, so the result has no line that says it stopped nothing.
		expect(cancelled.text).toMatch(/^cleanup\n\n\[Process bash-[0-9a-f]{12} exited with code 0\./);
		expect(cancelled.process).toMatchObject({ state: 'exited', exitCode: 0 });
		expect(await readFile(join(dirname(cancelled.process?.output ?? ''), 'stop'), 'utf8')).toMatch(
			/^cancelled /,
		);
		// The timeout takes the same path: SIGTERM, and the trap ends the command with code 0.
		const timed = await invoke(workspace, 'bash', { command, timeout: 1, wait: 10 });
		expect(timed.text).toMatch(/^cleanup\n\n\[Process bash-[0-9a-f]{12} exited with code 0\./);
		expect(await readFile(join(dirname(timed.process?.output ?? ''), 'stop'), 'utf8')).toMatch(
			/^timed_out /,
		);
	});

	it('sends SIGKILL after the grace to an owned and an adopted process that ignore TERM, and shows the stop while it waits', async () => {
		const started = await server(['ada', 'bob']);
		const { dir, pid: adopted } = await earlierProcess(started, 'bob', 'bash-0000000000b1');
		const workspace = workspaceOn(started);
		const owned = await invoke(workspace, 'bash', { command: "trap '' TERM\nsleep 60", wait: 0 });
		const handle = owned.process?.handle ?? '';
		expect((await invoke(workspace, 'ps', {}, 'bob')).text).toContain('bash-0000000000b1');
		const began = Date.now();
		const stops = Promise.all([
			invoke(workspace, 'cancel', { handle }),
			invoke(workspace, 'cancel', { handle: 'bash-0000000000b1' }, 'bob'),
		]);
		// While the grace runs, the status reads running, and names the stop that waits.
		let listed: ProcessStatus | undefined;
		for (let reads = 0; listed?.stopping !== true && reads < 50; reads += 1) {
			[listed] = await workspace.processes.list({ agent: 'ada' });
		}
		expect(listed).toMatchObject({ handle, state: 'running', stopping: true });
		expect((await invoke(workspace, 'status', { handle })).text).toContain(
			'is running, and the table stopped it. It has not ended yet.',
		);
		const [ownedEnd, adoptedEnd] = await stops;
		expect(Date.now() - began).toBeGreaterThanOrEqual(10_000);
		expect(ownedEnd.process?.state).toBe('cancelled');
		expect(adoptedEnd.process?.state).toBe('cancelled');
		expect(ended(adopted)).toBe(true);
		// The adopted command got the SIGTERM first: its trap wrote to the output.
		expect(await readFile(join(dir, 'out'), 'utf8')).toContain('term');
		await expect(readFile(join(dir, 'exit'), 'utf8')).rejects.toThrow();
	}, 30_000);

	it.each([
		{ grace: 2, nap: 1, state: 'exited' },
		{ grace: 1, nap: 5, state: 'cancelled' },
	])(
		'gives the grace $grace to the backend: a trap that naps $nap s reads $state',
		async ({ grace, nap, state }) => {
			const started = await server(['ada']);
			const workspace = workspaceOn(started);
			const command = `trap 'sleep ${nap}; exit 0' TERM\nsleep 60 & wait`;
			const running = await invoke(workspace, 'bash', { command, grace, wait: 0 });
			expect(running.process?.grace).toBe(grace);
			const handle = running.process?.handle ?? '';
			await until(
				() =>
					spawnSync('test', ['-s', join(dirname(running.process?.output ?? ''), 'pid')]).status ===
					0,
			);
			const cancelled = await invoke(workspace, 'cancel', { handle });
			expect(cancelled.process?.state).toBe(state);
		},
		20_000,
	);

	it('lets a stop with a long grace hold nothing: cancel returns after 15 s, a later cancel of the agent does not wait, and SIGKILL comes after the grace', async () => {
		const started = await server(['ada']);
		const workspace = workspaceOn(started);
		const stubborn = await invoke(workspace, 'bash', {
			command: "trap '' TERM\nsleep 90",
			grace: 30,
			wait: 0,
		});
		const quick = await invoke(workspace, 'bash', {
			command: "trap 'exit 0' TERM\nsleep 60 & wait",
			wait: 0,
		});
		const handle = stubborn.process?.handle ?? '';
		expect(stubborn.process?.grace).toBe(30);
		const began = Date.now();
		const first = invoke(workspace, 'cancel', { handle });
		// A second cancel of the same process joins the stop that runs.
		const joined = invoke(workspace, 'cancel', { handle });
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		// The grace of the first stop does not hold the chain of the agent.
		const second = await invoke(workspace, 'cancel', { handle: quick.process?.handle ?? '' });
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(second.process).toMatchObject({ state: 'exited', exitCode: 0 });
		const early = await first;
		expect((await joined).process).toMatchObject({ state: 'running', stopping: true });
		expect(Date.now() - began).toBeGreaterThanOrEqual(14_000);
		expect(Date.now() - began).toBeLessThan(25_000);
		expect(early.process).toMatchObject({ state: 'running', stopping: true });
		expect(early.text).toContain('is running, and the table stopped it. It has not ended yet.');
		// The host timer sends SIGKILL after the full grace.
		const ending = await invoke(workspace, 'wait', { handles: [handle], timeout: 25 });
		expect(ending.process?.state).toBe('cancelled');
	}, 60_000);

	it('gives an adopted process the grace of its spec', async () => {
		const started = await server(['ada']);
		const { pid } = await earlierProcess(started, 'ada', 'bash-0000000000a1', 2);
		const workspace = workspaceOn(started);
		expect((await invoke(workspace, 'ps', {})).text).toContain('bash-0000000000a1');
		expect((await workspace.processes.list({ agent: 'ada' }))[0]).toMatchObject({ grace: 2 });
		const began = Date.now();
		const cancelled = await invoke(workspace, 'cancel', { handle: 'bash-0000000000a1' });
		// The default grace of 10 s would hold the stop longer.
		expect(Date.now() - began).toBeLessThan(9_000);
		expect(cancelled.process?.state).toBe('cancelled');
		expect(ended(pid)).toBe(true);
	}, 20_000);

	it('returns at once for an adopted process that ends inside its grace', async () => {
		const started = await server(['ada']);
		const { pid } = await earlierProcess(started, 'ada', 'bash-0000000000a2', 30, 'exit 0');
		const workspace = workspaceOn(started);
		await invoke(workspace, 'ps', {});
		const began = Date.now();
		const cancelled = await invoke(workspace, 'cancel', { handle: 'bash-0000000000a2' });
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(cancelled.process).toMatchObject({ state: 'exited', exitCode: 0 });
		expect(ended(pid)).toBe(true);
	}, 20_000);

	it('disposes 4 processes of one agent that ignore TERM, and an adopted one, in about one grace, and ends every wrapper', async () => {
		const started = await server(['ada', 'bob']);
		const earlier = await earlierProcess(started, 'bob', 'bash-0000000000b1');
		const workspace = workspaceOn(started);
		const handles: string[] = [];
		for (let count = 0; count < 4; count += 1) {
			const running = await invoke(workspace, 'bash', {
				command: "trap '' TERM\nsleep 60",
				wait: 0,
			});
			handles.push(running.process?.handle ?? '');
		}
		const dirs = handles.map((handle) =>
			join(started.homes.get('ada') ?? '', '.processes', handle),
		);
		await until(() =>
			dirs.every((dir) => spawnSync('test', ['-s', join(dir, 'pid')]).status === 0),
		);
		const pids = await Promise.all(
			dirs.map(async (dir) => Number((await readFile(join(dir, 'pid'), 'utf8')).trim())),
		);
		expect((await invoke(workspace, 'ps', {}, 'bob')).text).toContain('bash-0000000000b1');
		const began = Date.now();
		await workspace.dispose();
		const elapsed = Date.now() - began;
		// The 4 graces run at the same time: about one grace and the kill.
		expect(elapsed).toBeGreaterThanOrEqual(10_000);
		expect(elapsed).toBeLessThan(25_000);
		expect([...pids, earlier.pid].map(ended)).toEqual([true, true, true, true, true]);
	}, 40_000);
});
