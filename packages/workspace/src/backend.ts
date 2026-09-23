import type {
	AgentHarnessTool,
	ExecutionEnv,
	ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import type { ResourceBackend, ResourceEnv } from './resource.ts';

/** A Pi `ExecutionEnv` whose cleanup the resource owner calls with no context. */
export interface WorkspaceEnv extends Omit<ExecutionEnv, 'cleanup'>, ResourceEnv {}

/**
 * Where a backend keeps the shared records the neutral layer writes: the
 * audit log, the shared database, and the room mirrors. Each path is a
 * default: an audit log path a caller sets, or a database a `sql` call
 * names, wins over the layout's own path.
 */
export interface WorkspaceLayout {
	/** The audit log, when `openWorkspace`'s `audit` option names no path. */
	readonly audit: string;
	/** The database the `sql` tool opens, when a call names no `database`. */
	readonly database: string;
	/** The directory `mirror()` writes each room's record under. */
	readonly rooms: string;
}

/** A workspace backend that also supplies the tools for the Ambion facade. */
export interface WorkspaceBackend extends ResourceBackend<WorkspaceEnv> {
	/** Backend-owned tools to expose through the workspace's `tools()` method. */
	tools: readonly AgentHarnessTool<ExecutionToolContext>[];
	guidance?: string;
	/** Where this backend keeps the audit log, the shared database, and the room mirrors. */
	readonly layout: WorkspaceLayout;
}
