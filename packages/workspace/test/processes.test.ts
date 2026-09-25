import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { tempDir } from '../../just-bash/test/support/backends.ts';
import {
	LOST,
	type ProcessFiles,
	processesDir,
	statusOf,
	stopLine,
	writeExit,
	writeSpec,
	writeStop,
} from '../src/process-files.ts';
import { FINISHED_IN_REMINDER } from '../src/process-text.ts';
import type { ProcessDetails, PsDetails } from '../src/process-tools.ts';
import { MAX_FINISHED_PROCESSES, MAX_RUNNING_PROCESSES } from '../src/processes.ts';
import { openWorkspace, type Workspace } from '../src/workspace.ts';
import { callAs, invokeText, toolOf, wrapped } from './support/backends.ts';

let serial = 0;

function site(): Workspace {
	serial += 1;
	const workspace = openWorkspace({
		name: `processes-${serial}`,
		backend: { bash: memoryBackend() },
	});
	onTestFinished(() => workspace.dispose());
	return workspace;
}

const HANDLE = /bash-[0-9a-f]{12}/;

/** Invoke `tool` as `agent`, and return its text and its process details. */
async function call(
	workspace: Workspace,
	tool: string,
	params: unknown,
	agent = 'alpha',
	room?: string,
): Promise<{ text: string; details: ProcessDetails }> {
	const context = callAs(agent, room === undefined ? {} : { room });
	const result = await toolOf(workspace, tool).invoke(params, context);
	if (typeof result === 'string') throw new Error('A process tool gives a structured result.');
	const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	return { text, details: result.details as ProcessDetails };
}

/** The handle that a failed call names in its text. */
/** The text of the error a call fails with. */
async function failure(invoke: () => unknown): Promise<string> {
	return Promise.resolve()
		.then(invoke)
		.then(
			() => {
				throw new Error('The call must fail.');
			},
			(reason: unknown) => String(reason),
		);
}

async function failedHandle(invoke: () => unknown): Promise<string> {
	const error = await failure(invoke);
	const handle = HANDLE.exec(error)?.[0];
	if (handle === undefined) throw new Error(`No handle in ${error}`);
	return handle;
}

/** Start a process with a wait of 0, and resolve once it ends: no result shows its end. */
async function endedUnseen(workspace: Workspace, command: string): Promise<string> {
	const done = Promise.withResolvers<void>();
	let handle = '';
	const unsubscribe = workspace.processes.subscribe((event) => {
		if (event.type === 'ended' && event.process.handle === handle) done.resolve();
	});
	handle = (await call(workspace, 'bash', { command, wait: 0 })).details.process.handle;
	const running = await workspace.processes.list({ running: true });
	if (running.every((one) => one.handle !== handle)) {
		done.resolve();
	}
	await done.promise;
	unsubscribe();
	return handle;
}

async function fileOf(workspace: Workspace, agent: string, path: string): Promise<string> {
	return workspace.use({ name: agent }, async (env) => {
		const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
		if (!read.ok) throw read.error;
		return read.value;
	});
}

describe('bash', () => {
	it('runs a short command as a process that ends in the call, with its output inline and in the output file', async () => {
		const workspace = site();
		const { text, details } = await call(workspace, 'bash', { command: 'echo out; echo err >&2' });
		const { handle, output } = details.process;
		expect(details.process).toMatchObject({ kind: 'bash', state: 'exited', exitCode: 0 });
		expect(output).toBe(`/home/alpha/.processes/${handle}/out`);
		expect(text).toBe(`out\nerr\n\n[Process ${handle} exited with code 0. Output: ${output}.]`);
		expect(await fileOf(workspace, 'alpha', output)).toBe('out\nerr\n');
	});

	it('returns a running process at once with wait 0, and status, wait and the output file reach it', async () => {
		const workspace = site();
		const started = await call(workspace, 'bash', {
			command: 'sleep 0.3; echo done',
			wait: 0,
		});
		const { handle } = started.details.process;
		expect(started.details.process.state).toBe('running');
		expect(started.text).toContain(`Process ${handle} is running.`);
		expect(started.text).toContain('Call status, wait or cancel with its handle.');
		expect((await call(workspace, 'status', { handle })).details.process.state).toBe('running');
		// A running process holds no operation of the bash owner.
		expect(await workspace.use({ name: 'alpha' }, () => 'free')).toBe('free');
		const waited = await call(workspace, 'wait', { handle, timeout: 5 });
		expect(waited.details.process).toMatchObject({ state: 'exited', exitCode: 0 });
		expect(waited.text.startsWith('done\n\n[Process')).toBe(true);
		// The cursor stands after what wait showed, so status gives no output twice.
		const again = await call(workspace, 'status', { handle });
		expect(again.text.startsWith('(no new output)\n\n[Process')).toBe(true);
		expect(again.details.read).toEqual({ from: 5, to: 5 });
		// Output past the cursor comes back alone, with the byte it starts at.
		await workspace.use({ name: 'alpha' }, (env) =>
			env.writeFile(waited.details.process.output, 'done\nmore\n', BACKGROUND_CONTEXT),
		);
		const more = await call(workspace, 'status', { handle });
		expect(more.text).toMatch(
			/^more\n\n\[Process .* The text above starts at byte 5 of the output\./s,
		);
		expect(more.details.read).toEqual({ from: 5, to: 10 });
	});

	it('gives the running state when wait ends before the process', async () => {
		const workspace = site();
		const { details } = await call(workspace, 'bash', { command: 'sleep 5', wait: 0 });
		const waited = await call(workspace, 'wait', { handle: details.process.handle, timeout: 0.05 });
		expect(waited.details.process.state).toBe('running');
	});

	it.each([
		['read whole', 5000],
		['read with tail, past 200 KB', 60000],
	])(
		'shows the end of a long output, %s, and keeps the whole output in the file',
		async (_case, lines) => {
			const workspace = site();
			const { text, details } = await call(workspace, 'bash', { command: `seq 1 ${lines}` });
			expect(details.truncation).toMatchObject({ truncated: true, outputLines: 2000 });
			expect(text.startsWith(`${lines - 1999}\n`)).toBe(true);
			expect(text).toContain(`${lines}\n\n[Process`);
			expect(text).toContain('The text above is the last 2000 lines');
			const whole = await fileOf(workspace, 'alpha', details.process.output);
			expect(whole.split('\n').length).toBe(lines + 1);
			expect(details.truncation?.totalBytes).toBe(whole.length);
			// A small new part of a long file comes back alone, from the cursor.
			await workspace.use({ name: 'alpha' }, (env) =>
				env.writeFile(details.process.output, `${whole}extra\n`, BACKGROUND_CONTEXT),
			);
			const next = await call(workspace, 'status', { handle: details.process.handle });
			expect(next.text.startsWith('extra\n\n[Process')).toBe(true);
			expect(next.details.read).toEqual({ from: whole.length, to: whole.length + 6 });
		},
	);

	it.each([
		[
			'a code other than 0',
			{ command: 'echo partial; exit 3' },
			'exited with code 3',
			'partial',
			'(no new output)',
		],
		[
			'a timeout',
			{ command: 'sleep 5', timeout: 0.1 },
			'timed out after 0.1 seconds',
			'(no output)',
			'(no output)',
		],
		[
			'a syntax error the shell writes before the redirect',
			{ command: 'echo "unterminated' },
			'exited with code 2',
			'unexpected EOF',
			'(no new output)',
		],
	])(
		'fails the call on %s with the output, and status reports the same process',
		async (_case, params, state, output, after) => {
			const workspace = site();
			const error = await failure(() => toolOf(workspace, 'bash').invoke(params, callAs('alpha')));
			expect(error).toContain(output);
			const handle = HANDLE.exec(error)?.[0] ?? 'none';
			const status = await call(workspace, 'status', { handle });
			expect(status.text).toContain(`Process ${handle} ${state}.`);
			expect(status.text.startsWith(`${after}\n\n[Process`)).toBe(true);
		},
	);

	it.each([
		['bash', { command: 'true', timeout: 0 }],
		['bash', { command: 'true', wait: -1 }],
		['wait', { handle: 'bash-000000000000', timeout: 601 }],
		['bash', { command: 'true', name: 'Not A Name' }],
	])('refuses an invalid number of seconds or an invalid name in %s', async (tool, params) => {
		const workspace = site();
		await expect(
			Promise.resolve().then(() => toolOf(workspace, tool).invoke(params, callAs('alpha'))),
		).rejects.toThrow(/Invalid/);
	});
});

describe('status, wait and cancel', () => {
	it('cancels a running process, and a second cancel gives the same final state', async () => {
		const workspace = site();
		const { details } = await call(workspace, 'bash', { command: 'sleep 30', wait: 0 });
		const { handle } = details.process;
		const cancelled = await call(workspace, 'cancel', { handle });
		expect(cancelled.details.process.state).toBe('cancelled');
		expect(cancelled.text).toContain(`Process ${handle} is cancelled.`);
		expect((await call(workspace, 'cancel', { handle })).details.process).toEqual(
			cancelled.details.process,
		);
	});

	it("finds a handle of the calling agent alone, and names no other agent's process", async () => {
		const workspace = site();
		const { details } = await call(workspace, 'bash', { command: 'true' });
		const handle = details.process.handle;
		for (const tool of ['status', 'wait', 'cancel']) {
			await expect(invokeText(toolOf(workspace, tool), { handle }, callAs('beta'))).rejects.toThrow(
				`You have no process ${handle}.`,
			);
		}
	});
});

describe('the process table', () => {
	it(`keeps ${MAX_FINISHED_PROCESSES} finished processes for each agent, and removes the output file of a process it forgets`, async () => {
		const workspace = site();
		const first = (await call(workspace, 'bash', { command: 'echo first' })).details.process;
		// The files are the table, so the test writes the other finished processes as files.
		// Sixty-three more calls of bash took a loaded CI runner past the 20 s limit.
		await workspace.use({ name: 'alpha' }, async (env) => {
			const root = await processesDir(env);
			for (let i = 1; i < MAX_FINISHED_PROCESSES; i++) {
				const startedAt = new Date(Date.parse(first.startedAt) + i).toISOString();
				const handle = `bash-${i.toString(16).padStart(12, '0')}`;
				const spec = { handle, kind: 'bash' as const, agent: 'alpha', command: 'true' };
				await writeExit(env, await writeSpec(env, root, { ...spec, timeout: 600, startedAt }), 0);
			}
		});
		expect(await workspace.processes.list({ agent: 'alpha' })).toHaveLength(MAX_FINISHED_PROCESSES);
		expect((await call(workspace, 'status', { handle: first.handle })).details.process.state).toBe(
			'exited',
		);
		await call(workspace, 'bash', { command: 'true' });
		await expect(call(workspace, 'status', { handle: first.handle })).rejects.toThrow(
			'You have no process',
		);
		await expect(fileOf(workspace, 'alpha', first.output)).rejects.toThrow();
	});

	it(`refuses a process past ${MAX_RUNNING_PROCESSES} running processes of one agent, and dispose stops each running process`, async () => {
		const workspace = openWorkspace({ name: 'processes-cap', backend: { bash: memoryBackend() } });
		const handles: string[] = [];
		for (let i = 0; i < MAX_RUNNING_PROCESSES; i++) {
			handles.push(
				(await call(workspace, 'bash', { command: 'sleep 30', wait: 0 })).details.process.handle,
			);
		}
		await expect(call(workspace, 'bash', { command: 'true', wait: 0 })).rejects.toThrow(
			`You have ${MAX_RUNNING_PROCESSES} processes running.`,
		);
		expect((await call(workspace, 'bash', { command: 'true' }, 'beta')).details.process.state).toBe(
			'exited',
		);
		const started = Date.now();
		await workspace.dispose();
		expect(Date.now() - started).toBeLessThan(5000);
		await expect(call(workspace, 'status', { handle: handles[0] })).rejects.toThrow();
	});
});

describe('names', () => {
	it('shows the name beside the handle in the result and in the status', async () => {
		const workspace = site();
		const { text, details } = await call(workspace, 'bash', { command: 'true', name: 'tests' });
		expect(details.process.name).toBe('tests');
		expect(text).toContain(`[Process ${details.process.handle} (tests) exited with code 0.`);
	});
});

describe('ps', () => {
	it("lists the caller's own running processes alone", async () => {
		const workspace = site();
		await call(workspace, 'bash', { command: 'sleep 30', name: 'tests', wait: 0 });
		await call(workspace, 'bash', { command: 'true' });
		await call(workspace, 'bash', { command: 'sleep 30 # token=secret', wait: 0 }, 'beta');
		const listed = async (agent: string) => {
			const { text, details } = await call(workspace, 'ps', {}, agent);
			return { text, count: (details as unknown as PsDetails).processes.length };
		};
		const own = await listed('alpha');
		expect(own.count).toBe(1);
		expect(own.text).toMatch(/\| bash-[0-9a-f]{12} \| tests \| \d+s \| sleep 30 \|/);
		expect(own.text).not.toContain('token=secret');
		expect(own.text.endsWith('\n\n1 running process.')).toBe(true);
		expect((await listed('beta')).text).toContain('token=secret');
		expect((await listed('gamma')).text).toBe('No running processes.');
	});
});

describe('the host view', () => {
	it('lists every process, gives a start and an end event, and cancels the process of any agent', async () => {
		const workspace = site();
		const events: string[] = [];
		workspace.processes.subscribe(() => {
			throw new Error('A listener of the host broke.');
		});
		const unsubscribe = workspace.processes.subscribe((event) =>
			events.push(`${event.type} ${event.process.handle}`),
		);
		const { handle } = (await call(workspace, 'bash', { command: 'sleep 30', wait: 0 })).details
			.process;
		const running = await workspace.processes.list({ running: true });
		expect(running.map((one) => one.handle)).toEqual([handle]);
		// beta has not used the workspace in this run, so the host's list holds none of its processes.
		expect(await workspace.processes.list({ agent: 'beta' })).toEqual([]);
		expect((await workspace.processes.cancel(handle)).state).toBe('cancelled');
		expect(events).toEqual([`started ${handle}`, `ended ${handle}`]);
		unsubscribe();
		await call(workspace, 'bash', { command: 'true' });
		expect(events).toHaveLength(2);
		await expect(workspace.processes.cancel('bash-000000000000')).rejects.toThrow(
			'The workspace has no process bash-000000000000.',
		);
	});
});

describe('the reminder', () => {
	const seat = (activation: string) => ({ agent: 'alpha', room: 'lobby', activation });
	const live = () => new AbortController().signal;

	it('names running and unseen finished processes once, and drops a process a result showed', async () => {
		const workspace = site();
		const remind = workspace.tools().remind;
		if (remind === undefined) throw new Error('The workspace bundle must remind.');
		expect(await remind(seat('a1'), live())).toBeUndefined();
		const tests = await call(
			workspace,
			'bash',
			{ command: 'sleep 30', name: 'tests', wait: 0 },
			'alpha',
			'lobby',
		);
		const other = await call(
			workspace,
			'bash',
			{ command: 'sleep 30', wait: 0 },
			'alpha',
			'review',
		);
		const failed = await endedUnseen(workspace, 'sleep 0.05; exit 3');
		const shown = await failedHandle(() =>
			toolOf(workspace, 'bash').invoke({ command: 'exit 4' }, callAs('alpha')),
		);
		// A reminder that passes its bound while it waits on a busy owner marks nothing seen.
		const gate = Promise.withResolvers<void>();
		const busy = workspace.use({ name: 'alpha' }, () => gate.promise);
		const bound = new AbortController();
		const late = Promise.resolve(remind(seat('a1b'), bound.signal)).catch(() => undefined);
		bound.abort();
		gate.resolve();
		await Promise.all([busy, late]);
		const text = (await remind(seat('a2'), live())) ?? '';
		expect(text.split('\n')).toEqual([
			'Your background processes in the workspace:',
			expect.stringMatching(
				new RegExp(`^- tests, ${tests.details.process.handle}, is running for \\d+s: sleep 30$`),
			),
			expect.stringMatching(
				new RegExp(
					`^- ${other.details.process.handle} is running for \\d+s in the room review: sleep 30$`,
				),
			),
			expect.stringMatching(
				new RegExp(
					`^- ${failed} exited with code 3 at \\d\\d:\\d\\d:\\d\\d UTC: sleep 0.05; exit 3$`,
				),
			),
			'Call status, wait or cancel with a handle. Call ps to list processes.',
		]);
		expect(text).not.toContain(shown);
		// The reminder wrote seen for the finished process, so the next one names the running ones alone.
		const next = (await remind({ ...seat('a3'), room: 'review' }, live())) ?? '';
		expect(next).not.toContain(failed);
		expect(next).toContain(`${tests.details.process.handle}, is running for`);
		expect(next).toContain('in the room lobby');
		expect(await remind({ ...seat('a4'), agent: 'beta' }, live())).toBeUndefined();
	});

	it(`names the newest ${FINISHED_IN_REMINDER} unseen finished processes, and counts the rest`, async () => {
		const workspace = site();
		const handles: string[] = [];
		for (let i = 0; i < FINISHED_IN_REMINDER + 2; i++)
			handles.push(await endedUnseen(workspace, 'sleep 0.05'));
		const lines = ((await workspace.tools().remind?.(seat('a1'), live())) ?? '').split('\n');
		expect(lines).toHaveLength(FINISHED_IN_REMINDER + 3);
		expect(lines[1]).toContain(handles[2]);
		expect(lines.at(-2)).toBe('- and 2 more finished processes');
	});
});

describe('a process on a backend that misbehaves', () => {
	it('ends a process whose own environment throws on cleanup, and keeps the table usable', async () => {
		const workspace = openWorkspace({
			name: 'processes-cleanup',
			backend: {
				bash: wrapped((inner) => ({
					connect: async (agent, signal) => {
						const env = await inner.connect(agent, signal);
						const exec = env.exec.bind(env);
						let ran = false;
						// Only the environment of a process runs the wrapper, which starts with its pid.
						env.exec = (...args) => {
							if (args[0].startsWith('echo "$$"')) ran = true;
							return exec(...args);
						};
						env.cleanup = async () => {
							if (ran) throw new Error('The cleanup broke.');
						};
						return env;
					},
				})),
			},
		});
		onTestFinished(() => workspace.dispose());
		for (const text of ['one', 'two']) {
			const { details } = await call(workspace, 'bash', { command: `echo ${text}` });
			expect(details.process).toMatchObject({ state: 'exited', exitCode: 0 });
		}
		expect(await workspace.processes.list({ running: true })).toEqual([]);
	});
});

describe('a wait near the end of the activation', () => {
	it('stops the wait of bash and of wait before the deadline, and says why', async () => {
		const workspace = site();
		// 32 s are left: the wait stops 30 s before the deadline, so bash waits about 2 s of its 10.
		const near = callAs('alpha', { deadline: Date.now() + 32_000 });
		const started = Date.now();
		const run = await toolOf(workspace, 'bash').invoke({ command: 'sleep 30' }, near);
		if (typeof run === 'string') throw new Error('A process tool gives a structured result.');
		const handle = (run.details as ProcessDetails).process.handle;
		const text = run.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		expect(Date.now() - started).toBeLessThan(8_000);
		expect(text).toMatch(
			/is running\..*The wait stopped early, because your activation ends in \d+ seconds\./s,
		);
		// Less than the margin is left: wait returns at once.
		const late = callAs('alpha', { deadline: Date.now() + 10_000 });
		const before = Date.now();
		const waited = await invokeText(toolOf(workspace, 'wait'), { handle, timeout: 60 }, late);
		expect(Date.now() - before).toBeLessThan(2_000);
		// The note rounds the time left, and a loaded runner can take a second.
		expect(waited).toMatch(
			/The wait stopped early, because your activation ends in (9|10) seconds\. Answer before then\./,
		);
	});
});

describe('an aborted wait', () => {
	it('rejects the call, and the process keeps running', async () => {
		const workspace = site();
		const { handle } = (await call(workspace, 'bash', { command: 'sleep 30', wait: 0 })).details
			.process;
		const controller = new AbortController();
		const waiting = Promise.resolve(
			toolOf(workspace, 'wait').invoke(
				{ handle, timeout: 30 },
				callAs('alpha', { signal: controller.signal }),
			),
		);
		controller.abort(new Error('The activation ended.'));
		await expect(waiting).rejects.toThrow('The activation ended.');
		const running = await workspace.processes.list({ running: true });
		expect(running.map((one) => one.handle)).toEqual([handle]);
	});
});

describe('the files as the source of truth', () => {
	const EXIT = '0 2026-01-01T00:01:00Z';
	const STOP = 'cancelled 2026-01-01T00:00:30.000Z';
	it.each([
		{ files: { exit: EXIT }, live: false, state: 'exited' },
		{ files: { exit: EXIT, stop: STOP }, live: false, state: 'exited' },
		{ files: { exit: EXIT, stop: STOP }, live: true, state: 'exited' },
		{ files: { stop: STOP }, live: true, state: 'running' },
		{
			files: { stop: 'failed 2026-01-01T00:00:30.000Z The run broke.' },
			live: false,
			state: 'failed',
		},
		{ files: {}, live: true, state: 'running' },
		{ files: {}, live: false, state: 'failed' },
	])('reads $state from the files $files, with a live shell: $live', ({ files, live, state }) => {
		const spec = {
			handle: 'bash-00000000000b',
			kind: 'bash' as const,
			agent: 'alpha',
			command: 'true',
			timeout: 600,
			startedAt: '2026-01-01T00:00:00.000Z',
		};
		const read: ProcessFiles = { dir: '/p', spec, seen: false, alive: live, ...files };
		expect(statusOf(read, false).state).toBe(state);
	});

	it('reads the table of a new workspace over the same directory: a finished process, and one that no run owns', async () => {
		const { dir, dispose } = await tempDir('ambion-processes-');
		onTestFinished(dispose);
		const first = openWorkspace({ name: 'files-one', backend: { bash: directoryBackend(dir) } });
		// A colon and a backslash in the command stay whole through the line-oriented listing.
		const command = 'echo kept # a: b\\c';
		const done = (await call(first, 'bash', { command, name: 'build' })).details.process;
		await first.dispose();
		// A spec with no end and no live shell: the run that owned it ended before it did.
		const lost = 'bash-00000000000a';
		const home = join(dir, 'home', 'alpha', '.processes', lost);
		await mkdir(home, { recursive: true });
		const spec = { handle: lost, kind: 'bash', agent: 'alpha', command: 'sleep 99' };
		await writeFile(
			join(home, 'spec'),
			JSON.stringify({ ...spec, timeout: 600, startedAt: '2026-01-01T00:00:00.000Z' }),
		);
		const second = openWorkspace({ name: 'files-two', backend: { bash: directoryBackend(dir) } });
		const live = new AbortController().signal;
		onTestFinished(() => second.dispose());
		const status = await call(second, 'status', { handle: done.handle });
		expect(status.details.process).toMatchObject({
			state: 'exited',
			exitCode: 0,
			name: 'build',
			command,
		});
		// The cursor lives in the files, so the new run gives no output that bash showed.
		expect(status.text.startsWith('(no new output)\n\n[Process')).toBe(true);
		// A stop that meets the end of the command writes no stop, and the end stays exited.
		const doneDir = done.output.slice(0, done.output.lastIndexOf('/'));
		await second.use({ name: 'alpha' }, (env) => writeStop(env, doneDir, stopLine('cancelled')));
		expect((await call(second, 'status', { handle: done.handle })).details.process.state).toBe(
			'exited',
		);
		await expect(fileOf(second, 'alpha', `${doneDir}/stop`)).rejects.toThrow();
		const reminded =
			(await second.tools().remind?.({ agent: 'alpha', room: 'r', activation: 'a1' }, live)) ?? '';
		expect(reminded).toContain(`- ${lost} failed: sleep 99`);
		expect(reminded).not.toContain(done.handle);
		expect(
			await second.tools().remind?.({ agent: 'alpha', room: 'r', activation: 'a2' }, live),
		).toBeUndefined();
		const lostStatus = await call(second, 'status', { handle: lost });
		expect(lostStatus.details.process).toMatchObject({ state: 'failed', error: LOST });
		// The host's cancel finds the owner from the files, and gives the final state again.
		expect(await second.processes.cancel(lost)).toMatchObject({ state: 'failed', error: LOST });
		expect((await call(second, 'ps', {})).text).toBe('No running processes.');
	});
});
