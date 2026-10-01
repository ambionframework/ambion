import type {
	Context,
	ExecutionEnv,
	ExecutionError,
	Result,
	ShellExecResult,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceExecOptions } from './execution-env.ts';
import type { GitBackend } from './git-backend.ts';
import type { ObjectBackend } from './object-backend.ts';
import type { ResourceBackend, ResourceEnv, WorkspaceAgent } from './resource.ts';
import type { SqlBackend } from './sql-backend.ts';

/**
 * A Pi `ExecutionEnv` whose cleanup the resource owner calls with no
 * context. Its `exec` also takes the grace of a stop.
 */
export interface WorkspaceEnv extends Omit<ExecutionEnv, 'cleanup' | 'exec'>, ResourceEnv {
	exec(
		command: string,
		options: WorkspaceExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>>;
}

/**
 * Where a bash backend keeps the shared records the neutral layer writes:
 * the audit log, the room mirrors, and the snapshots. An audit log path a
 * caller sets wins over the layout's own path.
 */
export interface WorkspaceLayout {
	/** The audit log, when `openWorkspace`'s `audit` option names no path. */
	readonly audit: string;
	/** The directory `mirror()` writes each room's record under. */
	readonly rooms: string;
	/**
	 * The folder of the default object store, when `WorkspaceBackends.objects`
	 * is absent: one file for each digest. The host agent alone writes it.
	 */
	readonly snapshots: string;
}

/** A private HTTP endpoint that reaches a service through a bash backend. */
export interface WorkspaceEndpoint {
	/** The transient HTTP root URL that the workspace host can reach. */
	readonly url: string;
	/** Close the listener and release the backend resources. */
	close(): Promise<void>;
}

/** Optional access to services that run on the machine of a bash backend. */
export interface WorkspaceEndpoints {
	/** The configured machine where workspace commands run. */
	readonly machine: string;
	/** Forward a remote loopback service to a private host loopback listener. */
	forward(
		agent: { readonly name: string },
		port: number,
		signal?: AbortSignal,
	): Promise<WorkspaceEndpoint>;
}

/**
 * The bash backend: a shell over a persistent filesystem, with a home for
 * each agent. The workspace binds its tools over this shell.
 */
export interface BashBackend extends ResourceBackend<WorkspaceEnv> {
	/** One agent's environment. */
	connect(agent: WorkspaceAgent, signal?: AbortSignal): Promise<WorkspaceEnv>;
	/**
	 * The repositories that the shell reaches. The package of the bash
	 * backend takes a git backend of its own type, so `git` of each agent
	 * reaches it. `openWorkspace` opens it under an owner of its own. Absent,
	 * the workspace has no `repos`, `clone` or `fork` tool.
	 */
	readonly git?: GitBackend;
	/** Optional private transport to services on the backend machine. */
	readonly endpoints?: WorkspaceEndpoints;
	/** Guidance for the backend's own shell: its commands, its network, and its isolation. */
	guidance?: string;
	/** Where this backend keeps the audit log, the room mirrors, and the snapshots. */
	readonly layout: WorkspaceLayout;
}

/**
 * The backends of one workspace, by kind. Every workspace has a `bash`
 * backend, and the bash backend carries the optional git backend. `sql` and
 * `objects` are optional.
 */
export interface WorkspaceBackends {
	/** The shell and its filesystem. The file tools, the processes, the audit log, the room mirrors, and the snapshots run on it. */
	readonly bash: BashBackend;
	/** A shared database. Absent, the workspace has no `sql` tool. */
	readonly sql?: SqlBackend;
	/**
	 * Where the bytes of each snapshot live. Absent, the workspace opens a
	 * file store at `layout.snapshots` on the bash backend.
	 */
	readonly objects?: ObjectBackend;
}
