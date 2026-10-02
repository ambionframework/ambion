/**
 * What one activation passes to `codex app-server`.
 *
 * Only the room defines the seat. The config of the process goes on its
 * command line, one `-c key=value` flag for each leaf. The thread policy and
 * the seat text go in the parameters of `thread/start` and `thread/resume`.
 * The room tools are dynamic tools of the thread, so no server runs beside
 * the process.
 */
import { type Executor, executorOfKind, type Pass, present } from '@ambionframework/ambion/hosting';
import type { Launch } from './app-server.ts';
import { exclusiveConfig, NODE_REPL, NODE_REPL_OFF, type Scratch } from './catalog.ts';
import type { CodexExecutor } from './define.ts';
import type { HomeOptions, SeatHome } from './home.ts';
import type { ThreadParams } from './protocol.ts';

/**
 * The services a Codex execution brings: where the executable is, what it
 * runs with, and the Codex home of its seats.
 */
export interface CodexExecutionOptions extends HomeOptions {
	/** A `codex` executable to run. Absent, the one that `@openai/codex` ships. */
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

/** A string of a TOML value. TOML refuses the DEL character raw, and JSON does not escape it. */
function tomlString(text: string): string {
	return JSON.stringify(text).replaceAll('\u007f', '\\u007f');
}

/** A value of a config key as TOML. */
function toml(value: unknown): string {
	if (typeof value === 'string') return tomlString(value);
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`;
	throw new Error(`The config value ${JSON.stringify(value)} has no TOML form.`);
}

/** A key of a config table. A key with other characters than letters, digits, `_`, and `-` is quoted. */
function tomlKey(key: string): string {
	return /^[\w-]+$/.test(key) ? key : tomlString(key);
}

/** Whether a value is a table: a plain object. */
function isTable(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The flags of one config entry. A table gives one flag for each leaf, and an empty table gives `{}`. */
function flagsOf(path: string, value: unknown): string[] {
	if (!isTable(value)) return ['-c', `${path}=${toml(value)}`];
	const entries = Object.entries(value);
	if (entries.length === 0) return ['-c', `${path}={}`];
	return entries.flatMap(([key, inner]) => flagsOf(`${path}.${tomlKey(key)}`, inner));
}

/** The `-c key=value` flags of a config. A table becomes dotted keys, so a later flag cannot drop a sibling. */
export function configFlags(config: Record<string, unknown>): string[] {
	return Object.entries(config).flatMap(([key, value]) => flagsOf(tomlKey(key), value));
}

/**
 * The config of the process for one activation: the reasoning, the config
 * that turns off the native tools, and the entry that turns off the bundled
 * `node_repl` server. The model comes with the thread, so no key names it.
 */
export function processConfig(executor: CodexExecutor, scratch: Scratch): Record<string, unknown> {
	return {
		...present({ model_reasoning_effort: executor.modelReasoningEffort }),
		model_reasoning_summary: executor.reasoningSummary ?? 'auto',
		...exclusiveConfig(scratch.catalog),
		mcp_servers: { [NODE_REPL]: NODE_REPL_OFF },
	};
}

/**
 * How to start the process for one activation: the executable, the config
 * flags, and the environment with the Codex home of the seat. The `codex`
 * executable is the one that `execution` names, or the one that
 * `@openai/codex` ships.
 */
export function launchOf(
	binary: string,
	home: SeatHome,
	executor: CodexExecutor,
	scratch: Scratch,
): Launch {
	return {
		command: binary,
		args: ['app-server', ...configFlags({ ...processConfig(executor, scratch), ...storeOf(home) })],
		env: { ...home.env },
		cwd: scratch.directory,
	};
}

/** The key of the seat for `account/login/start`, or nothing when the environment holds none. */
export function apiKeyOf(home: SeatHome): string | undefined {
	const key = home.env.CODEX_API_KEY;
	return key === undefined || key === '' ? undefined : key;
}

/**
 * The login store of the process. A seat with `CODEX_API_KEY` logs in with
 * that key, and the ephemeral store keeps the key in memory: Codex writes no
 * `auth.json`. A seat with no key reads the linked `auth.json`.
 */
function storeOf(home: SeatHome): Record<string, unknown> {
	return apiKeyOf(home) === undefined ? {} : { cli_auth_credentials_store: 'ephemeral' };
}

/**
 * The parameters of a thread: the model, the seat text, and the fixed
 * policy. The seat has no native tools, so the sandbox is read-only, Codex
 * asks for no approval, and the working directory is the empty scratch.
 */
export function threadParams(
	executor: CodexExecutor,
	scratch: Scratch,
	seat: string,
): ThreadParams {
	return {
		cwd: scratch.directory,
		sandbox: 'read-only',
		approvalPolicy: 'never',
		model: executor.model,
		baseInstructions: seat,
	};
}
