/**
 * The values you write for a Claude agent: its executor and its policy.
 *
 * `claude()` builds the executor an agent definition takes. The room reads
 * none of the fields Claude adds; the Claude executor does.
 */
import type { Executor } from '@ambionframework/ambion';
import {
	describeExecutor,
	type ExecutorBaseOptions,
	pickPresent,
} from '@ambionframework/ambion/hosting';
import { quickjsEvaluator } from '@ambionframework/compose/runtime';

/**
 * What the harness may spend and how hard it thinks. A Claude seat has no
 * built-in tool, so no field here names a tool, a directory, or a permission.
 * The executor passes each field to the Claude Agent SDK unchanged.
 */
export interface ClaudePolicy {
	/** The most the activation may spend, in US dollars. */
	readonly maxBudgetUsd?: number;
	readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ClaudeOptions extends ExecutorBaseOptions, ClaudePolicy {
	/** A Claude model identifier, such as `claude-sonnet-4-5`. */
	model: string;
}

/** An agent's Claude executor: the Claude Agent SDK loop, model, instructions, tools and policy. */
export interface ClaudeExecutor extends Executor, ClaudePolicy {
	readonly kind: 'claude';
	readonly model: string;
}

const POLICY = ['maxBudgetUsd', 'effort'] as const;

/** The Claude executor: the Claude Agent SDK's loop, model, instructions, tools and policy. */
export function claude(options: ClaudeOptions): ClaudeExecutor {
	return Object.freeze({
		...describeExecutor({
			...options,
			compose: options.compose ?? { evaluator: quickjsEvaluator() },
			kind: 'claude',
		}),
		...pickPresent(options, POLICY),
		kind: 'claude' as const,
		model: options.model,
	});
}
