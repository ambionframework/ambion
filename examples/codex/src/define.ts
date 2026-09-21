/**
 * The values you write for a Codex agent: its executor and its policy.
 *
 * `codex()` builds the executor an agent definition takes. The room reads
 * none of the fields Codex adds; the Codex executor does.
 */
import type { AgentExecutor, AmbionTool, ToolBundle } from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from '@openai/codex-sdk';

/** What the harness may do. The executor passes each field to the Codex SDK unchanged. */
export interface CodexPolicy {
	/** What a command may touch. Absent uses the Codex default. */
	readonly sandboxMode?: SandboxMode;
	/** When Codex asks before it acts. A headless run cannot answer, so `never` is the usual choice. */
	readonly approvalPolicy?: ApprovalMode;
	readonly modelReasoningEffort?: ModelReasoningEffort;
	readonly networkAccessEnabled?: boolean;
	/** The working directory of the harness. */
	readonly workingDirectory?: string;
	readonly additionalDirectories?: readonly string[];
}

export interface CodexOptions extends CodexPolicy {
	/** The private half: the agent's own voice, and the home of all judgment. */
	instructions: string;
	/** A Codex model identifier. */
	model: string;
	/** The agent's own normalized tools. They reach Codex through the room tools server. */
	tools?: readonly AmbionTool[];
	/** Composable tool bundles with guidance. Bundles are flattened at definition time. */
	bundles?: readonly ToolBundle[];
	/** The speaking policy. It replaces `DEFAULT_GUIDANCE`. Absent uses the default. */
	speaking?: string;
	/** The token limit for the record one activation reads. Absent reads the whole record. */
	activationTokenLimit?: number;
	/** How the agent counts tokens against its limit. Absent uses a length estimate. */
	estimateTokens?: (text: string) => number;
}

/** An agent's Codex executor: the Codex SDK loop, model, instructions, tools and policy. */
export interface CodexExecutor extends AgentExecutor, CodexPolicy {
	readonly kind: 'codex';
	readonly model: string;
}

const POLICY = [
	'sandboxMode',
	'approvalPolicy',
	'modelReasoningEffort',
	'networkAccessEnabled',
	'workingDirectory',
	'additionalDirectories',
] as const;

/** The policy fields the caller set. */
function policyOf(options: CodexPolicy): CodexPolicy {
	return Object.fromEntries(
		POLICY.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
	);
}

/** The Codex executor: the Codex SDK's loop, model, instructions, tools and policy. */
export function codex(options: CodexOptions): CodexExecutor {
	return Object.freeze({
		...describeExecutor({ ...options, kind: 'codex' }),
		...policyOf(options),
		kind: 'codex' as const,
		model: options.model,
	});
}
