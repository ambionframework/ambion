import {
	type AmbionTool,
	defineTool,
	loggedToolResult,
	type ToolContext,
	type ToolResult,
} from '@ambionframework/ambion';
import type {
	AgentHarnessTool,
	AgentHarnessToolInvocation,
	ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import type { AuditEntry, AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import { callEnvelope } from './call-envelope.ts';
import { bestEffort } from './log.ts';
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

/**
 * A failure that keeps the details of its result. The model reads the
 * message as a tool error, and the audit log keeps the details beside it.
 */
export class ToolFailure extends Error {
	override readonly name = 'ToolFailure';
	constructor(
		message: string,
		readonly details: unknown,
	) {
		super(message);
	}
}

/** An error, as the audit log records it. A `ToolFailure` keeps its details. */
function auditError(error: unknown): { name: string; message: string; details?: unknown } {
	if (error instanceof ToolFailure)
		return { name: error.name, message: error.message, details: error.details };
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
	const { agent, room = '', ...placed } = callEnvelope(ctx);
	return {
		time: new Date().toISOString(),
		room,
		agent,
		tool,
		callId: ctx.callId,
		...placed,
		arguments: params,
		...('result' in outcome
			? { result: loggedToolResult(outcome.result) }
			: { error: auditError(outcome.error) }),
	};
}

/** What a call gave: its result, or the error it threw. */
type Outcome = { result: string | ToolResult } | { error: unknown };

/**
 * Run one call. A tool can return at once, return a promise, or throw at
 * once, as `defineTool` does for invalid arguments. Each way has an outcome.
 */
async function outcomeOf(tool: AmbionTool, params: unknown, ctx: ToolContext): Promise<Outcome> {
	try {
		return { result: await tool.invoke(params, ctx) };
	} catch (error) {
		return { error };
	}
}

/**
 * A copy of `tool` that records one audit entry for each call, successful
 * or not. A call with invalid arguments has an entry. The entry runs as one
 * more operation on the bash owner after the call ends, over
 * `BACKGROUND_CONTEXT`, so a cut call still leaves its entry. Another
 * operation can run between the call and its entry. A call that ends after
 * `dispose` starts has no entry: the bash owner refuses the record, and the
 * log's `onError` receives the loss. A failure to record does not replace
 * the result or the error of the call.
 */
export function audited(
	tool: AmbionTool,
	shell: WorkspaceResource<WorkspaceEnv>['use'],
	audit: AuditLog,
): AmbionTool {
	const record = async (params: unknown, ctx: ToolContext, outcome: Outcome): Promise<void> => {
		// A refused record, as after `dispose`, goes to `onError`. It never replaces the call's outcome.
		const lost = (error: Error) =>
			audit.onError?.(
				new Error(
					`The audit entry of the ${tool.name} call ${ctx.callId} was not recorded: ${error.message}`,
					{ cause: error },
				),
			);
		await bestEffort(async () => {
			const entry = auditEntry(tool.name, params, ctx, outcome);
			await shell(ctx.agent, (env) => audit.record(env, entry, BACKGROUND_CONTEXT));
		}, lost);
	};
	return Object.freeze({
		...tool,
		invoke: async (params: unknown, ctx: ToolContext) => {
			const outcome = await outcomeOf(tool, params, ctx);
			await record(params, ctx, outcome);
			if ('error' in outcome) throw outcome.error;
			return outcome.result;
		},
	});
}

/** Bind a Pi harness tool through the owner's whole-operation queue. */
function bindTool(tool: HarnessTool, use: WorkspaceResource<WorkspaceEnv>['use']): AmbionTool {
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

/** Bind Pi harness tools through the owner's whole-operation queue. */
export function bindTools(
	tools: readonly HarnessTool[],
	use: WorkspaceResource<WorkspaceEnv>['use'],
): readonly AmbionTool[] {
	return Object.freeze(tools.map((tool) => bindTool(tool, use)));
}
