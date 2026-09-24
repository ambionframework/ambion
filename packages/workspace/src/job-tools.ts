/**
 * The `bash`, `status`, `wait` and `cancel` tools over the job table.
 *
 * `bash` starts every command as a background job and returns its handle.
 * The call waits up to `wait` seconds for the job to end. A job that ends
 * in that time gives its exit code and its output in the same result. A job
 * that runs longer gives its handle, and the agent reaches it again through
 * `status`, `wait` and `cancel`. The whole output of a job goes to a file
 * in the agent's home, which `read` reaches.
 *
 * `bash` starts its job as one operation on the bash owner, so a job
 * starts after every earlier operation of the owner. The job then runs off
 * the owner. Each tool reads the end of the output file as one more
 * operation on the bash owner. No tool holds the owner while it waits for
 * a job. The audit entry of a call runs on the bash owner after the call
 * ends. `docs/processes.md` states the texts.
 */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import {
	type AgentToolResult,
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ShellOutputTruncation,
	type ShellOutputView,
	truncateTail,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import { JOBS_DIR, type JobStatus, type JobTable, quoted } from './jobs.ts';
import type { WorkspaceResource } from './resource.ts';
import { recordedOnShell } from './tools.ts';

/** Seconds a job may run when `bash` names no timeout. */
const DEFAULT_JOB_TIMEOUT_SECONDS = 600;

/** Seconds a `bash` call waits for its job when it names no `wait`. */
const DEFAULT_BASH_WAIT_SECONDS = 10;

/** Seconds a `wait` call waits when it names no timeout. */
const DEFAULT_WAIT_SECONDS = 30;

/** The longest one call waits for a job. A longer wait holds the activation open. */
const MAX_WAIT_SECONDS = 600;

/** The largest timeout a Node timer holds, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** An output file up to this size is read whole. A larger one is read with `tail`. */
const WHOLE_READ_BYTES = 4 * DEFAULT_MAX_BYTES;

/** The tool names, in the order the tool line of the guidance lists them. */
export const JOB_TOOL_NAMES = ['bash', 'status', 'wait', 'cancel'] as const;

/** What the job tools need from the workspace: the bash owner, the job table, and the audit log. */
export interface JobToolOptions {
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly jobs: JobTable;
	readonly audit?: AuditLog;
}

/** Guidance for the job tools. */
export function jobToolGuidance(): string {
	return [
		`bash starts each command as a background job and returns its handle, such as bash-1a2b3c4d5e6f.`,
		`The call waits up to wait seconds, ${DEFAULT_BASH_WAIT_SECONDS} by default, and then gives the state of the job and the end of its output.`,
		`The whole output of a job goes to ${JOBS_DIR}/<handle>.out. Read it with read.`,
		`status, wait and cancel take a handle. status gives the state of the job, wait waits for it to end,`,
		`and cancel stops it. A job stops after timeout seconds, ${DEFAULT_JOB_TIMEOUT_SECONDS} by default.`,
	].join('\n');
}

const handle = Type.String({
	description: 'The handle that bash returned, such as bash-1a2b3c4d5e6f.',
});

const bashSchema = Type.Object({
	command: Type.String({ description: 'The bash command to run.' }),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds the job may run. The workspace then stops it. The default is ${DEFAULT_JOB_TIMEOUT_SECONDS}.`,
		}),
	),
	wait: Type.Optional(
		Type.Number({
			description: `Seconds this call waits for the job to end before it returns. The default is ${DEFAULT_BASH_WAIT_SECONDS}. Set 0 to return at once.`,
		}),
	),
});

const handleSchema = Type.Object({ handle });

const waitSchema = Type.Object({
	handle,
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds to wait for the job to end. The default is ${DEFAULT_WAIT_SECONDS}.`,
		}),
	),
});

type BashParams = Static<typeof bashSchema>;
type HandleParams = Static<typeof handleSchema>;
type WaitParams = Static<typeof waitSchema>;

/** What a job tool gives in `details`. */
export interface JobDetails {
	job: JobStatus;
	truncation?: ShellOutputTruncation;
}

/** Build the `bash`, `status`, `wait` and `cancel` tools over the job table. */
export function createJobTools(options: JobToolOptions): readonly AmbionTool[] {
	const recorded = <P>(
		name: string,
		execute: (params: P, ctx: ToolContext) => Promise<AgentToolResult<JobDetails>>,
	) => recordedOnShell(name, options.shell, options.audit, execute);
	const bash = defineTool({
		name: 'bash',
		label: 'bash',
		description: `Start a bash command as a background job in your home directory, and return its handle. The call waits up to wait seconds for the job to end, and gives its state and the end of its combined stdout and stderr. The whole output goes to ${JOBS_DIR}/<handle>.out.`,
		parameters: bashSchema,
		execute: recorded('bash', (params: BashParams, ctx) => started(options, params, ctx)),
	});
	const status = defineTool({
		name: 'status',
		label: 'Job status',
		description: 'Give the state of a job and the end of its output.',
		parameters: handleSchema,
		execute: recorded('status', async (params: HandleParams, ctx) =>
			described(options, options.jobs.status(ctx.agent, params.handle), ctx),
		),
	});
	const wait = defineTool({
		name: 'wait',
		label: 'Wait for a job',
		description:
			'Wait for a job to end, up to timeout seconds. Give its state and the end of its output. The job keeps running when the time ends first.',
		parameters: waitSchema,
		execute: recorded('wait', async (params: WaitParams, ctx) => {
			const seconds = checkedSeconds(params.timeout, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
			const job = await options.jobs.wait(ctx.agent, params.handle, seconds, ctx.signal);
			return described(options, job, ctx);
		}),
	});
	const cancel = defineTool({
		name: 'cancel',
		label: 'Cancel a job',
		description: 'Stop a running job, and give its state and the end of its output.',
		parameters: handleSchema,
		execute: recorded('cancel', async (params: HandleParams, ctx) =>
			described(options, await options.jobs.cancel(ctx.agent, params.handle), ctx),
		),
	});
	return Object.freeze([bash, status, wait, cancel]);
}

/** A number of seconds from 0 to `max`, or `fallback` when the caller names none. */
function checkedSeconds(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0 || value > max) {
		throw new Error(`Invalid number of seconds: give a number from 0 to ${max}.`);
	}
	return value;
}

/**
 * Start the job, wait up to `wait` seconds, and describe it. A job that
 * ended in that time with a code other than 0, with a timeout, or with a
 * failure makes the call fail with the same text.
 */
async function started(
	options: JobToolOptions,
	params: BashParams,
	ctx: ToolContext,
): Promise<AgentToolResult<JobDetails>> {
	const timeout = checkedSeconds(params.timeout, DEFAULT_JOB_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
	if (timeout === 0) throw new Error('Invalid timeout: give a number of seconds above 0.');
	const wait = checkedSeconds(params.wait, DEFAULT_BASH_WAIT_SECONDS, MAX_WAIT_SECONDS);
	const job = await options.shell(
		ctx.agent,
		(env) => options.jobs.start(ctx.agent, env, { command: params.command, timeout }),
		ctx.signal,
	);
	const ended = await options.jobs.wait(ctx.agent, job.handle, wait, ctx.signal);
	const result = await described(options, ended, ctx);
	if (unsuccessful(ended)) throw new Error(textOf(result));
	return result;
}

function unsuccessful(job: JobStatus): boolean {
	return (
		job.state === 'timed_out' ||
		job.state === 'failed' ||
		(job.state === 'exited' && job.exitCode !== 0)
	);
}

function textOf(result: AgentToolResult<JobDetails>): string {
	return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The end of the job's output, and the line that states the job. */
async function described(
	options: JobToolOptions,
	job: JobStatus,
	ctx: ToolContext,
): Promise<AgentToolResult<JobDetails>> {
	const tail = await options.shell(ctx.agent, (env) => outputTail(env, job.output), ctx.signal);
	const output = tail.text.endsWith('\n') ? tail.text.slice(0, -1) : tail.text;
	const body = output === '' && job.state !== 'running' ? '(no output)' : output;
	const notes = [stateLine(job), truncationLine(tail.truncation)].filter((note) => note !== '');
	const text = [body, `[${notes.join(' ')}]`].filter((part) => part !== '').join('\n\n');
	const details: JobDetails = tail.truncation.truncated
		? { job, truncation: tail.truncation }
		: { job };
	return { content: [{ type: 'text', text }], details };
}

/** One sentence for the job's state, with its handle and its output file. */
function stateLine(job: JobStatus): string {
	const where = `Output: ${job.output}.`;
	switch (job.state) {
		case 'running':
			return `Job ${job.handle} is running. ${where} Call status, wait or cancel with its handle.`;
		case 'exited':
			return `Job ${job.handle} exited with code ${job.exitCode}. ${where}`;
		case 'timed_out':
			return `Job ${job.handle} timed out after ${job.timeout} seconds. ${where}`;
		case 'cancelled':
			return `Job ${job.handle} is cancelled. ${where}`;
		case 'failed':
			return `Job ${job.handle} failed: ${job.error}. ${where}`;
	}
}

function truncationLine(truncation: ShellOutputTruncation): string {
	if (!truncation.truncated) return '';
	return `The text above is the last ${truncation.outputLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}.`;
}

/**
 * The end of an output file, bounded to Pi's default view: 2000 lines or
 * 50 KB. A file that does not exist yet reads as empty. A file over four
 * times the byte limit is read with `tail`, so a large output does not
 * reach the host whole.
 */
async function outputTail(
	env: WorkspaceEnv,
	path: string,
): Promise<{ text: string; truncation: ShellOutputTruncation }> {
	const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
	const size = info.ok ? info.value.size : 0;
	const text = size > WHOLE_READ_BYTES ? await tailOf(env, path) : await wholeOf(env, path);
	const { content, ...truncation } = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return {
		text: content,
		truncation: {
			...truncation,
			truncated: truncation.truncated || size > WHOLE_READ_BYTES,
			totalBytes: Math.max(truncation.totalBytes, size),
		},
	};
}

async function wholeOf(env: WorkspaceEnv, path: string): Promise<string> {
	const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
	return read.ok ? read.value : '';
}

async function tailOf(env: WorkspaceEnv, path: string): Promise<string> {
	let view: ShellOutputView | undefined;
	await env.exec(
		`tail -c ${DEFAULT_MAX_BYTES} -- ${quoted(path)}`,
		{
			capture: { limits: { maxBytes: 2 * DEFAULT_MAX_BYTES, maxLines: 2 * DEFAULT_MAX_LINES } },
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		BACKGROUND_CONTEXT,
	);
	return view?.text ?? '';
}
