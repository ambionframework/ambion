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
import { FINISHED_IN_REMINDER, reminderText } from './process-text.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

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

/** Which processes the host's list holds. */
export interface ProcessQuery {
	/** The owner agent. Absent lists the processes of every agent of this run. */
	readonly agent?: string;
	/** `true` lists the running processes alone. */
	readonly running?: boolean;
}

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

/** Connect one agent's environment outside the queue of the bash owner. */
type ProcessConnect = (agent: WorkspaceAgent) => Promise<WorkspaceEnv>;

/** What the table needs from the workspace: a connect of its own, and the bash owner. */
export interface ProcessTableOptions {
	readonly connect: ProcessConnect;
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
}

/** The background processes of one workspace. */
export interface ProcessTable {
	/**
	 * Start a bash process for `agent`. `env` is the agent's environment on
	 * the bash owner: the table reads the agent's files and writes the new
	 * process's `spec` through it. The process runs on an environment of its own.
	 */
	start(agent: WorkspaceAgent, env: WorkspaceEnv, spec: BashProcessSpec): Promise<ProcessStatus>;
	/** The processes of `agent`, in the order they started. */
	list(agent: WorkspaceAgent, signal?: AbortSignal): Promise<readonly ProcessStatus[]>;
	/** One process of `agent`. Throws when `agent` has no process `handle`. */
	find(agent: WorkspaceAgent, handle: string, signal?: AbortSignal): Promise<ProcessStatus>;
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
	/** Stop a process of `agent`, and return its status once it ends or the grace ends. */
	cancel(agent: WorkspaceAgent, handle: string): Promise<ProcessStatus>;
	/** Write `seen` for a process in a final state, through `env` on the bash owner. */
	markSeen(env: WorkspaceEnv, process: ProcessStatus): Promise<void>;
	/** The reminder of one activation: the seat's running processes, and the finished ones that no result showed. */
	remind(seat: { agent: string; room: string; activation: string }): Promise<string | undefined>;
	/** The host's list: the processes of the agents that used the workspace in this run. */
	hostList(query?: ProcessQuery): Promise<readonly ProcessStatus[]>;
	/** Call `listener` when a process starts and when it ends. Returns the unsubscribe. */
	subscribe(listener: (event: ProcessEvent) => void): () => void;
	/** Stop the process `handle` of any agent of this run: the host's cancel. */
	hostCancel(handle: string): Promise<ProcessStatus>;
	/** Refuse new processes, stop every running process, and wait up to the grace for each one to end. */
	close(): Promise<void>;
}

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

	/** Adopt a live process of an earlier run: arm its timeout from its spec. */
	const adopt = (agent: string, files: ProcessFiles): void => {
		const { spec, dir } = files;
		if (adopted.has(spec.handle)) return;
		const due = Date.parse(spec.startedAt) + spec.timeout * 1000 - Date.now();
		const timer = setTimeout(
			() => void stop(agent, spec.handle, 'timed_out'),
			Math.min(Math.max(0, due), MAX_TIMER_SECONDS * 1000),
		);
		timer.unref();
		adopted.set(spec.handle, { agent, spec, dir, timer });
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

	/** The final status of a process of this run, from its files, once the run ended. */
	const finalStatus = async (own: Owned): Promise<ProcessStatus> => {
		const root = own.dir.slice(0, own.dir.lastIndexOf('/'));
		try {
			const [files] = await readFiles(own.env, root, own.spec.handle);
			return files === undefined
				? unreadable(own.spec, own.dir, 'no spec')
				: statusOf(files, false);
		} catch (error) {
			return unreadable(own.spec, own.dir, error);
		}
	};

	/**
	 * After the run: when the files name no end, write the one the run gives.
	 * A shell that ended with a code before the wrapper wrote `exit`, as on a
	 * syntax error, gives that code. An error of the run gives `stop`.
	 */
	const recordEnd = async (own: Owned, run: Run): Promise<void> => {
		const exit = await own.env.exists(`${own.dir}/exit`, BACKGROUND_CONTEXT);
		if ((exit.ok && exit.value) || own.stopping !== undefined) return;
		if ('ok' in run && run.ok) await writeExit(own.env, own.dir, run.value.exitCode);
		else await writeStop(own.env, own.dir, endOfRun(run));
	};

	/** After the run: record the end the files lack, read the final status, and tell the host. */
	const settleOwned = async (own: Owned, run: Run): Promise<void> => {
		clearTimeout(own.timer);
		await recordEnd(own, run).catch(() => undefined);
		owned.delete(own.spec.handle);
		const status = await finalStatus(own);
		await own.env.cleanup().catch(() => undefined);
		emit({ type: 'ended', process: status });
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

	/** Remove the oldest finished processes of the agent past the limit, with their files. */
	const forget = async (env: WorkspaceEnv, found: Found[]): Promise<void> => {
		const finished = found.filter((one) => one.status.state !== 'running');
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

	/** Read a process of an earlier run until it ends, the time ends, or `signal` aborts. */
	const poll = async (
		agent: WorkspaceAgent,
		handle: string,
		ms: number,
		signal?: AbortSignal,
	): Promise<ProcessStatus> => {
		const deadline = Date.now() + ms;
		let status = await find(agent, handle, signal);
		while (status.state === 'running' && Date.now() < deadline) {
			await within(NEVER, Math.min(POLL_MS, deadline - Date.now()), signal);
			status = await find(agent, handle, signal);
		}
		return status;
	};

	const wait: ProcessTable['wait'] = async (agent, handle, seconds, signal) => {
		const status = await find(agent, handle, signal);
		if (status.state !== 'running') return status;
		const own = owned.get(handle);
		if (own === undefined) return poll(agent, handle, seconds * 1000, signal);
		await within(own.ended, seconds * 1000, signal);
		return find(agent, handle, signal);
	};

	const cancel: ProcessTable['cancel'] = async (agent, handle) => {
		const status = await find(agent, handle);
		if (status.state !== 'running') return status;
		await stop(agent.name, handle, 'cancelled');
		return find(agent, handle);
	};

	/** The agent whose table holds `handle`: from memory, or from a read of each agent of this run. */
	const ownerOf = async (handle: string): Promise<string | undefined> => {
		const known = owned.get(handle)?.agent ?? adopted.get(handle)?.agent;
		if (known !== undefined) return known;
		for (const agent of agents) {
			const hit = await find({ name: agent }, handle).then(
				() => true,
				() => false,
			);
			if (hit) return agent;
		}
		return undefined;
	};

	const hostCancel: ProcessTable['hostCancel'] = async (handle) => {
		const agent = isHandle(handle) ? await ownerOf(handle) : undefined;
		if (agent === undefined) throw unknown(handle, 'The workspace has');
		return cancel({ name: agent }, handle);
	};

	// -- the reminder and the host's list ---------------------------------------

	const remind: ProcessTable['remind'] = (seat) =>
		shell({ name: seat.agent }, async (env) => {
			const found = await read(seat.agent, env);
			const running = found.filter((one) => one.status.state === 'running');
			const unseen = found.filter((one) => one.status.state !== 'running' && !one.files.seen);
			const text = reminderText(
				running.map((one) => one.status),
				unseen.map((one) => one.status),
				seat.room,
				Date.now(),
			);
			for (const one of unseen.slice(-FINISHED_IN_REMINDER)) await writeSeen(env, one.files.dir);
			return text;
		});

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
