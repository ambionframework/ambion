/**
 * The options one activation passes to the Codex SDK.
 *
 * Only the room defines the seat. The room tools reach Codex as an MCP
 * server that Codex spawns. Its command and its socket path go in the
 * `mcp_servers` config of the client.
 */
import { fileURLToPath } from 'node:url';
import type { AgentExecutor } from '@ambionframework/ambion/hosting';
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
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
	if (executor.kind === 'codex' && 'model' in executor && typeof executor.model === 'string') {
		return executor as CodexExecutor;
	}
	throw new Error(`The Codex executor cannot run an executor of kind '${executor.kind}'.`);
}

/** The room tools server. Codex runs it with the Node that runs this process. */
const SERVER = fileURLToPath(new URL('./room-tools-server.ts', import.meta.url));

/** The entries of `fields` that hold a value. */
function present<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

/** The options of the thread: the model and the policy the executor names. */
export function threadOptions(executor: CodexExecutor): ThreadOptions {
	return {
		model: executor.model,
		// A room seat runs where the application puts it, which is often no git repository.
		skipGitRepoCheck: true,
		...present({
			sandboxMode: executor.sandboxMode,
			approvalPolicy: executor.approvalPolicy,
			modelReasoningEffort: executor.modelReasoningEffort,
			networkAccessEnabled: executor.networkAccessEnabled,
			workingDirectory: executor.workingDirectory,
			additionalDirectories: executor.additionalDirectories && [...executor.additionalDirectories],
		}),
	};
}

/** The options of the client for one activation: the executable, its environment, and the room tools server. */
export function clientOptions(runtime: CodexRuntime, socketPath: string): CodexOptions {
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
			mcp_servers: {
				[ROOM_SERVER]: {
					command: process.execPath,
					args: [SERVER, socketPath],
					startup_timeout_sec: 30,
					tool_timeout_sec: 600,
				},
			},
		},
	};
}
