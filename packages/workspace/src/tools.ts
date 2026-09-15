import {
	type AmbionTool,
	defineTool,
	type ToolBundle,
	type ToolContext,
} from '@ambionframework/ambion';
import type { AgentHarnessTool, ExecutionToolContext } from '@earendil-works/pi-agent-core';
import type { Workspace } from './resource.ts';

type HarnessTool = AgentHarnessTool<ExecutionToolContext>;

/** Bind a Pi harness tool through the owner's whole-operation queue. */
function bindTool(tool: HarnessTool, workspace: Workspace): AmbionTool {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.label === undefined ? {} : { label: tool.label }),
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (params, context: ToolContext) =>
			workspace.use(
				context.agent,
				(env) => tool.execute(context.callId, params, context.signal, context.onUpdate, { env }),
				context.signal,
			),
	});
}

/** Compose the tools and model guidance provided by a workspace resource. */
export function workspaceTools(workspace: Workspace): ToolBundle {
	return Object.freeze({
		tools: Object.freeze(workspace.toolBundle.tools.map((tool) => bindTool(tool, workspace))),
		...(workspace.toolBundle.guidance === undefined
			? {}
			: { guidance: workspace.toolBundle.guidance }),
	});
}
