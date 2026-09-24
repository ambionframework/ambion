/**
 * The process table: the background processes of one workspace, by handle.
 *
 * `bash` starts every command as a process. A process runs on an
 * environment of its own, which the table connects outside the queue of the
 * bash owner, so a long command holds no other tool call of any agent. The
 * command's output goes to a file in the agent's home,
 * `~/.processes/<handle>.out`. The table keeps the state of each process in
 * the host's memory for the life of the workspace. A process runs until it
 * ends, times out, or gets a cancel: no activation, exchange, or room stops
 * it.
 *
 * The table holds each timeout itself. A timeout, a cancel, and `close`
 * stop a process through one chain for each agent, so the stops of one
 * agent hold at most one kill channel on the workstation.
 *
 * A handle is `<kind>-<random>`. `bash` is the one kind today. The handle
 * tools, `ps`, the host's view, and the reminder read the kind from the
 * table, so a new kind adds a kind and a runner, and no new tool.
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
import { FINISHED_IN_REMINDER, reminderText } from './process-text.ts';
import type { WorkspaceAgent } from './resource.ts';

/** The kinds of process. A handle starts with its kind. */
export type ProcessKind = 'bash';

/** Where a process is in its life. Every state but `running` is final. */
export type ProcessState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed';

/** What the table knows of one process. A caller gets a frozen value. */
export interface ProcessStatus {
	/** The key of the process. */
	readonly handle: string;
	/** The label the agent gave the process, when it gave one. */
	readonly name?: string;
	readonly kind: ProcessKind;
	/** The owner agent: the agent whose call started the process. */
	readonly agent: string;
	/** The command as the agent gave it. */
	readonly command: string;
	readonly state: ProcessState;
	/** The absolute path of the file that holds the whole output. */
	readonly output: string;
	/** Seconds the process may run before the table stops it. */
	readonly timeout: number;
	/** The room of the call that started the process, when it had one. Metadata alone. */
	readonly room?: string;
	readonly startedAt: string;
	/** Set when the state is final. */
	readonly endedAt?: string;
	/** Set when the state is `exited`. */
	readonly exitCode?: number;
	/** Set when the state is `failed`. */
	readonly error?: string;
}

/** A process that started, or one that ended. */
export type ProcessEvent =
	| { readonly type: 'started'; readonly process: ProcessStatus }
	| { readonly type: 'ended'; readonly process: ProcessStatus };

/** What `bash` asks the table to run. */
interface BashProcessSpec {
	readonly command: string;
	readonly name?: string;
	readonly timeout: number;
	readonly room?: string;
}

/** Which processes a list holds. */
export interface ProcessQuery {
	/** The owner agent. Absent lists every agent's processes. */
	readonly agent?: string;
	/** `true` lists the running processes alone. */
	readonly running?: boolean;
}

/** The directory in each agent's home that holds the output of its processes. */
export const PROCESSES_DIR = '~/.processes';

/**
 * The most processes one agent can have in the `running` state at one
 * time. On the workstation each running process holds one channel of the
 * agent's SSH client, and OpenSSH allows 10 by default
 * (`docs/workstation.md`).
 */
export const MAX_RUNNING_PROCESSES = 4;

/** The most finished processes the table keeps for one agent. It forgets the oldest first. */
export const MAX_FINISHED_PROCESSES = 64;

/** The longest a stop waits for a process to end after the abort. */
const STOP_GRACE_MS = 10_000;

/**
 * Seconds past its own timeout that the table gives the backend's deadline.
 * The table stops the process first. The backend's deadline stops a process
 * that the table's stop did not end.
 */
const BACKEND_SLACK_SECONDS = 30;

/** The largest timeout a Node timer holds, in seconds. */
const MAX_TIMER_SECONDS = 2_147_483;

/** The most activations whose reminder the table keeps for a second render. */
const REMEMBERED_ACTIVATIONS = 256;

const CLOSED = 'Workspace is no longer available.';

/** Connect one agent's environment outside the queue of the bash owner. */
export type ProcessConnect = (agent: WorkspaceAgent) => Promise<WorkspaceEnv>;

/** The background processes of one workspace. */
export interface ProcessTable {
	/**
	 * Start a bash process for `agent`. `env` is the agent's environment on
	 * the bash owner. The table uses it only to prepare the output file, and
	 * to remove the files of the finished processes that it forgets. The
	 * process runs on an environment of its own.
	 */
	start(agent: WorkspaceAgent, env: WorkspaceEnv, spec: BashProcessSpec): Promise<ProcessStatus>;
	/** The status of a process of `agent`. Throws when `agent` has no process `handle`. */
	status(agent: WorkspaceAgent, handle: string): ProcessStatus;
	/**
	 * Wait up to `seconds` for a process of `agent` to end, and return its
	 * status. The status is `running` when the time ends first. An abort of
	 * `signal` rejects, and the process keeps running.
	 */
	wait(
		agent: WorkspaceAgent,
		handle: string,
		seconds: number,
		signal?: AbortSignal,
	): Promise<ProcessStatus>;
	/** Stop a process of `agent`, and return its status once it ends. A final process stays as it is. */
	cancel(agent: WorkspaceAgent, handle: string): Promise<ProcessStatus>;
	/** The processes that `query` selects, in the order they started. */
	list(query?: ProcessQuery): readonly ProcessStatus[];
	/** Call `listener` when a process starts and when it ends. Returns the unsubscribe. */
	subscribe(listener: (event: ProcessEvent) => void): () => void;
	/** Stop the process `handle` of any agent: the host's cancel. */
	cancelAny(handle: string): Promise<ProcessStatus>;
	/** Note that a result showed the final state of `handle`, so no reminder names it again. */
	shown(handle: string): void;
	/** The reminder of one activation. The same activation gets the same text. */
	remind(seat: { agent: string; room: string; activation: string }): string | undefined;
	/** Refuse new processes, stop every running process, and wait for each one to end. */
	close(): Promise<void>;
}

interface Entry {
	status: ProcessStatus;
	readonly controller: AbortController;
	ended: Promise<void>;
	/** The table's own timeout fired, so an abort ends as `timed_out`. */
	timedOut: boolean;
	/** A result or a reminder showed the final state. */
	shown: boolean;
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

/** The most of the shell's own output that a process keeps: what it writes before the redirect applies. */
const SHELL_OUTPUT = { maxBytes: 16_384, maxLines: 200, retain: 'tail' } as const;

type Ending = Pick<ProcessStatus, 'state' | 'exitCode' | 'error'>;

/** The final state that one run of `exec` gives. `timedOut` turns an abort into a timeout. */
function ending(result: Result<ShellExecResult, ExecutionError>, timedOut: boolean): Ending {
	if (result.ok) return { state: 'exited', exitCode: result.value.exitCode };
	if (result.error.code === 'timeout') return { state: 'timed_out' };
	if (result.error.code === 'aborted') return { state: timedOut ? 'timed_out' : 'cancelled' };
	return { state: 'failed', error: result.error.message };
}

/**
 * Run one bash process on its own environment, and return the result of
 * `exec`. The shell itself can write before the redirect applies, for
 * example a syntax error. That output goes to the end of the output file.
 * The environment is cleaned up in every case.
 */
async function runBash(
	env: WorkspaceEnv,
	spec: BashProcessSpec,
	output: string,
	signal: AbortSignal,
): Promise<Result<ShellExecResult, ExecutionError> | { thrown: unknown }> {
	let view: ShellOutputView | undefined;
	try {
		const result = await env.exec(
			redirected(spec.command, output),
			{
				timeout: Math.min(spec.timeout + BACKEND_SLACK_SECONDS, MAX_TIMER_SECONDS),
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
		return result;
	} catch (thrown) {
		return { thrown };
	} finally {
		await env.cleanup();
	}
}

/** The final state of a run: from the result of `exec`, or from what it threw. */
function endingOf(
	run: Result<ShellExecResult, ExecutionError> | { thrown: unknown },
	timedOut: boolean,
): Ending {
	if (!('thrown' in run)) return ending(run, timedOut);
	const error = run.thrown instanceof Error ? run.thrown.message : String(run.thrown);
	return { state: 'failed', error };
}

/** Create `~/.processes` and an empty output file for `handle`, and return the file's absolute path. */
async function prepareOutput(env: WorkspaceEnv, handle: string, context: Context): Promise<string> {
	const dir = await env.absolutePath(PROCESSES_DIR, context);
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

/** Open the process table of one workspace. `connect` gives each process its own environment. */
export function openProcessTable(connect: ProcessConnect): ProcessTable {
	const entries = new Map<string, Entry>();
	/** The stops of each agent, one after another: an abort can open a channel of its own. */
	const stops = new Map<string, Promise<void>>();
	const listeners = new Set<(event: ProcessEvent) => void>();
	/** The reminder of each recent activation, so a second render of one activation reads the same text. */
	const reminders = new Map<string, string | undefined>();
	let closed = false;

	const emit = (event: ProcessEvent): void => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// A listener of the host does not stop the other listeners or the process.
			}
		}
	};

	/**
	 * Abort `entry` after every earlier stop of its agent, and wait for it to
	 * end: up to `graceMs`, or with no bound when `graceMs` is absent.
	 */
	const stop = (entry: Entry, graceMs?: number): Promise<void> => {
		const agent = entry.status.agent;
		const next = (stops.get(agent) ?? Promise.resolve()).then(async () => {
			if (entry.status.state !== 'running') return;
			entry.controller.abort();
			await (graceMs === undefined ? entry.ended : within(entry.ended, graceMs));
		});
		stops.set(agent, next);
		return next;
	};

	const find = (handle: string, agent?: WorkspaceAgent): Entry => {
		const entry = entries.get(handle);
		if (entry === undefined || (agent !== undefined && entry.status.agent !== agent.name)) {
			const owner = agent === undefined ? 'The workspace has' : 'You have';
			throw new Error(
				`${owner} no process ${handle}. bash returns the handle of each process it starts.`,
			);
		}
		return entry;
	};

	const ofAgent = (name: string): Entry[] =>
		[...entries.values()].filter((entry) => entry.status.agent === name);

	/** Forget the oldest finished processes of `agent` past the limit, and remove their output files. */
	const forget = async (agent: WorkspaceAgent, env: WorkspaceEnv): Promise<void> => {
		const finished = ofAgent(agent.name).filter((entry) => entry.status.state !== 'running');
		const excess = Math.max(0, finished.length - MAX_FINISHED_PROCESSES + 1);
		for (const entry of finished.slice(0, excess)) {
			entries.delete(entry.status.handle);
			await env.remove(entry.status.output, { force: true }, BACKGROUND_CONTEXT);
		}
	};

	/** Run the process, stop it at its timeout, and record its end. */
	const launch = (entry: Entry, env: WorkspaceEnv, spec: BashProcessSpec): void => {
		const timer = setTimeout(() => {
			entry.timedOut = true;
			void stop(entry, STOP_GRACE_MS);
		}, spec.timeout * 1000);
		timer.unref();
		entry.ended = runBash(env, spec, entry.status.output, entry.controller.signal).then((run) => {
			clearTimeout(timer);
			const end = endingOf(run, entry.timedOut);
			entry.status = Object.freeze({ ...entry.status, ...end, endedAt: new Date().toISOString() });
			emit({ type: 'ended', process: entry.status });
		});
	};

	const refuseOverLimit = (agent: WorkspaceAgent): void => {
		const running = ofAgent(agent.name).filter((entry) => entry.status.state === 'running').length;
		if (running < MAX_RUNNING_PROCESSES) return;
		throw new Error(
			`You have ${running} processes running. Wait for one to end, or cancel one, before you start another.`,
		);
	};

	const start: ProcessTable['start'] = async (agent, env, spec) => {
		if (closed) throw new Error(CLOSED);
		refuseOverLimit(agent);
		await forget(agent, env);
		const handle = `bash-${randomName()}`;
		const output = await prepareOutput(env, handle, BACKGROUND_CONTEXT);
		const own = await connect(agent);
		if (closed) {
			await own.cleanup();
			throw new Error(CLOSED);
		}
		const status: ProcessStatus = Object.freeze({
			handle,
			...(spec.name === undefined ? {} : { name: spec.name }),
			kind: 'bash',
			agent: agent.name,
			command: spec.command,
			state: 'running',
			output,
			timeout: spec.timeout,
			...(spec.room === undefined ? {} : { room: spec.room }),
			startedAt: new Date().toISOString(),
		});
		const entry: Entry = {
			status,
			controller: new AbortController(),
			ended: Promise.resolve(),
			timedOut: false,
			shown: false,
		};
		entries.set(handle, entry);
		launch(entry, own, spec);
		emit({ type: 'started', process: status });
		return status;
	};

	const wait: ProcessTable['wait'] = async (agent, handle, seconds, signal) => {
		const entry = find(handle, agent);
		if (entry.status.state === 'running') await within(entry.ended, seconds * 1000, signal);
		return entry.status;
	};

	const stopped = async (entry: Entry): Promise<ProcessStatus> => {
		await stop(entry, STOP_GRACE_MS);
		return entry.status;
	};

	const list: ProcessTable['list'] = (query = {}) =>
		Object.freeze(
			[...entries.values()]
				.map((entry) => entry.status)
				.filter((status) => query.agent === undefined || status.agent === query.agent)
				.filter((status) => query.running !== true || status.state === 'running'),
		);

	/** The processes a reminder names for `agent`, and the finished ones it marks as shown. */
	const remind: ProcessTable['remind'] = (seat) => {
		if (reminders.has(seat.activation)) return reminders.get(seat.activation);
		const own = ofAgent(seat.agent);
		const unseen = own.filter((entry) => entry.status.state !== 'running' && !entry.shown);
		const text = reminderText(
			own.filter((entry) => entry.status.state === 'running').map((entry) => entry.status),
			unseen.map((entry) => entry.status),
			seat.room,
			Date.now(),
		);
		for (const entry of unseen.slice(-FINISHED_IN_REMINDER)) entry.shown = true;
		reminders.set(seat.activation, text);
		// A Map iterates in insertion order, so the first key is the oldest activation.
		if (reminders.size > REMEMBERED_ACTIVATIONS)
			reminders.delete(reminders.keys().next().value ?? '');
		return text;
	};

	const close = async (): Promise<void> => {
		closed = true;
		await Promise.allSettled([...entries.values()].map((entry) => stop(entry)));
	};

	return Object.freeze({
		start,
		status: (agent: WorkspaceAgent, handle: string) => find(handle, agent).status,
		wait,
		cancel: async (agent: WorkspaceAgent, handle: string) => stopped(find(handle, agent)),
		list,
		subscribe: (listener: (event: ProcessEvent) => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		cancelAny: async (handle: string) => stopped(find(handle)),
		shown: (handle: string) => {
			const entry = entries.get(handle);
			if (entry !== undefined && entry.status.state !== 'running') entry.shown = true;
		},
		remind,
		close,
	});
}
