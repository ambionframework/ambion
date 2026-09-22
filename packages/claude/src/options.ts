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
	/** The environment of the executable. Absent, the environment of this process. */
	readonly env?: Readonly<Record<string, string | undefined>>;
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
	/** The session to resume. Read only when the executor keeps `seat` memory. */
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
	const seat = executor.memory === 'seat';
	const resume = seat ? input.resume : undefined;
	return {
		model: executor.model,
		systemPrompt: input.systemPrompt,
		settingSources: [],
		// The echo of each user message is what advances `readThrough`.
		extraArgs: { 'replay-user-messages': null },
		includePartialMessages: true,
		// `activation` memory keeps no session. `seat` memory persists one and resumes it by id.
		persistSession: seat,
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
			env: runtime.env && { ...runtime.env },
		}),
	};
}
