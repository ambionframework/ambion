import {
	type AmbionTool,
	defineTool,
	type ToolBundle,
	type ToolContext,
} from '@ambionframework/ambion';
import type {
	AgentHarnessTool,
	AgentHarnessToolInvocation,
	ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import type { WorkspaceResource } from './resource.ts';

type HarnessTool = AgentHarnessTool<ExecutionToolContext>;

/**
 * A room owns its own idempotency through the journal, so a harness tool over
 * the workspace keeps no durable replay memo: `getMemo` reads nothing and
 * `setMemo` drops its value.
 */
function invocationOf(callId: string): AgentHarnessToolInvocation {
	return {
		invocationId: callId,
		operationId: callId,
		turnId: callId,
		getMemo: async () => undefined,
		setMemo: async () => undefined,
	};
}

/** Bind a Pi harness tool through the owner's whole-operation queue. */
function bindTool(tool: HarnessTool, use: WorkspaceResource['use']): AmbionTool {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.label === undefined ? {} : { label: tool.label }),
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (params, ctx: ToolContext) => {
			const context =
				ctx.signal === undefined
					? BACKGROUND_CONTEXT
					: withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
			return use(
				ctx.agent,
				(env) =>
					tool.execute(
						ctx.callId,
						params,
						ctx.onUpdate ?? (() => undefined),
						{ env },
						invocationOf(ctx.callId),
						context,
					),
				ctx.signal,
			);
		},
	});
}

/** Compose backend tools through the owner's whole-operation queue. */
export function bindTools(
	tools: readonly HarnessTool[],
	use: WorkspaceResource['use'],
	guidance?: string,
): ToolBundle {
	return Object.freeze({
		tools: Object.freeze(tools.map((tool) => bindTool(tool, use))),
		...(guidance === undefined ? {} : { guidance }),
	});
}
