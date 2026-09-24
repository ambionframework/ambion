/**
 * The options one activation passes to the Claude Agent SDK.
 *
 * Only the room defines the seat. The query reads no settings source, so no
 * `CLAUDE.md` or settings file on disk reaches the model. The tools are the
 * room tools, the agent's own tools, and the built-in tools the policy names.
 */
import {
	type AgentExecutor,
	executorOfKind,
	type TraceSink,
} from '@ambionframework/ambion/hosting';
import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { plainName, ROOM_SERVER } from './claude-trace.ts';
import type { ClaudeExecutor } from './define.ts';

/** The services a Claude execution brings: where the executable is and what it runs with. */
export interface ClaudeRuntime {
	/** A Claude Code executable to run. Absent, the SDK finds the one it ships with. */
	readonly pathToClaudeCodeExecutable?: string;
	/**
	 * The environment of the executable. Absent, the environment of this
	 * process. The executor removes the variables that tie the executable to
	 * a Claude Code session of the host.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The variables that tie a Claude executable to the Claude Code session of
 * the process that starts it. A host that runs inside Claude Code has them.
 * With `CLAUDE_CODE_SESSION_ID`, or with `CLAUDE_CODE_REMOTE_SESSION_ID` in
 * a remote Claude Code environment, every seat reports the id of the host's
 * session, and a resume opens one transcript for all seats. Claude Code
 * removes most of these names when it starts a fresh session. Without
 * `CLAUDE_CODE_ENTRYPOINT`, the SDK marks the executable as its own.
 */
export const PARENT_SESSION = [
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_REMOTE_SESSION_ID',
	'CLAUDE_CODE_BRIDGE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	'CLAUDE_CODE_SESSION_ATTENDED',
	'CLAUDE_CODE_EXECPATH',
	'CLAUDE_CODE_COORDINATOR_MODE',
	'CLAUDE_CODE_MESSAGING_SOCKET',
	'CLAUDE_CODE_MESSAGING_TOKEN',
	'CLAUDE_CODE_SSE_PORT',
	'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
	'CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS',
	'CLAUDE_CODE_RESUME_PROMPT',
	'CLAUDE_CODE_RESUME_REASON',
	'CLAUDE_CODE_RESUME_SOURCE_ALIVE',
] as const;

/** The environment of a seat's executable: the host's, less the variables of its Claude Code session. */
function seatEnv(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
	const seat = { ...env };
	for (const name of PARENT_SESSION) delete seat[name];
	return seat;
}

/** The Claude executor a definition names, or an error that names its kind. */
export function claudeOf(executor: AgentExecutor): ClaudeExecutor {
	return executorOfKind<ClaudeExecutor>(executor, 'claude');
}

/** The built-in tool names of an allow list: `Bash(git:*)` names `Bash`, and an `mcp__` name names none. */
function builtinNames(allowed: readonly string[]): string[] {
	const names = allowed
		.filter((name) => !name.startsWith('mcp__'))
		.map((name) => name.split('(')[0]);
	return [...new Set(names.filter((name): name is string => name !== undefined && name !== ''))];
}

/**
 * Answers a permission request. A room tool needs no answer. Any other
 * request goes to the application's `canUseTool`, or is denied when the
 * application gave none. The answer becomes an `approval` step.
 */
export function approver(
	executor: ClaudeExecutor,
	trace: TraceSink,
	roomTools: readonly string[],
): CanUseTool {
	return async (name, input, options): Promise<PermissionResult> => {
		if (roomTools.includes(name)) return { behavior: 'allow', updatedInput: input };
		let answer: PermissionResult | null;
		try {
			answer = (await executor.canUseTool?.(name, input, options)) ?? null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			answer = { behavior: 'deny', message };
		}
		const decided: PermissionResult = answer ?? {
			behavior: 'deny',
			message: `The room gives this seat no permission to use ${name}.`,
		};
		trace.record({
			type: 'approval',
			call: options.toolUseID,
			name: plainName(name),
			decision: decided.behavior,
		});
		return decided;
	};
}

/** What the options need beyond the executor's policy. */
export interface QueryInput {
	readonly executor: ClaudeExecutor;
	readonly systemPrompt: string;
	readonly server: NonNullable<Options['mcpServers']>[string];
	/** The names of the room tools, as the SDK knows them. */
	readonly names: readonly string[];
	readonly canUseTool: CanUseTool;
	readonly runtime: ClaudeRuntime;
	/** The session to resume, when the room named one in `spec.resume`. */
	readonly resume?: string;
}

/** The entries of `fields` that hold a value. */
function present<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

export function queryOptions(input: QueryInput): Options {
	const { executor, runtime } = input;
	// The approver answers for the room tools. A mode that never asks needs them listed.
	const listed = executor.permissionMode === 'dontAsk' ? input.names : [];
	const allowed = [...listed, ...(executor.allowedTools ?? [])];
	const { resume } = input;
	return {
		model: executor.model,
		systemPrompt: input.systemPrompt,
		settingSources: [],
		// The echo of each user message is what advances `readThrough`.
		extraArgs: { 'replay-user-messages': null },
		includePartialMessages: true,
		// The session persists on the local disk, so the next activation of the exchange resumes it by id.
		persistSession: true,
		mcpServers: { [ROOM_SERVER]: input.server },
		strictMcpConfig: true,
		tools: builtinNames(executor.allowedTools ?? []),
		allowedTools: allowed,
		canUseTool: input.canUseTool,
		...present({
			resume,
			forkSession: resume === undefined ? undefined : false,
			disallowedTools: executor.disallowedTools && [...executor.disallowedTools],
			permissionMode: executor.permissionMode,
			maxBudgetUsd: executor.maxBudgetUsd,
			effort: executor.effort,
			cwd: executor.cwd,
			additionalDirectories: executor.additionalDirectories && [...executor.additionalDirectories],
			pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
		}),
		env: seatEnv(runtime.env ?? process.env),
	};
}
