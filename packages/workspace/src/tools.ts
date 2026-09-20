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
import type { AuditEntry, AuditLog } from './audit.ts';
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

/** An error, as the audit log records it. */
function auditError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: 'Error', message: String(error) };
}

/** One audit entry for a finished call, successful or not. */
function auditEntry(
	tool: string,
	params: unknown,
	ctx: ToolContext,
	outcome: { result: unknown } | { error: unknown },
): AuditEntry {
	return {
		time: new Date().toISOString(),
		room: ctx.room ?? '',
		agent: ctx.agent.name,
		tool,
		callId: ctx.callId,
		arguments: params,
		...('result' in outcome ? { result: outcome.result } : { error: auditError(outcome.error) }),
	};
}

/** Bind a Pi harness tool through the owner's whole-operation queue. */
function bindTool(tool: HarnessTool, use: WorkspaceResource['use'], audit?: AuditLog): AmbionTool {
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
				async (env) => {
					try {
						const result = await tool.execute(
							ctx.callId,
							params,
							ctx.onUpdate ?? (() => undefined),
							{ env },
							invocationOf(ctx.callId),
							context,
						);
						await audit?.record(env, auditEntry(tool.name, params, ctx, { result }), context);
						return result;
					} catch (error) {
						await audit?.record(env, auditEntry(tool.name, params, ctx, { error }), context);
						throw error;
					}
				},
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
	audit?: AuditLog,
): ToolBundle {
	return Object.freeze({
		tools: Object.freeze(tools.map((tool) => bindTool(tool, use, audit))),
		...(guidance === undefined ? {} : { guidance }),
	});
}
