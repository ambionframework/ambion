import type {
	AgentHarnessTool,
	ExecutionEnv,
	ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import type { GitAccess, GitBackend } from './git-backend.ts';
import type { ResourceBackend, ResourceEnv, WorkspaceAgent } from './resource.ts';
import type { SqlBackend } from './sql-backend.ts';

/** A Pi `ExecutionEnv` whose cleanup the resource owner calls with no context. */
export interface WorkspaceEnv extends Omit<ExecutionEnv, 'cleanup'>, ResourceEnv {}

/**
 * Where a bash backend keeps the shared records the neutral layer writes:
 * the audit log and the room mirrors. An audit log path a caller sets wins
 * over the layout's own path.
 */
export interface WorkspaceLayout {
	/** The audit log, when `openWorkspace`'s `audit` option names no path. */
	readonly audit: string;
	/** The directory `mirror()` writes each room's record under. */
	readonly rooms: string;
}

/**
 * What the workspace gives a bash backend when it connects: the other
 * backends that the shell reaches. `git` is set when the workspace has a
 * git backend.
 */
export interface BashServices {
	readonly git?: GitAccess;
}

/**
 * The bash backend: a shell over a persistent filesystem, with a home for
 * each agent. It also supplies the tools for the Ambion facade.
 */
export interface BashBackend extends ResourceBackend<WorkspaceEnv> {
	/** One agent's environment. `services` names the other backends that its shell reaches. */
	connect(
		agent: WorkspaceAgent,
		signal?: AbortSignal,
		services?: BashServices,
	): Promise<WorkspaceEnv>;
	/**
	 * Tools the backend adds beyond the tools every workspace already has:
	 * read, write, edit, bash, ps, status, wait and cancel, and sql, repos and
	 * fork when their backends are set. Omit it, or list an empty array,
	 * when the backend adds none of its own.
	 */
	tools?: readonly AgentHarnessTool<ExecutionToolContext>[];
	/** Guidance for the backend's own shell: its commands, its network, and its isolation. */
	guidance?: string;
	/** Where this backend keeps the audit log and the room mirrors. */
	readonly layout: WorkspaceLayout;
}

/**
 * The backends of one workspace, by kind. Every workspace has a `bash`
 * backend. Every other kind is optional.
 */
export interface WorkspaceBackends {
	/** The shell and its filesystem. The file tools, the processes, the audit log, and the room mirrors run on it. */
	readonly bash: BashBackend;
	/** A shared database. Absent, the workspace has no `sql` tool. */
	readonly sql?: SqlBackend;
	/** The repositories. Absent, the workspace has no `repos` and no `fork` tool. */
	readonly git?: GitBackend;
}
