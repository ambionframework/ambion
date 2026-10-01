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
	PermanentError,
	present,
	ROOM_SERVER,
} from '@ambionframework/ambion/hosting';
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import { exclusiveConfig, NODE_REPL, NODE_REPL_OFF, type Scratch } from './catalog.ts';
import type { CodexExecutor } from './define.ts';
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
export const HARNESS_NOTE =
	'You are a seat in a room. Your final reply in this thread reaches no one. ' +
	'The room hears only what you send through the `say` tool, so answer with `say`, then stop.';

/**
 * The seat text: the harness note, the mechanism, and the agent part. They
 * are fixed for an activation, so the first pass supplies them.
 */
export function seatText(pass: Pick<Pass, 'mechanism' | 'agent'>): string {
	return `${HARNESS_NOTE}\n\n${pass.mechanism}\n\n${pass.agent}`;
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
 * The config key that carries the seat text. With a `scratch`, the key
 * `model_instructions_file` names the instructions file of the scratch, and
 * the file replaces the base prompt of Codex. Without one, the key
 * `developer_instructions` holds the text and adds a developer message. The
 * base prompt stays, because it teaches the model its native tools.
 */
function instructionConfig(seat: string, scratch?: Scratch): Record<string, string> {
	if (scratch !== undefined) return { model_instructions_file: scratch.instructions };
	// The SDK passes the text as one argument. Linux refuses an argument of 128 KiB or more.
	const bytes = Buffer.byteLength(JSON.stringify(seat));
	if (bytes > DEVELOPER_TEXT_LIMIT) {
		throw new PermanentError(
			`The seat text of a Codex seat with nativeTools 'codex' is ${bytes} bytes. ` +
				`Codex takes it as one command argument, and the limit is ${DEVELOPER_TEXT_LIMIT} bytes. ` +
				'Shorten the instructions of the agent.',
		);
	}
	return { developer_instructions: seat };
}

/** The largest seat text, as a TOML string, that one command argument holds with room to spare. */
export const DEVELOPER_TEXT_LIMIT = 120_000;

/**
 * The options of the client for one activation: the executable, its
 * environment with the Codex home of the seat, the seat text, and the room
 * tools server. With a `scratch`, the config also turns off the native
 * tools.
 */
export function clientOptions(
	execution: CodexExecutionOptions,
	home: SeatHome,
	socketPath: string,
	seat: string,
	scratch?: Scratch,
): CodexOptions {
	return {
		...present({ codexPathOverride: execution.codexPath }),
		env: { ...home.env },
		config: {
			...instructionConfig(seat, scratch),
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
