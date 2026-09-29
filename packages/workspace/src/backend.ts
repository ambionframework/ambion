import type { ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { GitAccess, GitBackend } from './git-backend.ts';
import type { ObjectBackend } from './object-backend.ts';
import type { ResourceBackend, ResourceEnv, WorkspaceAgent } from './resource.ts';
import type { SqlBackend } from './sql-backend.ts';

/** A Pi `ExecutionEnv` whose cleanup the resource owner calls with no context. */
export interface WorkspaceEnv extends Omit<ExecutionEnv, 'cleanup'>, ResourceEnv {}

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

/**
 * What the workspace gives a bash backend when it connects: the other
 * backends that the shell reaches. `git` is set when the workspace has a
 * git backend, and its `transport` is one of the backend's `gitTransports`.
 */
export interface BashServices {
	readonly git?: GitAccess;
}

/**
 * The bash backend: a shell over a persistent filesystem, with a home for
 * each agent. The workspace binds its tools over this shell.
 */
export interface BashBackend extends ResourceBackend<WorkspaceEnv> {
	/** One agent's environment. `services` names the other backends that its shell reaches. */
	connect(
		agent: WorkspaceAgent,
		signal?: AbortSignal,
		services?: BashServices,
	): Promise<WorkspaceEnv>;
	/**
	 * The git transports that the shell of this backend carries, such as
	 * `in-process` or `ssh`. `openWorkspace` refuses a git backend whose
	 * `access.transport` is not in the list. Absent, the backend carries none.
	 */
	readonly gitTransports?: readonly string[];
	/** Guidance for the backend's own shell: its commands, its network, and its isolation. */
	guidance?: string;
	/** Where this backend keeps the audit log, the room mirrors, and the snapshots. */
	readonly layout: WorkspaceLayout;
}

/**
 * The backends of one workspace, by kind. Every workspace has a `bash`
 * backend. Every other kind is optional.
 */
export interface WorkspaceBackends {
	/** The shell and its filesystem. The file tools, the processes, the audit log, the room mirrors, and the snapshots run on it. */
	readonly bash: BashBackend;
	/** A shared database. Absent, the workspace has no `sql` tool. */
	readonly sql?: SqlBackend;
	/** The repositories. Absent, the workspace has no `repos`, `clone` or `fork` tool. */
	readonly git?: GitBackend;
	/**
	 * Where the bytes of each snapshot live. Absent, the workspace opens a
	 * file store at `layout.snapshots` on the bash backend.
	 */
	readonly objects?: ObjectBackend;
}
