/**
 * The process table: the background processes of one workspace.
 *
 * The files in each agent's home are the source of truth
 * (`./process-files.ts`). The table reads them for every answer, so a new
 * run of the host reads the same table. Memory holds only what no file can:
 * the environment, the abort controller, and the timer of each process
 * that this run started, and the timer of each live process that an
 * earlier run started. The table adopts such a process when a read finds
 * it, and stops it through its pid.
 *
 * A process runs on an environment of its own, which the table connects
 * outside the queue of the bash owner, so a long command holds no other
 * tool call. A timeout, a cancel, and `close` stop a process through one
 * chain for each agent, so the stops of one agent hold at most one kill
 * channel on the workstation.
 *
 * An agent reads its own processes alone: each table is the agent's own
 * home. The host reads the tables of the agents that used the workspace in
 * this run.
 *
 * `docs/processes.md` is the design contract.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import { randomName } from './execution-env.ts';
import {
	isHandle,
	killGroup,
	type ProcessFiles,
	type ProcessSpec,
	type ProcessStatus,
	processesDir,
	readFiles,
	type StopCause,
	statusOf,
	stopLine,
	writeExit,
	writeSeen,
	writeSpec,
	writeStop,
} from './process-files.ts';
import {
	endOfRun,
	MAX_TIMER_SECONDS,
	NEVER,
	type Run,
	runBash,
	unreadable,
	within,
} from './process-run.ts';
import type { ProcessEvent, ProcessTable, ProcessTableOptions } from './process-table.ts';
import { FINISHED_IN_REMINDER, reminderText } from './process-text.ts';
import type { WorkspaceAgent } from './resource.ts';

/**
 * The most processes one agent can have in the `running` state at one
 * time. On the workstation each running process holds one channel of the
 * agent's SSH client, and OpenSSH allows 10 by default
 * (`docs/workstation.md`).
 */
export const MAX_RUNNING_PROCESSES = 4;

/** The most finished processes the table keeps for one agent. It removes the oldest first. */
export const MAX_FINISHED_PROCESSES = 64;

/** The longest a stop waits for a process to end after the abort. A process that has not ended stays `running`. */
const STOP_GRACE_MS = 10_000;

/** How often a wait reads the files of a process that an earlier run started. */
const POLL_MS = 500;

const CLOSED = 'Workspace is no longer available.';

/** A process that this run started. */
interface Owned {
	readonly agent: string;
	readonly spec: ProcessSpec;
	readonly dir: string;
	readonly env: WorkspaceEnv;
	readonly controller: AbortController;
	ended: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	/** Why the first stop aborted it. */
	stopping?: StopCause;
}

/** A live process that an earlier run started, and that a read of this run found. */
interface Adopted {
	readonly agent: string;
	readonly spec: ProcessSpec;
	readonly dir: string;
	timer: ReturnType<typeof setTimeout>;
	stopping?: StopCause;
}

/** A process as a read finds it: its files, and the status they give. */
interface Found {
	readonly files: ProcessFiles;
	readonly status: ProcessStatus;
}

const byStart = (a: { startedAt: string }, b: { startedAt: string }): number =>
	a.startedAt.localeCompare(b.startedAt);

/** Open the process table of one workspace. */
export function openProcessTable(options: ProcessTableOptions): ProcessTable {
	const { connect, shell } = options;
	const owned = new Map<string, Owned>();
	const adopted = new Map<string, Adopted>();
	/** The agents that used the workspace in this run: the host reads their tables. */
	const agents = new Set<string>();
	/** The stops of each agent, one after another: an abort can open a channel of its own. */
	const stops = new Map<string, Promise<void>>();
	const listeners = new Set<(event: ProcessEvent) => void>();
	let closed = false;
	/** Set when `close` has returned: the backend may release, so no new environment opens. */
	let released = false;

	const emit = (event: ProcessEvent): void => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				// A listener of the host does not stop the other listeners or the process.
			}
		}
	};

	/** Run `fn` on an environment of its own for `agent`, outside the bash owner's queue. */
	const detached = async <T>(agent: string, fn: (env: WorkspaceEnv) => Promise<T>): Promise<T> => {
		if (released) throw new Error(CLOSED);
		const env = await connect({ name: agent });
		try {
			return await fn(env);
		} finally {
			await env.cleanup().catch(() => undefined);
		}
	};

	// -- reads ------------------------------------------------------------------

	/** An adopted process has ended: forget its timer, and tell the host. */
	const settleAdopted = (handle: string, status: ProcessStatus): void => {
		const adoptee = adopted.get(handle);
		if (adoptee === undefined) return;
		clearTimeout(adoptee.timer);
		adopted.delete(handle);
		emit({ type: 'ended', process: status });
	};

	/**
	 * Adopt a live process: arm its timeout from its spec. A process of an
	 * earlier run comes from a read. A process of this run whose shell outlived
	 * its run comes with the cause of its stop.
	 */
	const adopt = (
		agent: string,
		files: Pick<ProcessFiles, 'spec' | 'dir'>,
		stopping?: StopCause,
	): void => {
		const { spec, dir } = files;
		if (adopted.has(spec.handle)) return;
		const due = Date.parse(spec.startedAt) + spec.timeout * 1000 - Date.now();
		const timer = setTimeout(
			() => void stop(agent, spec.handle, 'timed_out'),
			Math.min(Math.max(0, due), MAX_TIMER_SECONDS * 1000),
		);
		timer.unref();
		adopted.set(spec.handle, {
			agent,
			spec,
			dir,
			timer,
			...(stopping === undefined ? {} : { stopping }),
		});
	};

	/**
	 * The status the files give, with the adoption and the end of an adopted
	 * process that it implies. `ours` holds the processes that this run owned
	 * when the read began: a process can end, and leave `owned`, while the
	 * listing runs, and its files can then predate its end.
	 */
	const observe = (agent: string, files: ProcessFiles, ours: ReadonlySet<string>): Found => {
		const handle = files.spec.handle;
		const mine = ours.has(handle) || owned.has(handle);
		const status = statusOf(files, mine);
		if (status.state === 'running' && !mine) adopt(agent, files);
		if (status.state !== 'running') settleAdopted(handle, status);
		return { files, status };
	};

	/** Read the files of `agent` through `env`: every process, or the one process `handle`. */
	const read = async (agent: string, env: WorkspaceEnv, handle?: string): Promise<Found[]> => {
		agents.add(agent);
		const ours = new Set(owned.keys());
		const files = await readFiles(env, await processesDir(env), handle);
		return files
			.map((one) => observe(agent, one, ours))
			.sort((a, b) => byStart(a.status, b.status));
	};

	const unknown = (handle: string, owner = 'You have'): Error =>
		new Error(`${owner} no process ${handle}. bash returns the handle of each process it starts.`);

	const find: ProcessTable['find'] = async (agent, handle, signal) => {
		if (!isHandle(handle)) throw unknown(handle);
		const [found] = await shell(agent, (env) => read(agent.name, env, handle), signal);
		if (found === undefined) throw unknown(handle);
		return found.status;
	};

	const list: ProcessTable['list'] = async (agent, signal) =>
		(await shell(agent, (env) => read(agent.name, env), signal)).map((found) => found.status);

	// -- stops ------------------------------------------------------------------

	/** Stop a process of this run: name the cause in `stop`, abort, and wait up to the grace. */
	const stopOwned = async (own: Owned, cause: StopCause): Promise<void> => {
		if (own.stopping === undefined) {
			own.stopping = cause;
			await writeStop(own.env, own.dir, stopLine(cause)).catch(() => undefined);
			own.controller.abort();
		}
		await within(own.ended, STOP_GRACE_MS);
	};

	/** Read one process on an environment of its own until its files show an end, up to `ms`. */
	const pollDetached = async (agent: string, handle: string, ms: number): Promise<void> => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline && adopted.has(handle)) {
			await detached(agent, (env) => read(agent, env, handle)).catch(() => undefined);
			if (adopted.has(handle)) await within(NEVER, POLL_MS);
		}
	};

	/** Stop a process of an earlier run: name the cause in `stop`, kill its group, and wait for the end. */
	const stopAdopted = async (adoptee: Adopted, cause: StopCause): Promise<void> => {
		const { agent, dir, spec } = adoptee;
		await detached(agent, async (env) => {
			if (adoptee.stopping === undefined) {
				adoptee.stopping = cause;
				await writeStop(env, dir, stopLine(cause));
			}
			await killGroup(env, dir, spec.handle);
		}).catch(() => undefined);
		await pollDetached(agent, spec.handle, STOP_GRACE_MS);
	};

	/**
	 * Stop a process after every earlier stop of its agent. The first stop
	 * that aborts a process names its cause. A stop never rejects, and a
	 * failed stop does not stop the next one.
	 */
	const stop = (agent: string, handle: string, cause: StopCause): Promise<void> => {
		const run = async () => {
			const own = owned.get(handle);
			const adoptee = adopted.get(handle);
			try {
				if (own !== undefined) await stopOwned(own, cause);
				else if (adoptee !== undefined) await stopAdopted(adoptee, cause);
			} catch {
				// The files keep the truth. The next read gives what the stop left.
			}
		};
		const next = (stops.get(agent) ?? Promise.resolve()).then(run, run);
		stops.set(agent, next);
		return next;
	};

	// -- the run of a process ---------------------------------------------------

	/**
	 * Run `fn` on the process's own environment, and on a fresh one when that
	 * fails, as after a drop of the connection.
	 */
	const onFiles = <T>(own: Owned, fn: (env: WorkspaceEnv) => Promise<T>): Promise<T> =>
		fn(own.env).catch(() => detached(own.agent, fn));

	/** The final status of a process of this run, from its files, once the run ended. */
	const finalStatus = async (own: Owned): Promise<ProcessStatus> => {
		const root = own.dir.slice(0, own.dir.lastIndexOf('/'));
		try {
			const [files] = await onFiles(own, (env) => readFiles(env, root, own.spec.handle));
			return files === undefined
				? unreadable(own.spec, own.dir, 'no spec')
				: statusOf(files, false);
		} catch (error) {
			return unreadable(own.spec, own.dir, error);
		}
	};

	/** Write the end that a run gives: its exit code, or a stop for its error. */
	const writeEnd = (env: WorkspaceEnv, dir: string, run: Run): Promise<void> =>
		'ok' in run && run.ok
			? writeExit(env, dir, run.value.exitCode)
			: writeStop(env, dir, endOfRun(run));

	/**
	 * After the run: when the files name no end, write the one the run gives.
	 * A shell that ended with a code before the wrapper wrote `exit`, as on a
	 * syntax error, gives that code. An error of the run gives `stop`.
	 */
	const recordEnd = async (own: Owned, run: Run): Promise<void> => {
		if (own.stopping !== undefined) return;
		await onFiles(own, async (env) => {
			const exit = await env.exists(`${own.dir}/exit`, BACKGROUND_CONTEXT);
			if (!exit.ok) throw exit.error;
			if (!exit.value) await writeEnd(env, own.dir, run);
		});
	};

	/**
	 * After the run: record the end the files lack, read the final status, and
	 * tell the host. The process leaves this run's memory after the read, so a
	 * start in between counts it as running and does not remove its files. A
	 * shell that outlived the run, as after a kill it did not obey, becomes
	 * adopted, and its one `ended` event comes when a read sees the end.
	 */
	const settleOwned = async (own: Owned, run: Run): Promise<void> => {
		clearTimeout(own.timer);
		await recordEnd(own, run).catch(() => undefined);
		const status = await finalStatus(own);
		if (status.state === 'running') adopt(own.agent, own, own.stopping);
		owned.delete(own.spec.handle);
		await own.env.cleanup().catch(() => undefined);
		if (status.state !== 'running') emit({ type: 'ended', process: status });
	};

	const launch = (own: Owned): void => {
		own.timer = setTimeout(
			() => void stop(own.agent, own.spec.handle, 'timed_out'),
			own.spec.timeout * 1000,
		);
		own.timer.unref();
		own.ended = runBash(own.env, own.spec, own.dir, own.controller.signal)
			.then((run) => settleOwned(own, run))
			.catch(() => void owned.delete(own.spec.handle));
	};

	/**
	 * Remove the finished processes of the agent past the limit, with their
	 * files: the oldest seen ones first, then the oldest that no result or
	 * reminder showed.
	 */
	const forget = async (env: WorkspaceEnv, found: Found[]): Promise<void> => {
		const finished = found
			.filter((one) => one.status.state !== 'running')
			.sort((a, b) => Number(b.files.seen) - Number(a.files.seen));
		const excess = Math.max(0, finished.length - MAX_FINISHED_PROCESSES + 1);
		for (const one of finished.slice(0, excess)) {
			await env.remove(one.files.dir, { recursive: true, force: true }, BACKGROUND_CONTEXT);
		}
	};

	const refuseOverLimit = (found: Found[]): void => {
		const running = found.filter((one) => one.status.state === 'running').length;
		if (running < MAX_RUNNING_PROCESSES) return;
		throw new Error(
			`You have ${running} processes running. Wait for one to end, or cancel one, before you start another.`,
		);
	};

	/** Connect the process's own environment. A failed connect removes the directory it leaves. */
	const connectOrRemove = async (
		agent: WorkspaceAgent,
		env: WorkspaceEnv,
		dir: string,
	): Promise<WorkspaceEnv> => {
		try {
			const own = await connect(agent);
			if (!closed) return own;
			await own.cleanup().catch(() => undefined);
			throw new Error(CLOSED);
		} catch (error) {
			await env.remove(dir, { recursive: true, force: true }, BACKGROUND_CONTEXT);
			throw error;
		}
	};

	const start: ProcessTable['start'] = async (agent, env, request) => {
		if (closed) throw new Error(CLOSED);
		const found = await read(agent.name, env);
		refuseOverLimit(found);
		await forget(env, found);
		const spec: ProcessSpec = Object.freeze({
			handle: `bash-${randomName()}`,
			...(request.name === undefined ? {} : { name: request.name }),
			kind: 'bash',
			agent: agent.name,
			command: request.command,
			timeout: request.timeout,
			...(request.room === undefined ? {} : { room: request.room }),
			startedAt: new Date().toISOString(),
		});
		const dir = await writeSpec(env, await processesDir(env), spec);
		const own: Owned = {
			agent: agent.name,
			spec,
			dir,
			env: await connectOrRemove(agent, env, dir),
			controller: new AbortController(),
			ended: Promise.resolve(),
		};
		owned.set(spec.handle, own);
		launch(own);
		const status = statusOf({ dir, spec, seen: false, alive: false }, true);
		emit({ type: 'started', process: status });
		return status;
	};

	// -- waits and cancels ------------------------------------------------------

	/** The statuses of `handles`, in their order: one read for one handle, one listing for more. */
	const findAll = async (
		agent: WorkspaceAgent,
		handles: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly ProcessStatus[]> => {
		const [only] = handles;
		if (handles.length === 1 && only !== undefined) return [await find(agent, only, signal)];
		const all = await list(agent, signal);
		return handles.map((handle) => {
			const found = all.find((one) => one.handle === handle);
			if (found === undefined) throw unknown(handle);
			return found;
		});
	};

	/**
	 * A process of this run ends through its promise. A process of an
	 * earlier run ends in a read, so the wait reads again every `POLL_MS`.
	 */
	const wait: ProcessTable['wait'] = async (agent, handles, seconds, signal) => {
		const deadline = Date.now() + seconds * 1000;
		let statuses = await findAll(agent, handles, signal);
		while (statuses.every((one) => one.state === 'running') && Date.now() < deadline) {
			const ends = handles.map((handle) => owned.get(handle)?.ended);
			const owns = ends.filter((end): end is Promise<void> => end !== undefined);
			const left = deadline - Date.now();
			const ms = owns.length === ends.length ? left : Math.min(POLL_MS, left);
			await within(owns.length === 0 ? NEVER : Promise.race(owns), ms, signal);
			statuses = await findAll(agent, handles, signal);
		}
		return statuses;
	};

	const cancel: ProcessTable['cancel'] = async (agent, handle) => {
		const status = await find(agent, handle);
		if (status.state !== 'running') return status;
		await stop(agent.name, handle, 'cancelled');
		return find(agent, handle);
	};

	/** The agent whose table holds `handle`: from memory, or from the host's list. */
	const ownerOf = async (handle: string): Promise<string | undefined> =>
		owned.get(handle)?.agent ??
		adopted.get(handle)?.agent ??
		(await hostList()).find((process) => process.handle === handle)?.agent;

	const hostCancel: ProcessTable['hostCancel'] = async (handle) => {
		const agent = isHandle(handle) ? await ownerOf(handle) : undefined;
		if (agent === undefined) throw unknown(handle, 'The workspace has');
		return cancel({ name: agent }, handle);
	};

	// -- the reminder and the host's list ---------------------------------------

	const remind: ProcessTable['remind'] = (seat, signal) =>
		shell(
			{ name: seat.agent },
			async (env) => {
				const found = await read(seat.agent, env);
				const running = found.filter((one) => one.status.state === 'running');
				const unseen = found.filter((one) => one.status.state !== 'running' && !one.files.seen);
				const text = reminderText(
					running.map((one) => one.status),
					unseen.map((one) => one.status),
					seat.room,
					Date.now(),
				);
				for (const one of unseen.slice(-FINISHED_IN_REMINDER)) {
					if (signal.aborted) break;
					await writeSeen(env, one.files.dir);
				}
				return text;
			},
			signal,
		);

	const markSeen: ProcessTable['markSeen'] = async (env, process) => {
		if (process.state === 'running') return;
		await writeSeen(env, process.output.slice(0, process.output.lastIndexOf('/')));
	};

	const hostList: ProcessTable['hostList'] = async (query = {}) => {
		const names = [...agents].filter((name) => query.agent === undefined || name === query.agent);
		const lists = await Promise.all(names.map((name) => list({ name })));
		return Object.freeze(
			lists
				.flat()
				.filter((status) => query.running !== true || status.state === 'running')
				.sort(byStart),
		);
	};

	const close = async (): Promise<void> => {
		closed = true;
		const running = [...owned.values(), ...adopted.values()];
		await Promise.allSettled(running.map((one) => stop(one.agent, one.spec.handle, 'cancelled')));
		for (const adoptee of adopted.values()) clearTimeout(adoptee.timer);
		released = true;
	};

	return Object.freeze({
		start,
		list,
		find,
		wait,
		cancel,
		markSeen,
		remind,
		hostList,
		subscribe: (listener: (event: ProcessEvent) => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		hostCancel,
		close,
	});
}
