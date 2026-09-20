import type {
	AgentHarnessTool,
	ExecutionEnv,
	ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import type { ResourceBackend, ResourceEnv } from './resource.ts';

/** A Pi `ExecutionEnv` whose cleanup the resource owner calls with no context. */
export interface WorkspaceEnv extends Omit<ExecutionEnv, 'cleanup'>, ResourceEnv {}

/** A workspace backend that also supplies the tools for the Ambion facade. */
export interface WorkspaceBackend extends ResourceBackend<WorkspaceEnv> {
	/** Backend-owned tools to expose through the workspace's `tools()` method. */
	tools: readonly AgentHarnessTool<ExecutionToolContext>[];
	guidance?: string;
}
