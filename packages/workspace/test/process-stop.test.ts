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
		// An earlier run of the host started a process for bob: its command logs each TERM and goes on.
		const dir = join(started.homes.get('bob') ?? '', '.processes', 'bash-0000000000b1');
		await mkdir(dir, { recursive: true });
		const spec = { handle: 'bash-0000000000b1', kind: 'bash', agent: 'bob', command: 'loop' };
		await writeFile(
			join(dir, 'spec'),
			JSON.stringify({ ...spec, timeout: 600, startedAt: new Date().toISOString() }),
		);
		const earlier = workstationBackend(started.options);
		const env = await earlier.connect({ name: 'bob' });
		const script = [
			'trap : TERM',
			`echo "$$" > '${dir}/pid'`,
			'(',
			"trap 'echo term' TERM",
			'while :; do sleep 0.2; done',
			`) < /dev/null > '${dir}/out' 2>&1`,
			`echo "$? x" > '${dir}/exit'`,
		].join('\n');
		void env.exec(script, { timeout: 60 }, ctx).catch(() => undefined);
		await until(() => spawnSync('test', ['-s', join(dir, 'pid')]).status === 0);
		const adopted = Number((await readFile(join(dir, 'pid'), 'utf8')).trim());
		await env.cleanup();
		await earlier.dispose?.();
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
			'is running, and a stop waits for its end.',
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
});
