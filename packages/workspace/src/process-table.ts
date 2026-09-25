/**
 * The types of the process table: what it runs, what it gives, and what it
 * needs from the workspace. `processes.ts` implements the table.
 */

import type { WorkspaceEnv } from './backend.ts';
import type { ProcessStatus } from './process-files.ts';
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
	 * Wait up to `seconds` for the first of the processes `handles` of
	 * `agent` to end, and return their statuses in the same order. Each
	 * status is `running` when the time ends first. An abort of `signal`
	 * rejects, and the processes keep running.
	 */
	wait(
		agent: WorkspaceAgent,
		handles: readonly string[],
		seconds: number,
		signal?: AbortSignal,
	): Promise<readonly ProcessStatus[]>;
	/** Stop a process of `agent`, and return its status once it ends or the grace ends. */
	cancel(agent: WorkspaceAgent, handle: string): Promise<ProcessStatus>;
	/** Write `seen` for a process in a final state, through `env` on the bash owner. */
	markSeen(env: WorkspaceEnv, process: ProcessStatus): Promise<void>;
	/**
	 * The reminder of one activation: the seat's running processes, and the
	 * finished ones that no result showed. After `signal` aborts, it marks no
	 * process `seen`, and a queued read does not start.
	 */
	remind(
		seat: { agent: string; room: string; activation: string },
		signal: AbortSignal,
	): Promise<string | undefined>;
	/** The host's list: the processes of the agents that used the workspace in this run. */
	hostList(query?: ProcessQuery): Promise<readonly ProcessStatus[]>;
	/** Call `listener` when a process starts and when it ends. Returns the unsubscribe. */
	subscribe(listener: (event: ProcessEvent) => void): () => void;
	/** Stop the process `handle` of any agent of this run: the host's cancel. */
	hostCancel(handle: string): Promise<ProcessStatus>;
	/** Refuse new processes, stop every running process, and wait up to the grace for each one to end. */
	close(): Promise<void>;
}
