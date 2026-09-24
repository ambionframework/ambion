/**
 * The values you write for a Codex agent: its executor and its policy.
 *
 * `codex()` builds the executor an agent definition takes. The room reads
 * none of the fields Codex adds; the Codex executor does.
 */
import type { AgentExecutor } from '@ambionframework/ambion';
import { type AgentExecutorBaseOptions, describeExecutor } from '@ambionframework/ambion/hosting';
import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from '@openai/codex-sdk';

/**
 * What the harness may do. The executor passes each field to the Codex SDK
 * unchanged, except that an absent `sandboxMode` becomes `danger-full-access`.
 */
export interface CodexPolicy {
	/** What a command may touch. Absent, `danger-full-access`: Codex runs no sandbox of its own. */
	readonly sandboxMode?: SandboxMode;
	/** When Codex asks before it acts. A headless run cannot answer, so `never` is the usual choice. */
	readonly approvalPolicy?: ApprovalMode;
	readonly modelReasoningEffort?: ModelReasoningEffort;
	/** Whether a command may use the network. Codex reads it only under `workspace-write`. */
	readonly networkAccessEnabled?: boolean;
	/** The working directory of the harness. */
	readonly workingDirectory?: string;
	/** More directories a command may write. Codex reads them only under `workspace-write`. */
	readonly additionalDirectories?: readonly string[];
}

export interface CodexOptions extends AgentExecutorBaseOptions, CodexPolicy {
	/** A Codex model identifier. */
	model: string;
	/**
	 * The native tools of Codex. `none`, the default, turns off every one: the
	 * seat reaches the world only through the room tools and `tools`. The
	 * executor then sets the sandbox, the approval policy, the network, and
	 * the working directory itself, and ignores those options. `codex` keeps
	 * the native tools of the model and applies the policy options. Under
	 * `codex` a seat with Code Mode reads host files whatever `sandboxMode`
	 * says.
	 */
	nativeTools?: 'none' | 'codex';
}

/** An agent's Codex executor: the Codex SDK loop, model, instructions, tools and policy. */
export interface CodexExecutor extends AgentExecutor, CodexPolicy {
	readonly kind: 'codex';
	readonly model: string;
	readonly nativeTools?: 'none' | 'codex';
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

/**
 * A network setting that Codex would not apply. Codex reads it only under
 * `workspace-write`, and with no sandbox a command has the network.
 */
function checkNetwork(options: CodexOptions): void {
	if (options.nativeTools !== 'codex' || options.networkAccessEnabled === undefined) return;
	if (options.sandboxMode === 'workspace-write') return;
	throw new Error(
		`networkAccessEnabled applies only with sandboxMode 'workspace-write'. ` +
			`Under '${options.sandboxMode ?? 'danger-full-access'}' Codex does not read it.`,
	);
}

/** The Codex executor: the Codex SDK's loop, model, instructions, tools and policy. */
export function codex(options: CodexOptions): CodexExecutor {
	checkNetwork(options);
	return Object.freeze({
		...describeExecutor({ ...options, kind: 'codex' }),
		...policyOf(options),
		kind: 'codex' as const,
		model: options.model,
		nativeTools: options.nativeTools ?? 'none',
	});
}
