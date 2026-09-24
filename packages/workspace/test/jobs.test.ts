import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import type { JobDetails } from '../src/job-tools.ts';
import { MAX_FINISHED_JOBS, MAX_RUNNING_JOBS } from '../src/jobs.ts';
import { openWorkspace, type Workspace } from '../src/workspace.ts';
import { callAs, invokeText, toolOf } from './support/backends.ts';

let serial = 0;

function site(): Workspace {
	serial += 1;
	const workspace = openWorkspace({ name: `jobs-${serial}`, backend: { bash: memoryBackend() } });
	onTestFinished(() => workspace.dispose());
	return workspace;
}

const HANDLE = /bash-[0-9a-f]{12}/;

/** Invoke `tool` as `agent`, and return its text and its job details. */
async function call(
	workspace: Workspace,
	tool: string,
	params: unknown,
	agent = 'alpha',
): Promise<{ text: string; details: JobDetails }> {
	const result = await toolOf(workspace, tool).invoke(params, callAs(agent));
	if (typeof result === 'string') throw new Error('A job tool gives a structured result.');
	const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	return { text, details: result.details as JobDetails };
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

async function fileOf(workspace: Workspace, agent: string, path: string): Promise<string> {
	return workspace.use({ name: agent }, async (env) => {
		const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
		if (!read.ok) throw read.error;
		return read.value;
	});
}

describe('bash', () => {
	it('runs a short command as a job that ends in the call, with its output inline and in the output file', async () => {
		const workspace = site();
		const { text, details } = await call(workspace, 'bash', { command: 'echo out; echo err >&2' });
		const { handle, output } = details.job;
		expect(details.job).toMatchObject({ kind: 'bash', state: 'exited', exitCode: 0 });
		expect(output).toBe(`/home/alpha/.jobs/${handle}.out`);
		expect(text).toBe(`out\nerr\n\n[Job ${handle} exited with code 0. Output: ${output}.]`);
		expect(await fileOf(workspace, 'alpha', output)).toBe('out\nerr\n');
	});

	it('returns a running job at once with wait 0, and status, wait and the output file reach it', async () => {
		const workspace = site();
		const started = await call(workspace, 'bash', {
			command: 'sleep 0.3; echo done',
			wait: 0,
		});
		const { handle } = started.details.job;
		expect(started.details.job.state).toBe('running');
		expect(started.text).toContain(`Job ${handle} is running.`);
		expect(started.text).toContain('Call status, wait or cancel with its handle.');
		expect((await call(workspace, 'status', { handle })).details.job.state).toBe('running');
		// A running job holds no operation of the bash owner.
		expect(await workspace.use({ name: 'alpha' }, () => 'free')).toBe('free');
		const waited = await call(workspace, 'wait', { handle, timeout: 5 });
		expect(waited.details.job).toMatchObject({ state: 'exited', exitCode: 0 });
		expect(waited.text.startsWith('done\n\n[Job')).toBe(true);
		expect((await call(workspace, 'status', { handle })).text).toBe(waited.text);
	});

	it('gives the running state when wait ends before the job', async () => {
		const workspace = site();
		const { details } = await call(workspace, 'bash', { command: 'sleep 5', wait: 0 });
		const waited = await call(workspace, 'wait', { handle: details.job.handle, timeout: 0.05 });
		expect(waited.details.job.state).toBe('running');
	});

	it('shows the end of a long output and keeps the whole output in the file', async () => {
		const workspace = site();
		const { text, details } = await call(workspace, 'bash', { command: 'seq 1 5000' });
		expect(details.truncation).toMatchObject({ truncated: true, outputLines: 2000 });
		expect(text.startsWith('3001\n')).toBe(true);
		expect(text).toContain('5000\n\n[Job');
		expect(text).toContain('The text above is the last 2000 lines');
		const whole = await fileOf(workspace, 'alpha', details.job.output);
		expect(whole.split('\n').length).toBe(5001);
	});

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
		'fails the call on %s, and status reports the same job',
		async (_case, params, state, output) => {
			const workspace = site();
			const handle = await failedHandle(() =>
				toolOf(workspace, 'bash').invoke(params, callAs('alpha')),
			);
			const status = await call(workspace, 'status', { handle });
			expect(status.text).toContain(`Job ${handle} ${state}.`);
			expect(status.text).toContain(output);
		},
	);

	it.each([
		['bash', { command: 'true', timeout: 0 }],
		['bash', { command: 'true', wait: -1 }],
		['wait', { handle: 'bash-000000000000', timeout: 601 }],
	])('refuses an invalid number of seconds in %s', async (tool, params) => {
		const workspace = site();
		await expect(toolOf(workspace, tool).invoke(params, callAs('alpha'))).rejects.toThrow(
			/Invalid/,
		);
	});
});

describe('status, wait and cancel', () => {
	it('cancels a running job, and a second cancel gives the same final state', async () => {
		const workspace = site();
		const { details } = await call(workspace, 'bash', { command: 'sleep 30', wait: 0 });
		const { handle } = details.job;
		const cancelled = await call(workspace, 'cancel', { handle });
		expect(cancelled.details.job.state).toBe('cancelled');
		expect(cancelled.text).toContain(`Job ${handle} is cancelled.`);
		expect((await call(workspace, 'cancel', { handle })).details.job).toEqual(
			cancelled.details.job,
		);
	});

	it("finds a handle of the calling agent alone, and names no other agent's job", async () => {
		const workspace = site();
		const { details } = await call(workspace, 'bash', { command: 'true' });
		const handle = details.job.handle;
		for (const tool of ['status', 'wait', 'cancel']) {
			await expect(invokeText(toolOf(workspace, tool), { handle }, callAs('beta'))).rejects.toThrow(
				`You have no job ${handle}.`,
			);
		}
	});
});

describe('the job table', () => {
	it(`keeps ${MAX_FINISHED_JOBS} finished jobs for each agent, and removes the output file of a job it forgets`, async () => {
		const workspace = site();
		const first = (await call(workspace, 'bash', { command: 'echo first' })).details.job;
		for (let i = 1; i < MAX_FINISHED_JOBS; i++) await call(workspace, 'bash', { command: 'true' });
		expect((await call(workspace, 'status', { handle: first.handle })).details.job.state).toBe(
			'exited',
		);
		await call(workspace, 'bash', { command: 'true' });
		await expect(call(workspace, 'status', { handle: first.handle })).rejects.toThrow(
			'You have no job',
		);
		await expect(fileOf(workspace, 'alpha', first.output)).rejects.toThrow();
	});

	it(`refuses a job past ${MAX_RUNNING_JOBS} running jobs of one agent, and dispose stops each running job`, async () => {
		const workspace = openWorkspace({ name: 'jobs-cap', backend: { bash: memoryBackend() } });
		const handles: string[] = [];
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) {
			handles.push(
				(await call(workspace, 'bash', { command: 'sleep 30', wait: 0 })).details.job.handle,
			);
		}
		await expect(call(workspace, 'bash', { command: 'true', wait: 0 })).rejects.toThrow(
			`You have ${MAX_RUNNING_JOBS} jobs running.`,
		);
		expect((await call(workspace, 'bash', { command: 'true' }, 'beta')).details.job.state).toBe(
			'exited',
		);
		const started = Date.now();
		await workspace.dispose();
		expect(Date.now() - started).toBeLessThan(5000);
		await expect(call(workspace, 'status', { handle: handles[0] })).rejects.toThrow();
	});
});
