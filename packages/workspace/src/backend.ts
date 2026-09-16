import type { AgentHarnessTool, ExecutionToolContext } from '@earendil-works/pi-agent-core';
import type { ResourceBackend } from './resource.ts';

/** A workspace backend that also supplies the tools for the Ambion facade. */
export interface WorkspaceBackend extends ResourceBackend {
	/** Backend-owned tools to expose through the workspace's `tools()` method. */
	tools: readonly AgentHarnessTool<ExecutionToolContext>[];
	guidance?: string;
}
