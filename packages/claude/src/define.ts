/**
 * The values you write for a Claude agent: its executor and its policy.
 *
 * `claude()` builds the executor an agent definition takes. The room reads
 * none of the fields Claude adds; the Claude executor does.
 */
import type { AgentExecutor, AmbionTool, ToolBundle } from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import type { CanUseTool, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/** What the harness may do. The executor passes each field to the Claude Agent SDK unchanged. */
export interface ClaudePolicy {
	/** The SDK permission mode. Absent uses `default`, where every tool outside `allowedTools` asks. */
	readonly permissionMode?: PermissionMode;
	/** Tools that run with no request. Built-in names and `mcp__` names both count. */
	readonly allowedTools?: readonly string[];
	/** Tools the model never sees. */
	readonly disallowedTools?: readonly string[];
	/**
	 * Answers a permission request. Each request becomes an `approval` step
	 * that carries the answer. Absent, the executor denies every request.
	 */
	readonly canUseTool?: CanUseTool;
	/** The most the activation may spend, in US dollars. */
	readonly maxBudgetUsd?: number;
	readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	/** The working directory of the harness. */
	readonly cwd?: string;
	readonly additionalDirectories?: readonly string[];
}

export interface ClaudeOptions extends ClaudePolicy {
	/** The private half: the agent's own voice, and the home of all judgment. */
	instructions: string;
	/** A Claude model identifier, such as `claude-sonnet-4-5`. */
	model: string;
	/** The agent's own normalized tools. */
	tools?: readonly AmbionTool[];
	/** Composable tool bundles with guidance. Bundles are flattened at definition time. */
	bundles?: readonly ToolBundle[];
	/** The speaking policy. It replaces `DEFAULT_GUIDANCE`. Absent uses the default. */
	speaking?: string;
	/** The token limit for the record one activation reads. Absent reads the whole record. */
	activationTokenLimit?: number;
	/** How the agent counts tokens against its limit. Absent uses a length estimate. */
	estimateTokens?: (text: string) => number;
	/**
	 * What the agent remembers between activations. `activation` opens a
	 * Claude session per activation. `seat` resumes one session per seat and
	 * records its id with each release. Absent means `activation`.
	 */
	memory?: 'activation' | 'seat';
}

/** An agent's Claude executor: the Claude Agent SDK loop, model, instructions, tools and policy. */
export interface ClaudeExecutor extends AgentExecutor, ClaudePolicy {
	readonly kind: 'claude';
	readonly model: string;
	readonly memory?: 'activation' | 'seat';
}

const POLICY = [
	'permissionMode',
	'allowedTools',
	'disallowedTools',
	'canUseTool',
	'maxBudgetUsd',
	'effort',
	'cwd',
	'additionalDirectories',
] as const;

/** The policy fields the caller set. */
function policyOf(options: ClaudePolicy): ClaudePolicy {
	return Object.fromEntries(
		POLICY.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
	);
}

/** The Claude executor: the Claude Agent SDK's loop, model, instructions, tools and policy. */
export function claude(options: ClaudeOptions): ClaudeExecutor {
	return Object.freeze({
		...describeExecutor({ ...options, kind: 'claude' }),
		...policyOf(options),
		kind: 'claude' as const,
		model: options.model,
		...(options.memory === undefined ? {} : { memory: options.memory }),
	});
}
