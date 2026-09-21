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
import type { WorkspaceBackend, WorkspaceEnv } from './backend.ts';
import type { ChangeLog, WorkspaceChange } from './changes.ts';
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
		...(ctx.activation === undefined ? {} : { activation: ctx.activation }),
		...(ctx.exchange === undefined ? {} : { exchange: ctx.exchange }),
		arguments: params,
		...('result' in outcome ? { result: outcome.result } : { error: auditError(outcome.error) }),
	};
}

/** The change log and the backend's extractor, set together. */
export interface ChangeRecording {
	readonly log: ChangeLog;
	readonly changedPaths: NonNullable<WorkspaceBackend['changedPaths']>;
}

/** Record the paths a successful call changed. A call that changed none leaves no entry. */
async function recordChange(
	recording: ChangeRecording | undefined,
	env: WorkspaceEnv,
	tool: string,
	params: unknown,
	result: unknown,
	ctx: ToolContext,
): Promise<void> {
	if (recording === undefined) return;
	const paths = recording.changedPaths(ctx.agent, tool, params, result);
	if (paths.length === 0) return;
	const entry: WorkspaceChange = {
		time: new Date().toISOString(),
		room: ctx.room ?? '',
		agent: ctx.agent.name,
		tool,
		...(ctx.activation === undefined ? {} : { activation: ctx.activation }),
		...(ctx.exchange === undefined ? {} : { exchange: ctx.exchange }),
		paths,
	};
	await recording.log.record(env, entry, BACKGROUND_CONTEXT);
}

/** Bind a Pi harness tool through the owner's whole-operation queue. */
function bindTool(
	tool: HarnessTool,
	use: WorkspaceResource<WorkspaceEnv>['use'],
	audit?: AuditLog,
	changes?: ChangeRecording,
): AmbionTool {
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
						// The record itself runs over BACKGROUND_CONTEXT, never ctx's own
						// signal: a cut activation must still leave a trace of what it did.
						await audit?.record(
							env,
							auditEntry(tool.name, params, ctx, { result }),
							BACKGROUND_CONTEXT,
						);
						await recordChange(changes, env, tool.name, params, result, ctx);
						return result;
					} catch (error) {
						await audit?.record(
							env,
							auditEntry(tool.name, params, ctx, { error }),
							BACKGROUND_CONTEXT,
						);
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
	use: WorkspaceResource<WorkspaceEnv>['use'],
	guidance?: string,
	audit?: AuditLog,
	changes?: ChangeRecording,
): ToolBundle {
	return Object.freeze({
		tools: Object.freeze(tools.map((tool) => bindTool(tool, use, audit, changes))),
		...(guidance === undefined ? {} : { guidance }),
	});
}
