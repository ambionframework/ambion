/**
 * The options one activation passes to the Codex SDK.
 *
 * Only the room defines the seat. The room tools reach Codex as an MCP
 * server that Codex spawns. Its command and its socket path go in the
 * `mcp_servers` config of the client.
 */
import { fileURLToPath } from 'node:url';
import {
	type Executor,
	executorOfKind,
	type Pass,
	present,
	ROOM_SERVER,
} from '@ambionframework/ambion/hosting';
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import { exclusiveConfig, NODE_REPL, NODE_REPL_OFF, type Scratch } from './catalog.ts';
import type { CodexExecutor, ReasoningSummary } from './define.ts';
import type { HomeOptions, SeatHome } from './home.ts';

/**
 * The services a Codex execution brings: where the executable is, what it
 * runs with, and the Codex home of its seats.
 */
export interface CodexExecutionOptions extends HomeOptions {
	/** A `codex` executable to run. Absent, the SDK finds the one that `@openai/codex` ships. */
	readonly codexPath?: string;
}

/**
 * Codex answers in its own final message when a prompt does not say
 * otherwise. The room hears only `say`, so the seat text says so first.
 */
export const SEAT_NOTE =
	'You are a seat in a room. Your final reply in this thread reaches no one. ' +
	'The room hears only what you send through the `say` tool, so answer with `say`, then stop.';

/**
 * The seat text: the harness note, the mechanism, and the agent part. They
 * are fixed for an activation, so the first pass supplies them.
 */
export function seatText(pass: Pick<Pass, 'mechanism' | 'agent'>): string {
	return `${SEAT_NOTE}\n\n${pass.mechanism}\n\n${pass.agent}`;
}

/** The Codex executor a definition names, or an error that names its kind. */
export function codexOf(executor: Executor): CodexExecutor {
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

/**
 * The options of the thread: the model and the fixed policy. The seat has no
 * native tools, so the sandbox is read-only, no command may use the network,
 * Codex asks for no approval, and the working directory is the empty scratch.
 */
export function threadOptions(executor: CodexExecutor, scratch: Scratch): ThreadOptions {
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

/**
 * The options of the client for one activation: the executable, its
 * environment with the Codex home of the seat, the instructions file with the
 * seat text, the reasoning summary, the room tools server, and the config that
 * turns off the native tools.
 */
export function clientOptions(
	execution: CodexExecutionOptions,
	home: SeatHome,
	socketPath: string,
	summary: ReasoningSummary,
	scratch: Scratch,
): CodexOptions {
	return {
		...present({ codexPathOverride: execution.codexPath }),
		env: { ...home.env },
		config: {
			model_instructions_file: scratch.instructions,
			model_reasoning_summary: summary,
			...exclusiveConfig(scratch.catalog),
			mcp_servers: {
				[NODE_REPL]: NODE_REPL_OFF,
				[ROOM_SERVER]: {
					command: process.execPath,
					args: [serverPath(), socketPath],
					// The room tools are the seat's own. Under approvalPolicy 'never', Codex denies an MCP call that needs approval.
					default_tools_approval_mode: 'approve',
					// Codex waits for a required server before the first model request. It waits
					// one second for an optional server, and a loaded host needs more.
					required: true,
					startup_timeout_sec: 30,
					tool_timeout_sec: 600,
				},
			},
		},
	};
}
