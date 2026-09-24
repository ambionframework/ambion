/**
 * The options one activation passes to the Codex SDK.
 *
 * Only the room defines the seat. The room tools reach Codex as an MCP
 * server that Codex spawns. Its command and its socket path go in the
 * `mcp_servers` config of the client.
 */
import { fileURLToPath } from 'node:url';
import { type AgentExecutor, executorOfKind } from '@ambionframework/ambion/hosting';
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import { exclusiveConfig, NODE_REPL, NODE_REPL_OFF, type Scratch } from './catalog.ts';
import { ROOM_SERVER } from './codex-trace.ts';
import type { CodexExecutor } from './define.ts';

/** The services a Codex execution brings: where the executable is and what it runs with. */
export interface CodexRuntime {
	/** A `codex` executable to run. Absent, the SDK finds the one that `@openai/codex` ships. */
	readonly codexPath?: string;
	/** The environment of the executable. Absent, the environment of this process. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The Codex executor a definition names, or an error that names its kind. */
export function codexOf(executor: AgentExecutor): CodexExecutor {
	return executorOfKind<CodexExecutor>(executor, 'codex');
}

/**
 * The path of the room tools server, beside the module at `from`. Codex
 * runs the server with the Node that runs this process. In the source tree
 * the server is a `.ts` file, and Node strips its types. In the published
 * package the module is a built `.mjs` file, and the server is the built
 * `room-tools-server.mjs` in the same directory.
 */
export function serverPath(from: string | URL = import.meta.url): string {
	const built = new URL(from).pathname.endsWith('.ts') ? 'ts' : 'mjs';
	return fileURLToPath(new URL(`./room-tools-server.${built}`, from));
}

/** The entries of `fields` that hold a value. */
function present<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

/**
 * The options of the thread: the model and the policy the executor names.
 * With a `scratch`, the seat has no native tools. The policy is then fixed:
 * a read-only sandbox, no network, no approval, and an empty directory.
 */
export function threadOptions(executor: CodexExecutor, scratch?: Scratch): ThreadOptions {
	if (scratch !== undefined) {
		return {
			model: executor.model,
			skipGitRepoCheck: true,
			sandboxMode: 'read-only',
			approvalPolicy: 'never',
			networkAccessEnabled: false,
			workingDirectory: scratch.directory,
			...present({ modelReasoningEffort: executor.modelReasoningEffort }),
		};
	}
	return {
		model: executor.model,
		// A room seat runs where the application puts it, which is often no git repository.
		skipGitRepoCheck: true,
		// Codex runs its commands with no sandbox of its own. Isolate such a seat on the host.
		// On Linux the Codex sandbox needs user namespaces, and a host can refuse them.
		sandboxMode: executor.sandboxMode ?? 'danger-full-access',
		...present({
			approvalPolicy: executor.approvalPolicy,
			modelReasoningEffort: executor.modelReasoningEffort,
			networkAccessEnabled: executor.networkAccessEnabled,
			workingDirectory: executor.workingDirectory,
			additionalDirectories: executor.additionalDirectories && [...executor.additionalDirectories],
		}),
	};
}

/**
 * The options of the client for one activation: the executable, its
 * environment, and the room tools server. With a `scratch`, the config also
 * turns off the native tools.
 */
export function clientOptions(
	runtime: CodexRuntime,
	socketPath: string,
	scratch?: Scratch,
): CodexOptions {
	const env =
		runtime.env &&
		Object.fromEntries(
			Object.entries(runtime.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		);
	return {
		...present({ codexPathOverride: runtime.codexPath, env }),
		config: {
			...(scratch === undefined ? {} : exclusiveConfig(scratch.catalog)),
			mcp_servers: {
				...(scratch === undefined ? {} : { [NODE_REPL]: NODE_REPL_OFF }),
				[ROOM_SERVER]: {
					command: process.execPath,
					args: [serverPath(), socketPath],
					// The room tools are the seat's own. Under approvalPolicy 'never', Codex denies an MCP call that needs approval.
					default_tools_approval_mode: 'approve',
					startup_timeout_sec: 30,
					tool_timeout_sec: 600,
				},
			},
		},
	};
}
