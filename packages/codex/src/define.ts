/**
 * The values you write for a Codex agent: its executor and how the model reasons.
 *
 * `codex()` builds the executor an agent definition takes. The room reads
 * none of the fields Codex adds; the Codex executor does.
 */
import type { AgentExecutor } from '@ambionframework/ambion';
import {
	type AgentExecutorBaseOptions,
	describeExecutor,
	pickPresent,
} from '@ambionframework/ambion/hosting';
import type { ModelReasoningEffort } from '@openai/codex-sdk';

/** What Codex asks of the model about its reasoning. Codex shows a summary, never the raw reasoning. */
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface CodexOptions extends AgentExecutorBaseOptions {
	/** A Codex model identifier. */
	model: string;
	/** How much the model reasons before it answers. Absent, Codex uses the default of the model. */
	readonly modelReasoningEffort?: ModelReasoningEffort;
	/**
	 * The reasoning summary that Codex asks of the model. The trace shows it as
	 * `thinking` steps. The default is `auto`. The catalog default of some
	 * models is `none`, and then Codex asks for no summary.
	 */
	reasoningSummary?: ReasoningSummary;
}

/** An agent's Codex executor: the Codex SDK loop, model, instructions, and tools. */
export interface CodexExecutor extends AgentExecutor {
	readonly kind: 'codex';
	readonly model: string;
	readonly modelReasoningEffort?: ModelReasoningEffort;
	readonly reasoningSummary?: ReasoningSummary;
}

/** The Codex executor: the Codex SDK's loop, model, instructions, and tools. */
export function codex(options: CodexOptions): CodexExecutor {
	return Object.freeze({
		...describeExecutor({ ...options, kind: 'codex' }),
		...pickPresent(options, ['modelReasoningEffort']),
		kind: 'codex' as const,
		model: options.model,
		reasoningSummary: options.reasoningSummary ?? 'auto',
	});
}
