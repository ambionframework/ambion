/**
 * One run of a background process, and the waits of the process table.
 *
 * `runBash` runs the wrapped command on the process's own environment.
 * `endOfRun` and `unreadable` give the end that a run leaves when its files
 * name none. `within` waits for a promise, a time, or an abort.
 *
 * `docs/processes.md` is the design contract.
 */

import {
	BACKGROUND_CONTEXT,
	type ExecutionError,
	type Result,
	type ShellExecResult,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import { runScript } from './execution-env.ts';
import {
	type ProcessSpec,
	type ProcessStatus,
	statusOf,
	stopLine,
	wrapped,
} from './process-files.ts';

/**
 * Seconds past its own timeout and its grace that the table gives the
 * backend's deadline. The table stops the process first. The backend's
 * deadline stops a process that the table's stop did not end.
 */
const BACKEND_SLACK_SECONDS = 30;

/** The largest timeout a Node timer holds, in seconds. */
export const MAX_TIMER_SECONDS = 2_147_483;

/** The most of the shell's own output that a process keeps: what it writes before the redirect applies. */
const SHELL_OUTPUT = { maxBytes: 16_384, maxLines: 200, retain: 'tail' } as const;

/** Resolve after `ms`, when `until` settles, or reject when `signal` aborts, whichever is first. */
export function within(until: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
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
		const settled = () => {
			done();
			resolve();
		};
		until.then(settled, settled);
	});
}

/**
 * Wait `ms`, or until `signal` aborts. Each call waits on a promise of its
 * own, so no call leaves a reaction behind on a promise that never settles.
 */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return within(new Promise<void>(() => undefined), ms, signal);
}

export type Run = Result<ShellExecResult, ExecutionError> | { thrown: unknown };

/**
 * Run one bash process on its own environment. An abort of `signal` stops
 * it with `grace` seconds from `SIGTERM` to `SIGKILL`, on a backend with
 * signals. The shell itself can write before the redirect applies, for
 * example a syntax error. That output goes to the end of `out`.
 */
export async function runBash(
	env: WorkspaceEnv,
	spec: ProcessSpec,
	dir: string,
	signal: AbortSignal,
	grace: number,
): Promise<Run> {
	try {
		const result = await runScript(
			env,
			wrapped(spec.command, dir),
			{
				timeout: Math.min(spec.timeout + grace + BACKEND_SLACK_SECONDS, MAX_TIMER_SECONDS),
				grace,
				capture: { limits: SHELL_OUTPUT },
			},
			withAbortSignal(signal, BACKGROUND_CONTEXT),
		);
		if (result.ok && result.value.output !== '') {
			await env.appendFile(`${dir}/out`, result.value.output, BACKGROUND_CONTEXT);
		}
		return result;
	} catch (thrown) {
		return { thrown };
	}
}

/** The `stop` line for a run that ended with an error and no `exit`: the cause the error gives. */
export function endOfRun(run: Exclude<Run, { ok: true }>): string {
	if ('thrown' in run) {
		const message = run.thrown instanceof Error ? run.thrown.message : String(run.thrown);
		return stopLine('failed', message);
	}
	if (run.error.code === 'timeout') return stopLine('timed_out');
	if (run.error.code === 'aborted') return stopLine('cancelled');
	return stopLine('failed', run.error.message);
}

/** The status of a process whose files could not be read: a failure, from its spec. */
export function unreadable(spec: ProcessSpec, dir: string, error: unknown): ProcessStatus {
	const message = error instanceof Error ? error.message : String(error);
	const lost = statusOf({ dir, spec, seen: false, pid: false, alive: false }, false);
	return Object.freeze({
		...lost,
		error: `The files of the process could not be read: ${message}`,
	});
}
