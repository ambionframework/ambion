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
function bindTool(tool: HarnessTool, use: Workspace['use']): AmbionTool {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.label === undefined ? {} : { label: tool.label }),
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (params, context: ToolContext) =>
			use(
				context.agent,
				(env) => tool.execute(context.callId, params, context.signal, context.onUpdate, { env }),
				context.signal,
			),
	});
}

/** Compose backend tools through the owner's whole-operation queue. */
export function bindTools(
	tools: readonly HarnessTool[],
	use: Workspace['use'],
	guidance?: string,
): ToolBundle {
	return Object.freeze({
		tools: Object.freeze(tools.map((tool) => bindTool(tool, use))),
		...(guidance === undefined ? {} : { guidance }),
	});
}
