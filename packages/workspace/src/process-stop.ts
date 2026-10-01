/**
 * The stops of the process table: one chain of stop steps for each agent,
 * and the waits for the end that run outside the chain.
 *
 * A stop of a process of this run takes one chain step, the abort. Its
 * backend sends `SIGTERM`, and `SIGKILL` after the grace. A stop of an
 * adopted process takes one chain step for `SIGTERM` and one for `SIGKILL`,
 * and polls the files between them and after them, outside the chain. No
 * wait for an end holds the chain, so a stop with a long grace holds no
 * later stop of the same agent.
 *
 * `docs/processes.md` is the design contract.
 */

import type { WorkspaceEnv } from './backend.ts';
import {
	type ProcessSpec,
	type StopCause,
	type StopSignal,
	signalGroup,
	stopLine,
	writeStop,
} from './process-files.ts';
import { pause, within } from './process-run.ts';

/**
 * How long a stop waits for the end after the grace: the kill, the close of
 * the channel, and the read of the files. A process that has not ended by
 * then stays `running`.
 */
const STOP_SLACK_MS = 5_000;

/** The most seconds of the grace that the wait of `cancel` covers. */
const CANCEL_GRACE_SECONDS = 10;

/** How often a wait reads the files of a process that an earlier run started. */
export const POLL_MS = 500;

/**
 * How long `cancel` waits for the end: the grace up to `CANCEL_GRACE_SECONDS`,
 * and the slack. A longer grace goes on after the wait.
 */
export function cancelWaitMs(grace: number): number {
	return Math.min(grace, CANCEL_GRACE_SECONDS) * 1000 + STOP_SLACK_MS;
}

/** What only a process that this run started has: its environment, its abort, and the end of its run. */
export interface Own {
	readonly env: WorkspaceEnv;
	readonly controller: AbortController;
	ended: Promise<void>;
}

/**
 * A live process in the memory of this run. A process that this run started
 * has `own`, and the table stops it through the abort, since just-bash has
 * no pid. An adopted process has no `own`: a read of this run found it
 * live, and the table stops it through its pid.
 */
export interface Live {
	readonly agent: string;
	readonly spec: ProcessSpec;
	readonly dir: string;
	/** Seconds from `SIGTERM` to `SIGKILL` when the table stops the process. */
	readonly grace: number;
	own?: Own;
	timer?: ReturnType<typeof setTimeout>;
	/** Why the first stop stopped it. */
	stopping?: StopCause;
}

/** What the stops need from the table. */
export interface StopOptions {
	readonly live: Map<string, Live>;
	/** Whether the table has released its backend: a poll then stops. */
	readonly released: () => boolean;
	/** Run `fn` on an environment of its own for `agent`, outside the bash owner's queue. */
	readonly detached: <T>(agent: string, fn: (env: WorkspaceEnv) => Promise<T>) => Promise<T>;
	/** Read the files of one process. A read that finds the end of an adopted process settles it. */
	readonly readOne: (agent: string, env: WorkspaceEnv, handle: string) => Promise<unknown>;
}

/** The stops of one process table. */
export interface Stops {
	/**
	 * Stop the process `handle` of `agent` after every earlier stop step of
	 * the agent. The promise settles when the process ends, or after its grace
	 * and the slack. It never rejects. A stop of a process that a stop already
	 * stops joins that stop. The first stop names the cause.
	 */
	stop(agent: string, handle: string, cause: StopCause): Promise<void>;
}

/** Open the stops of one process table. */
export function openStops({ live, released, detached, readOne }: StopOptions): Stops {
	/** The steps of the stops of each agent, one after another: a step can open a channel of its own. */
	const chains = new Map<string, Promise<void>>();
	/** The stop that runs for each handle. A later stop joins it. */
	const running = new Map<string, Promise<void>>();

	/** Run `step` after every earlier step of the agent. It reads the process again. A step never rejects, so the chain never breaks. */
	const enqueue = (agent: string, handle: string, step: (one: Live) => Promise<void>) => {
		const run = async () => {
			const process = live.get(handle);
			if (process !== undefined) await step(process);
		};
		const next = (chains.get(agent) ?? Promise.resolve()).then(run).catch(() => undefined);
		chains.set(agent, next);
		return next;
	};

	/** Read one adopted process on an environment of its own until its files show an end, up to `ms`, or until the table releases. */
	const poll = async (agent: string, handle: string, ms: number): Promise<void> => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline && live.has(handle) && !released()) {
			await detached(agent, (env) => readOne(agent, env, handle)).catch(() => undefined);
			if (live.has(handle)) await pause(POLL_MS);
		}
	};

	/** Name the cause of the first stop in `stop`. A later stop keeps it. */
	const nameStop = async (process: Live, env: WorkspaceEnv, cause: StopCause): Promise<void> => {
		if (process.stopping !== undefined) return;
		process.stopping = cause;
		await writeStop(env, process.dir, stopLine(cause));
	};

	/** Send a signal to the group of an adopted process through its pid. */
	const send = (process: Live, signal: StopSignal): Promise<void> =>
		detached(process.agent, (env) =>
			signalGroup(env, process.dir, process.spec.handle, signal),
		).catch(() => undefined);

	/** Name the cause in `stop`, then abort a process of this run. It does not wait. */
	const abortOwn = async (process: Live, own: Own, cause: StopCause): Promise<void> => {
		await nameStop(process, own.env, cause).catch(() => undefined);
		own.controller.abort();
	};

	/** Name the cause in `stop`, then send `SIGTERM` to the group of an adopted process. */
	const termAdopted = async (process: Live, cause: StopCause): Promise<void> => {
		await detached(process.agent, (env) => nameStop(process, env, cause)).catch(() => undefined);
		await send(process, 'TERM');
	};

	/** After the `SIGTERM` of an adopted process: poll for the grace, then `SIGKILL` a group that still runs. */
	const finishAdopted = async (process: Live): Promise<void> => {
		const { agent, spec, grace } = process;
		await poll(agent, spec.handle, grace * 1000);
		if (!live.has(spec.handle)) return;
		await enqueue(agent, spec.handle, (one) => send(one, 'KILL'));
		await poll(agent, spec.handle, STOP_SLACK_MS);
	};

	const sequence = async (agent: string, handle: string, cause: StopCause): Promise<void> => {
		let wait: (() => Promise<void>) | undefined;
		await enqueue(agent, handle, (one) => {
			const { own } = one;
			if (own === undefined) {
				wait = () => finishAdopted(one);
				return termAdopted(one, cause);
			}
			wait = () => within(own.ended, one.grace * 1000 + STOP_SLACK_MS);
			return abortOwn(one, own, cause);
		});
		await wait?.();
	};

	const stop: Stops['stop'] = (agent, handle, cause) => {
		const joined = running.get(handle);
		if (joined !== undefined) return joined;
		const run = sequence(agent, handle, cause).finally(() => running.delete(handle));
		running.set(handle, run);
		return run;
	};

	return { stop };
}
