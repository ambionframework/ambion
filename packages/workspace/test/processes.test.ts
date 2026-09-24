import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
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
async function failedHandle(invoke: () => unknown): Promise<string> {
	const error = await Promise.resolve()
		.then(invoke)
		.then(
			() => {
				throw new Error('The call must fail.');
			},
			(reason: unknown) => reason,
		);
	const handle = HANDLE.exec(String(error))?.[0];
	if (handle === undefined) throw new Error(`No handle in ${String(error)}`);
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
	if (workspace.processes.list({ running: true }).every((one) => one.handle !== handle)) {
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
		expect(output).toBe(`/home/alpha/.processes/${handle}.out`);
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
		expect((await call(workspace, 'status', { handle })).text).toBe(waited.text);
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
		},
	);

	it.each([
		['a code other than 0', { command: 'echo partial; exit 3' }, 'exited with code 3', 'partial'],
		[
			'a timeout',
			{ command: 'sleep 5', timeout: 0.1 },
			'timed out after 0.1 seconds',
			'(no output)',
		],
		[
			'a syntax error the shell writes before the redirect',
			{ command: 'echo "unterminated' },
			'exited with code 2',
			'unexpected EOF',
		],
	])(
		'fails the call on %s, and status reports the same process',
		async (_case, params, state, output) => {
			const workspace = site();
			const handle = await failedHandle(() =>
				toolOf(workspace, 'bash').invoke(params, callAs('alpha')),
			);
			const status = await call(workspace, 'status', { handle });
			expect(status.text).toContain(`Process ${handle} ${state}.`);
			expect(status.text).toContain(output);
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
		for (let i = 1; i < MAX_FINISHED_PROCESSES; i++)
			await call(workspace, 'bash', { command: 'true' });
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
	it("lists the caller's running processes, one agent's, or every agent's, and hides another agent's command", async () => {
		const workspace = site();
		await call(workspace, 'bash', { command: 'sleep 30', name: 'tests', wait: 0 });
		await call(workspace, 'bash', { command: 'true' });
		await call(workspace, 'bash', { command: 'sleep 30 # token=secret', wait: 0 }, 'beta');
		const count = async (params: object, agent = 'alpha') => {
			const { text, details } = await call(workspace, 'ps', params, agent);
			return { text, count: (details as unknown as PsDetails).processes.length };
		};
		const own = await count({});
		expect(own.count).toBe(1);
		expect(own.text).toMatch(/\| bash-[0-9a-f]{12} \| tests \| alpha \| \d+s \| sleep 30 \|/);
		expect(own.text.endsWith('\n\n1 running process.')).toBe(true);
		const all = await count({ all: true });
		expect(all.count).toBe(2);
		expect(all.text).not.toContain('token=secret');
		expect((await count({ agent: 'beta' })).text).not.toContain('token=secret');
		expect((await count({}, 'beta')).text).toContain('token=secret');
		expect((await count({ agent: 'gamma' })).text).toBe('gamma has no running processes.');
		expect((await count({}, 'gamma')).text).toBe('No running processes.');
		await expect(count({ agent: 'beta', all: true })).rejects.toThrow('Invalid');
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
		expect(workspace.processes.list({ running: true }).map((one) => one.handle)).toEqual([handle]);
		expect(workspace.processes.list({ agent: 'beta' })).toEqual([]);
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

	it('names running and unseen finished processes, gives one activation one text, and drops a process a result showed', async () => {
		const workspace = site();
		const remind = workspace.tools().remind;
		if (remind === undefined) throw new Error('The workspace bundle must remind.');
		expect(remind(seat('a1'))).toBeUndefined();
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
		const text = remind(seat('a2')) ?? '';
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
		expect(remind(seat('a2'))).toBe(text);
		// An activation id names no room, so the same id in another room gets its own text.
		expect(remind({ ...seat('a2'), room: 'review' })).toContain(
			`${tests.details.process.handle}, is running for`,
		);
		expect(remind({ ...seat('a2'), room: 'review' })).toContain('in the room lobby');
		expect(remind(seat('a3'))).not.toContain(failed);
		expect(remind({ ...seat('a4'), agent: 'beta' })).toBeUndefined();
	});

	it(`names the newest ${FINISHED_IN_REMINDER} unseen finished processes, and counts the rest`, async () => {
		const workspace = site();
		const handles: string[] = [];
		for (let i = 0; i < FINISHED_IN_REMINDER + 2; i++)
			handles.push(await endedUnseen(workspace, 'sleep 0.05'));
		const lines = workspace.tools().remind?.(seat('a1'))?.split('\n') ?? [];
		expect(lines).toHaveLength(FINISHED_IN_REMINDER + 3);
		expect(lines[1]).toContain(handles[2]);
		expect(lines.at(-2)).toBe('- and 2 more finished processes');
	});
});

describe('a process on a backend that misbehaves', () => {
	it('ends a process whose environment throws on cleanup, and keeps the table usable', async () => {
		const workspace = openWorkspace({
			name: 'processes-cleanup',
			backend: {
				bash: wrapped((inner) => ({
					connect: async (agent, signal) => {
						const env = await inner.connect(agent, signal);
						const exec = env.exec.bind(env);
						let ran = false;
						env.exec = (...args) => {
							ran = true;
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
		expect(workspace.processes.list({ running: true })).toEqual([]);
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
		expect(workspace.processes.list({ running: true }).map((one) => one.handle)).toEqual([handle]);
	});
});
