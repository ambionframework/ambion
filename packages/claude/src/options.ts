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
	present,
	ROOM_SERVER,
	type StepSink,
} from '@ambionframework/ambion/hosting';
import type {
	CanUseTool,
	Options,
	PermissionResult,
	Settings,
} from '@anthropic-ai/claude-agent-sdk';
import { plainName } from './claude-trace.ts';
import type { ClaudeExecutor } from './define.ts';
import type { SeatHome } from './home.ts';

/** The services a Claude execution brings: where the executable is and what it runs with. */
export interface ClaudeRuntime {
	/** A Claude Code executable to run. Absent, the SDK finds the one it ships with. */
	readonly pathToClaudeCodeExecutable?: string;
	/**
	 * The environment of the executable. Absent, the variables of this process
	 * that `ENV_ALLOWLIST` and `ENV_PREFIXES` name. A value replaces the
	 * environment whole. In both cases the executor removes the variables that
	 * tie the executable to a Claude Code session of the host.
	 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * The directory that holds one Claude config directory for each seat, at
	 * `<configRoot>/<room>/<seat>/config`. Absent, each seat gets a private
	 * directory under the temporary directory, which a restart of the process
	 * loses.
	 */
	readonly configRoot?: string;
}

/**
 * The variables that tie a Claude executable to the Claude Code session of
 * the process that starts it. A host that runs inside Claude Code has them.
 * With `CLAUDE_CODE_SESSION_ID`, or with `CLAUDE_CODE_REMOTE_SESSION_ID` in
 * a remote Claude Code environment, every seat reports the id of the host's
 * session, and a resume opens one transcript for all seats. Claude Code
 * removes most of these names when it starts a fresh session. Without
 * `CLAUDE_CODE_ENTRYPOINT`, the SDK sets it to `sdk-ts`. The two
 * `CLAUDE_CODE_QUESTION_` names are the ones the SDK removes when it gets
 * no `env`.
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
	'CLAUDE_CODE_QUESTION_EXTENDED',
	'CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS',
] as const;

/**
 * The variables of the host that a seat inherits when the host passes no
 * `env`. The executable needs a shell, a path, a home, a locale, a proxy, a
 * certificate store, and a credential.
 */
export const ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TMPDIR',
	'TEMP',
	'TMP',
	'TZ',
	'LANG',
	'TERM',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'SYSTEMROOT',
	'COMSPEC',
	'PATHEXT',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'NODE_EXTRA_CA_CERTS',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** The prefixes of the variables of the host that a seat inherits as well. */
export const ENV_PREFIXES = ['ANTHROPIC_', 'LC_'] as const;

/** Whether the allowlist admits a variable name. */
function allowed(name: string): boolean {
	return (
		(ENV_ALLOWLIST as readonly string[]).includes(name) ||
		ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
	);
}

/** The variables of an environment that the allowlist admits. */
function allowlisted(
	env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(env).filter(([name]) => allowed(name)));
}

/**
 * The environment of a seat's executable. An `env` of the host replaces the
 * environment. Without one, the seat gets the allowlisted variables of this
 * process, and its own `HOME` and `USERPROFILE`, so the shell of the seat
 * reads no rc file of the host user. The seat never holds the variables of a Claude Code session
 * of the host. It gets its own config home, unless `env` names one, and the
 * executable sends no traffic that the work does not need.
 */
function seatEnv(
	env: Readonly<Record<string, string | undefined>> | undefined,
	home: SeatHome,
): Record<string, string | undefined> {
	const seat = env === undefined ? allowlisted(process.env) : { ...env };
	if (env === undefined) {
		seat.HOME = home().home;
		seat.USERPROFILE = seat.HOME;
	}
	for (const name of PARENT_SESSION) delete seat[name];
	if (seat.CLAUDE_CONFIG_DIR === undefined || seat.CLAUDE_CONFIG_DIR === '')
		seat.CLAUDE_CONFIG_DIR = home().config;
	if (seat.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined)
		seat.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
	// The variable holds before any settings tier, so a managed setting cannot turn auto-memory on.
	if (seat.CLAUDE_CODE_DISABLE_AUTO_MEMORY === undefined)
		seat.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
	return seat;
}

/**
 * The settings that the executor passes at the flag tier, so they hold with
 * `settingSources` empty. Auto-memory is off, because a `MEMORY.md` in the
 * config home would be state outside the journal. The attribution text of a
 * commit and of a pull request is empty, and so is the session link, because
 * the room defines what a seat writes.
 */
export const SEAT_SETTINGS = {
	autoMemoryEnabled: false,
	attribution: { commit: '', pr: '', sessionUrl: false },
} as const satisfies Settings;

/**
 * The built-in tools of Claude Code, and the tool of the seat that each one
 * stands for. The map holds the target as a plain name.
 */
export const TOOL_ALIASES = {
	Bash: 'bash',
	Read: 'read',
	Write: 'write',
	Edit: 'edit',
} as const;

/**
 * The aliases for a seat: each built-in name the seat does not hold, mapped
 * to the tool of the seat with the matching name. `names` are the tools of
 * the seat as the SDK knows them. An alias changes the name of a call and
 * leaves its arguments as they are.
 */
export function toolAliases(
	names: readonly string[],
	builtins: readonly string[],
): Record<string, string> {
	const aliases: Record<string, string> = {};
	for (const [builtin, target] of Object.entries(TOOL_ALIASES)) {
		const own = `mcp__${ROOM_SERVER}__${target}`;
		if (names.includes(own) && !builtins.includes(builtin)) aliases[builtin] = own;
	}
	return aliases;
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
	trace: StepSink,
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
	/** The directories of the seat. The options ask for them when they need one. */
	readonly home: SeatHome;
	/** Takes the standard error of the executable. */
	readonly stderr: (data: string) => void;
	/** The session to resume, when the room named one in `spec.resume`. */
	readonly resume?: string;
}

export function queryOptions(input: QueryInput): Options {
	const { executor, runtime } = input;
	// The approver answers for the room tools. A mode that never asks needs them listed.
	const listed = executor.permissionMode === 'dontAsk' ? input.names : [];
	const allowed = [...listed, ...(executor.allowedTools ?? [])];
	const { resume } = input;
	const builtins = builtinNames(executor.allowedTools ?? []);
	const aliases = toolAliases(input.names, builtins);
	// A seat with no built-in tool works in a scratch directory.
	const cwd = executor.cwd ?? (builtins.length === 0 ? input.home().work : undefined);
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
		tools: builtins,
		// An empty list turns the skills off. Without it, the executable lists the skills it finds on disk.
		skills: [],
		settings: SEAT_SETTINGS,
		stderr: input.stderr,
		allowedTools: allowed,
		canUseTool: input.canUseTool,
		...present({
			resume,
			forkSession: resume === undefined ? undefined : false,
			disallowedTools: executor.disallowedTools && [...executor.disallowedTools],
			permissionMode: executor.permissionMode,
			maxBudgetUsd: executor.maxBudgetUsd,
			effort: executor.effort,
			cwd,
			toolAliases: Object.keys(aliases).length === 0 ? undefined : aliases,
			additionalDirectories: executor.additionalDirectories && [...executor.additionalDirectories],
			pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
		}),
		env: seatEnv(runtime.env, input.home),
	};
}
