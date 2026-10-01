/**
 * The process table: the background processes of one workspace.
 *
 * The files in each agent's home are the source of truth
 * (`./process-files.ts`). The table reads them for every answer, so a new
 * run of the host reads the same table. Memory holds only what no file can:
 * one record for each live process, with its timer. The record of a
 * process that this run started also holds its environment and its abort
 * controller. The table adopts a live process of an earlier run when a
 * read finds it, and cancels it through its pid.
 *
 * A process runs on an environment of its own, which the table connects
 * outside the queue of the bash owner, so a long command holds no other
 * tool call. A timeout, a cancel, and `close` cancel a process through one
 * chain for each agent. The workstation backend holds one signal channel
 * for each client, in a queue of its own. A cancel sends `SIGTERM`, waits
 * for the grace, and sends `SIGKILL`.
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
import { cancelWaitMs, type Live, type Own, openCancels, POLL_MS } from './process-cancel.ts';
import {
	isHandle,
	LOST,
	lostLine,
	type ProcessFiles,
	type ProcessRecord,
	type ProcessSpec,
	processesDir,
	readFiles,
	statusOf,
	writeExit,
	writeSeen,
	writeSpec,
	writeStop,
} from './process-files.ts';
import {
	endOfRun,
	MAX_TIMER_SECONDS,
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

const CLOSED = 'Workspace is no longer available.';

/** A process as a read finds it: its files, and the status they give. */
interface Found {
	readonly files: ProcessFiles;
	readonly status: ProcessRecord;
}

const byStart = (a: { startedAt: string }, b: { startedAt: string }): number =>
	a.startedAt.localeCompare(b.startedAt);

/** Open the process table of one workspace. */
export function openProcessTable(options: ProcessTableOptions): ProcessTable {
	const { connect, shell } = options;
	const live = new Map<string, Live>();
	/** The agents that used the workspace in this run: the host reads their tables. */
	const agents = new Set<string>();
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

	/** Whether this run runs `handle` now: the process is live, and it is not adopted. */
	const runs = (handle: string): boolean => live.get(handle)?.own !== undefined;

	/** Arm the timeout of a live process, by default from its spec: at the timeout, the table cancels it. */
	const arm = (
		process: Live,
		ms = Date.parse(process.spec.startedAt) + process.spec.timeout * 1000 - Date.now(),
	): void => {
		clearTimeout(process.timer);
		process.timer = setTimeout(
			() => void cancels.cancel(process.agent, process.spec.handle, 'timed_out'),
			Math.min(Math.max(0, ms), MAX_TIMER_SECONDS * 1000),
		);
		process.timer.unref();
	};

	/** A live process has ended: forget it, and tell the host. */
	const settle = (process: Live, status: ProcessRecord): void => {
		clearTimeout(process.timer);
		live.delete(process.spec.handle);
		emit({ type: 'ended', process: status });
	};

	/**
	 * Adopt a live process of an earlier run that a read found: arm its
	 * timeout from its spec. A lost line in its `stop` stays. The live shell
	 * gives `running` over the line, and a cancel of the table writes over it.
	 * When the shell ends with no `exit`, the line names the end again.
	 */
	const adopt = (agent: string, files: ProcessFiles): void => {
		const { spec, dir } = files;
		if (live.has(spec.handle)) return;
		const process: Live = { agent, spec, dir, grace: spec.grace };
		arm(process);
		live.set(spec.handle, process);
	};

	/**
	 * Write `stop` for a lost process, so later listings run no `ps` for it
	 * while its pid is not in `/proc`. A process is lost when nothing runs it
	 * and its files name no end. The line changes no status. A `ps` that
	 * fails once writes the line for a live shell, and the next read finds
	 * the shell through its pid in `/proc`. A process with no `pid` costs no
	 * `ps`, and its shell can still start, so it gets no line. Best-effort:
	 * the next read tries again.
	 */
	const recordLost = async (env: WorkspaceEnv, { files, status }: Found): Promise<void> => {
		if (status.error !== LOST || files.stop !== undefined || !files.pid) return;
		await writeStop(env, files.dir, lostLine()).catch(() => undefined);
	};

	/**
	 * The status the files give, with the adoption, the end of an adopted
	 * process, and the record of a lost one that it implies. `ours` holds the
	 * processes that this run ran when the read began: a process can end, and
	 * leave `live`, while the listing runs, and its files can then predate its
	 * end.
	 */
	const observe = async (
		agent: string,
		env: WorkspaceEnv,
		files: ProcessFiles,
		ours: ReadonlySet<string>,
	): Promise<Found> => {
		const handle = files.spec.handle;
		const mine = ours.has(handle) || runs(handle);
		const found = { files, status: statusOf(files, mine) };
		await recordLost(env, found);
		// The run of a process with `own` gives its one end, so a read ends an adopted process alone.
		const known = live.get(handle);
		if (found.status.state === 'running') {
			if (!mine) adopt(agent, files);
		} else if (known !== undefined && known.own === undefined) settle(known, found.status);
		return found;
	};

	/** Read the files of `agent` through `env`: every process, or the one process `handle`. */
	const read = async (agent: string, env: WorkspaceEnv, handle?: string): Promise<Found[]> => {
		agents.add(agent);
		const ours = new Set([...live.keys()].filter(runs));
		const found: Found[] = [];
		for (const files of await readFiles(env, await processesDir(env), handle)) {
			found.push(await observe(agent, env, files, ours));
		}
		return found.sort((a, b) => byStart(a.status, b.status));
	};

	const cancels = openCancels({
		live,
		released: () => released,
		detached,
		readOne: (agent, env, handle) => read(agent, env, handle),
	});

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

	// -- the run of a process ---------------------------------------------------

	/**
	 * Run `fn` on the process's own environment, and on a fresh one when that
	 * fails, as after a drop of the connection.
	 */
	const onFiles = <T>(process: Live, own: Own, fn: (env: WorkspaceEnv) => Promise<T>): Promise<T> =>
		fn(own.env).catch(() => detached(process.agent, fn));

	/** The final status of a process of this run, from its files, once the run ended. */
	const finalStatus = async (process: Live, own: Own): Promise<ProcessRecord> => {
		const { dir, spec } = process;
		const root = dir.slice(0, dir.lastIndexOf('/'));
		try {
			const [files] = await onFiles(process, own, (env) => readFiles(env, root, spec.handle));
			return files === undefined ? unreadable(spec, dir, 'no spec') : statusOf(files, false);
		} catch (error) {
			return unreadable(spec, dir, error);
		}
	};

	/** Write the end that a run gives: its exit code, or a `stop` for its error. */
	const writeEnd = (env: WorkspaceEnv, dir: string, run: Run): Promise<void> =>
		'ok' in run && run.ok
			? writeExit(env, dir, run.value.exitCode)
			: writeStop(env, dir, endOfRun(run));

	/**
	 * After the run: when the files name no end, write the one the run gives.
	 * A shell that ended with a code before the wrapper wrote `exit`, as on a
	 * syntax error, gives that code. An error of the run gives `stop`.
	 */
	const recordEnd = async (process: Live, own: Own, run: Run): Promise<void> => {
		if (process.cancelling !== undefined) return;
		await onFiles(process, own, async (env) => {
			const exit = await env.exists(`${process.dir}/exit`, BACKGROUND_CONTEXT);
			if (!exit.ok) throw exit.error;
			if (!exit.value) await writeEnd(env, process.dir, run);
		});
	};

	/**
	 * After the run: record the end the files lack, read the final status, and
	 * tell the host. The process leaves this run's memory after the read, so a
	 * start in between counts it as running and does not remove its files. A
	 * shell that outlived the run, as after a kill it did not obey, becomes
	 * adopted: its record loses `own` and keeps the cause of its cancel. Its one
	 * `ended` event comes when a read sees the end. The environment of the
	 * process closes last.
	 */
	const settleOwned = async (process: Live, own: Own, run: Run): Promise<void> => {
		clearTimeout(process.timer);
		await recordEnd(process, own, run).catch(() => undefined);
		const status = await finalStatus(process, own);
		process.own = undefined;
		if (status.state === 'running') arm(process);
		else settle(process, status);
		await own.env.cleanup().catch(() => undefined);
	};

	const launch = (process: Live, own: Own): void => {
		arm(process, process.spec.timeout * 1000);
		own.ended = runBash(own.env, process.spec, process.dir, own.controller.signal, process.grace)
			.then((run) => settleOwned(process, own, run))
			.catch(() => void live.delete(process.spec.handle));
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
			grace: request.grace,
			...(request.room === undefined ? {} : { room: request.room }),
			startedAt: new Date().toISOString(),
		});
		const dir = await writeSpec(env, await processesDir(env), spec);
		const own: Own = {
			env: await connectOrRemove(agent, env, dir),
			controller: new AbortController(),
			ended: Promise.resolve(),
		};
		const process: Live = { agent: agent.name, spec, dir, grace: spec.grace, own };
		live.set(spec.handle, process);
		launch(process, own);
		const status = statusOf({ dir, spec, seen: false, pid: false, alive: false }, true);
		emit({ type: 'started', process: status });
		return status;
	};

	// -- waits and cancels ------------------------------------------------------

	/** The statuses of `handles`, in their order: one read for one handle, one listing for more. */
	const findAll = async (
		agent: WorkspaceAgent,
		handles: readonly string[],
		signal?: AbortSignal,
	): Promise<readonly ProcessRecord[]> => {
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
		if (handles.length === 0) return [];
		const deadline = Date.now() + seconds * 1000;
		let statuses = await findAll(agent, handles, signal);
		// One race for the whole wait: a process of this run loses `own` only after it ends.
		const owns = handles.flatMap((handle) => live.get(handle)?.own?.ended ?? []);
		const first = owns.length === 0 ? new Promise<void>(() => {}) : Promise.race(owns);
		const polled = owns.length < handles.length;
		while (statuses.every((one) => one.state === 'running') && Date.now() < deadline) {
			const left = deadline - Date.now();
			await within(first, polled ? Math.min(POLL_MS, left) : left, signal);
			statuses = await findAll(agent, handles, signal);
		}
		return statuses;
	};

	const cancel: ProcessTable['cancel'] = async (agent, handle) => {
		const before = await find(agent, handle);
		if (before.state !== 'running') return { status: before, cancelled: false };
		await within(cancels.cancel(agent.name, handle, 'cancelled'), cancelWaitMs(before.grace));
		return { status: await find(agent, handle), cancelled: true };
	};

	/** The agent whose table holds `handle`: from memory, or from the host's list. */
	const ownerOf = async (handle: string): Promise<string | undefined> =>
		live.get(handle)?.agent ??
		(await hostList()).find((process) => process.handle === handle)?.agent;

	const hostCancel: ProcessTable['hostCancel'] = async (handle) => {
		const agent = isHandle(handle) ? await ownerOf(handle) : undefined;
		if (agent === undefined) throw unknown(handle, 'The workspace has');
		return (await cancel({ name: agent }, handle)).status;
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
		await Promise.allSettled(
			[...live.values()].map((one) => cancels.cancel(one.agent, one.spec.handle, 'cancelled')),
		);
		for (const process of live.values()) clearTimeout(process.timer);
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
