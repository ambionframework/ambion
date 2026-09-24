/**
 * The job table: the background work of one workspace, by handle.
 *
 * `bash` starts every command as a job. A job runs on an environment of its
 * own, which the table connects outside the queue of the bash owner, so a
 * long command holds no other tool call of any agent. The command's output
 * goes to a file in the agent's home, `~/.jobs/<handle>.out`. The table
 * keeps the state of each job in the host's memory for the life of the
 * workspace. A handle names one job of one agent, and another agent's call
 * does not find it.
 *
 * A handle is `<kind>-<random>`. `bash` is the one kind today. The
 * `status`, `wait` and `cancel` tools read the kind from the table, so a
 * new kind of job adds a kind and a runner, and no new tool.
 *
 * `docs/processes.md` is the design contract.
 */

import {
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	type Context,
	type ExecutionError,
	type Result,
	type ShellExecResult,
	type ShellOutputView,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import { randomName } from './execution-env.ts';
import type { WorkspaceAgent } from './resource.ts';

/** The kinds of job. A handle starts with its kind. */
type JobKind = 'bash';

/** Where a job is in its life. Every state but `running` is final. */
type JobState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed';

/** What the table knows of one job. A caller gets a frozen copy. */
export interface JobStatus {
	readonly handle: string;
	readonly kind: JobKind;
	/** The command as the agent gave it. */
	readonly command: string;
	readonly state: JobState;
	/** The absolute path of the file that holds the job's whole output. */
	readonly output: string;
	/** Seconds the job may run before the table stops it. */
	readonly timeout: number;
	readonly startedAt: string;
	/** Set when the state is final. */
	readonly endedAt?: string;
	/** Set when the state is `exited`. */
	readonly exitCode?: number;
	/** Set when the state is `failed`. */
	readonly error?: string;
}

/** What `bash` asks the table to run. */
interface BashJobSpec {
	readonly command: string;
	readonly timeout: number;
}

/** The directory in each agent's home that holds the output of its jobs. */
export const JOBS_DIR = '~/.jobs';

/**
 * The most jobs one agent can have in the `running` state at one time. On
 * the workstation each running job holds one channel of the agent's SSH
 * client, and OpenSSH allows 10 by default (`docs/workstation.md`).
 */
export const MAX_RUNNING_JOBS = 4;

/** The most finished jobs the table keeps for one agent. It forgets the oldest first. */
export const MAX_FINISHED_JOBS = 64;

/** The longest `cancel` waits for a job to end after the abort. */
const CANCEL_GRACE_MS = 10_000;

const CLOSED = 'Workspace is no longer available.';

/** Connect one agent's environment outside the queue of the bash owner. */
export type JobConnect = (agent: WorkspaceAgent) => Promise<WorkspaceEnv>;

/** The background jobs of one workspace. */
export interface JobTable {
	/**
	 * Start a bash job for `agent`. `env` is the agent's environment on the
	 * bash owner, and the table uses it only to prepare the output file, and
	 * to remove the files of the finished jobs that it forgets. The job runs
	 * on an environment of its own.
	 */
	start(agent: WorkspaceAgent, env: WorkspaceEnv, spec: BashJobSpec): Promise<JobStatus>;
	/** The job's status. Throws when `agent` has no job with `handle`. */
	status(agent: WorkspaceAgent, handle: string): JobStatus;
	/**
	 * Wait up to `seconds` for the job to end, and return its status. The
	 * status is `running` when the time ends first. An abort of `signal`
	 * rejects, and the job keeps running.
	 */
	wait(
		agent: WorkspaceAgent,
		handle: string,
		seconds: number,
		signal?: AbortSignal,
	): Promise<JobStatus>;
	/** Stop the job, and return its status once it ends. A final job stays as it is. */
	cancel(agent: WorkspaceAgent, handle: string): Promise<JobStatus>;
	/** Refuse new jobs, stop every running job, and wait for each one to end. */
	close(): Promise<void>;
}

interface Job {
	readonly agent: string;
	status: JobStatus;
	readonly controller: AbortController;
	ended: Promise<void>;
}

/** Quote one word for `bash`. */
export function quoted(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command, with its standard input from `/dev/null` and its output and
 * errors to `output`. The command sits on lines of its own, so a comment or
 * a here-document at its end does not reach the closing brace.
 */
function redirected(command: string, output: string): string {
	return `{\n${command}\n} < /dev/null > ${quoted(output)} 2>&1`;
}

/** The most of the shell's own output that a job keeps: what it writes before the redirect applies. */
const SHELL_OUTPUT = { maxBytes: 16_384, maxLines: 200, retain: 'tail' } as const;

/** The final state that one run of `exec` gives. */
function ending(
	result: Result<ShellExecResult, ExecutionError>,
): Pick<JobStatus, 'state' | 'exitCode' | 'error'> {
	if (result.ok) return { state: 'exited', exitCode: result.value.exitCode };
	if (result.error.code === 'timeout') return { state: 'timed_out' };
	if (result.error.code === 'aborted') return { state: 'cancelled' };
	return { state: 'failed', error: result.error.message };
}

/**
 * Run one bash job on its own environment, and return its final state.
 * The shell itself can write before the redirect applies, for example a
 * syntax error. That output goes to the end of the output file. The
 * environment is cleaned up in every case.
 */
async function runBash(
	env: WorkspaceEnv,
	spec: BashJobSpec,
	output: string,
	signal: AbortSignal,
): Promise<Pick<JobStatus, 'state' | 'exitCode' | 'error'>> {
	let view: ShellOutputView | undefined;
	try {
		const result = await env.exec(
			redirected(spec.command, output),
			{
				timeout: spec.timeout,
				capture: { limits: SHELL_OUTPUT },
				onUpdate: (update) => {
					view = applyShellOutputUpdate(view, update);
				},
			},
			withAbortSignal(signal, BACKGROUND_CONTEXT),
		);
		if (view !== undefined && view.text !== '') {
			await env.appendFile(output, view.text, BACKGROUND_CONTEXT);
		}
		return ending(result);
	} catch (error) {
		return { state: 'failed', error: error instanceof Error ? error.message : String(error) };
	} finally {
		await env.cleanup();
	}
}

/** Create `~/.jobs` and an empty output file for `handle`, and return the file's absolute path. */
async function prepareOutput(env: WorkspaceEnv, handle: string, context: Context): Promise<string> {
	const dir = await env.absolutePath(JOBS_DIR, context);
	if (!dir.ok) throw dir.error;
	const made = await env.createDir(dir.value, { recursive: true }, context);
	if (!made.ok) throw made.error;
	const path = `${dir.value}/${handle}.out`;
	const written = await env.writeFile(path, '', context);
	if (!written.ok) throw written.error;
	return path;
}

/** Resolve after `ms`, when `until` settles, or reject when `signal` aborts, whichever is first. */
function within(until: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
	return new Promise<void>((resolve, reject) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
		};
		const abort = () => {
			done();
			reject(signal?.reason ?? new Error('Operation aborted.'));
		};
		const timer = setTimeout(() => {
			done();
			resolve();
		}, ms);
		signal?.addEventListener('abort', abort, { once: true });
		until.then(() => {
			done();
			resolve();
		});
	});
}

/** Open the job table of one workspace. `connect` gives each job its own environment. */
export function openJobTable(connect: JobConnect): JobTable {
	const jobs = new Map<string, Job>();
	/** The stops of each agent, one after another: an abort can open a channel of its own. */
	const stops = new Map<string, Promise<void>>();
	let closed = false;

	/**
	 * Abort `job` after every earlier stop of its agent, and wait for it to
	 * end: up to `graceMs`, or with no bound when `graceMs` is absent.
	 */
	const stop = (job: Job, graceMs?: number): Promise<void> => {
		const next = (stops.get(job.agent) ?? Promise.resolve()).then(async () => {
			if (job.status.state !== 'running') return;
			job.controller.abort();
			await (graceMs === undefined ? job.ended : within(job.ended, graceMs));
		});
		stops.set(job.agent, next);
		return next;
	};

	const find = (agent: WorkspaceAgent, handle: string): Job => {
		const job = jobs.get(handle);
		if (job === undefined || job.agent !== agent.name) {
			throw new Error(`You have no job ${handle}. bash returns the handle of each job it starts.`);
		}
		return job;
	};

	const ofAgent = (agent: WorkspaceAgent): Job[] =>
		[...jobs.values()].filter((job) => job.agent === agent.name);

	/** Forget the oldest finished jobs of `agent` past the limit, and remove their output files. */
	const forget = async (agent: WorkspaceAgent, env: WorkspaceEnv): Promise<void> => {
		const finished = ofAgent(agent).filter((job) => job.status.state !== 'running');
		for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS + 1))) {
			jobs.delete(job.status.handle);
			await env.remove(job.status.output, { force: true }, BACKGROUND_CONTEXT);
		}
	};

	const launch = (job: Job, env: WorkspaceEnv, spec: BashJobSpec): void => {
		job.ended = runBash(env, spec, job.status.output, job.controller.signal).then((end) => {
			job.status = Object.freeze({ ...job.status, ...end, endedAt: new Date().toISOString() });
		});
	};

	const start: JobTable['start'] = async (agent, env, spec) => {
		if (closed) throw new Error(CLOSED);
		const running = ofAgent(agent).filter((job) => job.status.state === 'running').length;
		if (running >= MAX_RUNNING_JOBS) {
			throw new Error(
				`You have ${running} jobs running. Wait for one to end, or cancel one, before you start another.`,
			);
		}
		await forget(agent, env);
		const handle = `bash-${randomName()}`;
		const output = await prepareOutput(env, handle, BACKGROUND_CONTEXT);
		const own = await connect(agent);
		if (closed) {
			await own.cleanup();
			throw new Error(CLOSED);
		}
		const status: JobStatus = Object.freeze({
			handle,
			kind: 'bash',
			command: spec.command,
			state: 'running',
			output,
			timeout: spec.timeout,
			startedAt: new Date().toISOString(),
		});
		const job: Job = {
			agent: agent.name,
			status,
			controller: new AbortController(),
			ended: Promise.resolve(),
		};
		jobs.set(handle, job);
		launch(job, own, spec);
		return status;
	};

	const wait: JobTable['wait'] = async (agent, handle, seconds, signal) => {
		const job = find(agent, handle);
		if (job.status.state === 'running') await within(job.ended, seconds * 1000, signal);
		return job.status;
	};

	const cancel: JobTable['cancel'] = async (agent, handle) => {
		const job = find(agent, handle);
		await stop(job, CANCEL_GRACE_MS);
		return job.status;
	};

	const close = async (): Promise<void> => {
		closed = true;
		const all = [...jobs.values()];
		await Promise.allSettled(all.map((job) => stop(job)));
	};

	return Object.freeze({
		start,
		status: (agent: WorkspaceAgent, handle: string) => find(agent, handle).status,
		wait,
		cancel,
		close,
	});
}
