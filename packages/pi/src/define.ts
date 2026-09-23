/**
 * The values you write for a Pi agent: its executor, and its native tools.
 *
 * `pi()` builds the executor an agent definition takes. `fromPiTool` adapts
 * one native Pi tool to the tool the room normalizes.
 */
import type { AgentExecutor, AmbionTool } from '@ambionframework/ambion';
import { defineTool } from '@ambionframework/ambion';
import { type AgentExecutorBaseOptions, describeExecutor } from '@ambionframework/ambion/hosting';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';

export interface PiOptions extends AgentExecutorBaseOptions {
	/** A Pi model identifier, `provider/model-id`. */
	model: string;
}

/**
 * An agent's Pi executor: Pi's agent loop, model, instructions, and tools.
 * Built by `pi()`. The room reads none of the fields Pi adds; the Pi
 * executor does.
 */
export interface PiExecutor extends AgentExecutor {
	readonly kind: 'pi';
	readonly model: string;
}

/** The Pi executor: Pi's agent loop, model, instructions, and tools. */
export function pi(options: PiOptions): PiExecutor {
	return Object.freeze({
		...describeExecutor({ ...options, kind: 'pi' }),
		kind: 'pi' as const,
		model: options.model,
	});
}

/** Adapt one native Pi tool to the normalized Ambion calling convention. */
export function fromPiTool<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
): AmbionTool {
	if (typeof tool !== 'object' || tool === null) throw new Error('Tool options must be an object.');
	const execute = tool.execute;
	return defineTool<TSchema>({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		label: tool.label,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: (params, context) =>
			execute(
				context.callId,
				// defineTool validates the captured schema. Pi can use a different TypeBox version.
				params as Parameters<AgentTool<TParameters, TDetails>['execute']>[1],
				context.signal,
				context.onUpdate,
			),
	});
}
