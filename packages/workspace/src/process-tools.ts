/**
 * The `bash`, `ps`, `status`, `wait` and `cancel` tools over the process
 * table.
 *
 * `bash` starts every command as a background process and returns its
 * handle. The call waits up to `wait` seconds for the process to end. A
 * process that ends in that time gives its exit code and its output in the
 * same result. A process that runs longer gives its handle, and the agent
 * reaches it again through `status`, `wait` and `cancel`. `ps` lists the
 * running processes. The whole output of a process goes to a file in the
 * agent's home, which `read` reaches.
 *
 * `bash` starts its process as one operation on the bash owner, so a
 * process starts after every earlier operation of the owner. The process
 * then runs off the owner. Each handle tool reads the end of the output
 * file as one more operation on the bash owner. No tool holds the owner
 * while it waits for a process. The audit entry of a call runs on the bash
 * owner after the call ends. `docs/processes.md` states the texts.
 */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import {
	type AgentToolResult,
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type ShellOutputTruncation,
	type ShellOutputView,
	truncateTail,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import { PROCESSES_DIR, type ProcessStatus, quoted } from './process-files.ts';
import { psTable, stateLine } from './process-text.ts';
import type { ProcessTable } from './processes.ts';
import type { WorkspaceResource } from './resource.ts';
import { recordedOnShell } from './tools.ts';

/** Seconds a process may run when `bash` names no timeout. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** Seconds a `bash` call waits for its process when it names no `wait`. */
const DEFAULT_BASH_WAIT_SECONDS = 10;

/** Seconds a `wait` call waits when it names no timeout. */
const DEFAULT_WAIT_SECONDS = 30;

/** The longest one call waits for a process. A longer wait holds the activation open. */
const MAX_WAIT_SECONDS = 600;

/** Seconds a wait leaves before the room ends the activation, so the agent can still answer. */
const DEADLINE_MARGIN_SECONDS = 30;

/** The largest timeout a Node timer holds, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** An output file up to this size is read whole. A larger one is read with `tail`. */
const WHOLE_READ_BYTES = 4 * DEFAULT_MAX_BYTES;

/** The tool names, in the order the tool line of the guidance lists them. */
export const PROCESS_TOOL_NAMES = ['bash', 'ps', 'status', 'wait', 'cancel'] as const;

/** What the process tools need from the workspace: the bash owner, the process table, and the audit log. */
export interface ProcessToolOptions {
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly processes: ProcessTable;
	readonly audit?: AuditLog;
}

/** Guidance for the process tools. */
export function processToolGuidance(): string {
	return [
		`bash starts each command as a background process and returns its handle, such as bash-1a2b3c4d5e6f.`,
		`Give a long-running process a name, such as tests or dev-server, so you can tell your processes apart.`,
		`The call waits up to wait seconds, ${DEFAULT_BASH_WAIT_SECONDS} by default, and then gives the state of the process and the end of its output.`,
		`The whole output of a process goes to ${PROCESSES_DIR}/<handle>/out. Read it with read.`,
		`status, wait and cancel take a handle. status gives the state of the process, wait waits for it to end,`,
		`and cancel stops it. ps lists your running processes.`,
		`A process keeps running after your activation ends. It stops after timeout seconds, ${DEFAULT_TIMEOUT_SECONDS} by default.`,
	].join('\n');
}

const handle = Type.String({
	description: 'The handle that bash returned, such as bash-1a2b3c4d5e6f.',
});

const bashSchema = Type.Object({
	command: Type.String({ description: 'The bash command to run.' }),
	name: Type.Optional(
		Type.String({
			pattern: '^[a-z0-9][a-z0-9._-]{0,39}$',
			description:
				'A short name for the process, such as tests or dev-server: lowercase letters, digits, dot, underscore and dash.',
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds the process may run. The workspace then stops it. The default is ${DEFAULT_TIMEOUT_SECONDS}.`,
		}),
	),
	wait: Type.Optional(
		Type.Number({
			description: `Seconds this call waits for the process to end before it returns. The default is ${DEFAULT_BASH_WAIT_SECONDS}. Set 0 to return at once.`,
		}),
	),
});

const psSchema = Type.Object({});

const handleSchema = Type.Object({ handle });

const waitSchema = Type.Object({
	handle,
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds to wait for the process to end. The default is ${DEFAULT_WAIT_SECONDS}.`,
		}),
	),
});

type BashParams = Static<typeof bashSchema>;
type HandleParams = Static<typeof handleSchema>;
type WaitParams = Static<typeof waitSchema>;

/** What a handle tool gives in `details`. */
export interface ProcessDetails {
	process: ProcessStatus;
	truncation?: ShellOutputTruncation;
}

/** What `ps` gives in `details`. */
export interface PsDetails {
	processes: readonly ProcessStatus[];
}

/** Build the `bash`, `ps`, `status`, `wait` and `cancel` tools over the process table. */
export function createProcessTools(options: ProcessToolOptions): readonly AmbionTool[] {
	const recorded = <P, D>(
		name: string,
		execute: (params: P, ctx: ToolContext) => Promise<AgentToolResult<D>>,
	) => recordedOnShell(name, options.shell, options.audit, execute);
	const table = options.processes;
	return Object.freeze([
		defineTool({
			name: 'bash',
			label: 'bash',
			description: `Start a bash command as a background process in your home directory, and return its handle. The call waits up to wait seconds for the process to end, and gives its state and the end of its combined stdout and stderr. The whole output goes to ${PROCESSES_DIR}/<handle>/out.`,
			parameters: bashSchema,
			execute: recorded('bash', (params: BashParams, ctx) => started(options, params, ctx)),
		}),
		defineTool({
			name: 'ps',
			label: 'Processes',
			description: 'List your running processes.',
			parameters: psSchema,
			execute: recorded('ps', async (_params: object, ctx) => listed(table, ctx)),
		}),
		defineTool({
			name: 'status',
			label: 'Process status',
			description: 'Give the state of a process and the end of its output.',
			parameters: handleSchema,
			execute: recorded('status', async (params: HandleParams, ctx) =>
				described(options, await table.find(ctx.agent, params.handle, ctx.signal), ctx),
			),
		}),
		defineTool({
			name: 'wait',
			label: 'Wait for a process',
			description:
				'Wait for a process to end, up to timeout seconds. Give its state and the end of its output. The process keeps running when the time ends first.',
			parameters: waitSchema,
			execute: recorded('wait', async (params: WaitParams, ctx) => {
				const asked = checkedSeconds(params.timeout, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
				const wait = withinActivation(asked, ctx);
				const process = await table.wait(ctx.agent, params.handle, wait.seconds, ctx.signal);
				return described(options, process, ctx, cutLine(wait, process, ctx));
			}),
		}),
		defineTool({
			name: 'cancel',
			label: 'Cancel a process',
			description:
				'Stop a running process, and give its state and the end of its output. A process that takes over 10 seconds to stop still shows running.',
			parameters: handleSchema,
			execute: recorded('cancel', async (params: HandleParams, ctx) =>
				described(options, await table.cancel(ctx.agent, params.handle), ctx),
			),
		}),
	]);
}

/** A number of seconds from 0 to `max`, or `fallback` when the caller names none. */
function checkedSeconds(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0 || value > max) {
		throw new Error(`Invalid number of seconds: give a number from 0 to ${max}.`);
	}
	return value;
}

/**
 * The seconds a call may wait: the seconds it asks for, or fewer when the
 * room ends the activation sooner. The wait then ends
 * `DEADLINE_MARGIN_SECONDS` before the deadline.
 */
function withinActivation(asked: number, ctx: ToolContext): { seconds: number; cut: boolean } {
	if (ctx.deadline === undefined) return { seconds: asked, cut: false };
	const left = Math.max(0, (ctx.deadline - Date.now()) / 1000 - DEADLINE_MARGIN_SECONDS);
	return left < asked ? { seconds: left, cut: true } : { seconds: asked, cut: false };
}

/** The note for a wait that the deadline of the activation cut, while the process still runs. */
function cutLine(wait: { cut: boolean }, process: ProcessStatus, ctx: ToolContext): string {
	if (!wait.cut || process.state !== 'running' || ctx.deadline === undefined) return '';
	const left = Math.max(0, Math.round((ctx.deadline - Date.now()) / 1000));
	return `The wait stopped early, because your activation ends in ${left} seconds. Answer before then.`;
}

/**
 * Start the process, wait up to `wait` seconds, and describe it. A process
 * that ended in that time with a code other than 0, with a timeout, or with
 * a failure makes the call fail with the same text.
 */
async function started(
	options: ProcessToolOptions,
	params: BashParams,
	ctx: ToolContext,
): Promise<AgentToolResult<ProcessDetails>> {
	const timeout = checkedSeconds(params.timeout, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
	if (timeout === 0) throw new Error('Invalid timeout: give a number of seconds above 0.');
	const asked = checkedSeconds(params.wait, DEFAULT_BASH_WAIT_SECONDS, MAX_WAIT_SECONDS);
	const spec = {
		command: params.command,
		timeout,
		...(params.name === undefined ? {} : { name: params.name }),
		...(ctx.room === undefined ? {} : { room: ctx.room }),
	};
	const process = await options.shell(
		ctx.agent,
		(env) => options.processes.start(ctx.agent, env, spec),
		ctx.signal,
	);
	const wait = withinActivation(asked, ctx);
	const ended = await options.processes.wait(ctx.agent, process.handle, wait.seconds, ctx.signal);
	const result = await described(options, ended, ctx, cutLine(wait, ended, ctx));
	if (unsuccessful(ended)) throw new Error(textOf(result));
	return result;
}

function unsuccessful(process: ProcessStatus): boolean {
	return (
		process.state === 'timed_out' ||
		process.state === 'failed' ||
		(process.state === 'exited' && process.exitCode !== 0)
	);
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** The `ps` result: the table of the caller's running processes. */
async function listed(table: ProcessTable, ctx: ToolContext): Promise<AgentToolResult<PsDetails>> {
	const all = await table.list(ctx.agent, ctx.signal);
	const processes = all.filter((process) => process.state === 'running');
	const text = processes.length > 0 ? psTable(processes, Date.now()) : 'No running processes.';
	return { content: [{ type: 'text', text }], details: { processes } };
}

/** The end of the process's output, and the line that states the process. */
async function described(
	options: ProcessToolOptions,
	process: ProcessStatus,
	ctx: ToolContext,
	note = '',
): Promise<AgentToolResult<ProcessDetails>> {
	const tail = await options.shell(
		ctx.agent,
		async (env) => {
			const read = await outputTail(env, process.output);
			await options.processes.markSeen(env, process);
			return read;
		},
		ctx.signal,
	);
	const output = tail.text.endsWith('\n') ? tail.text.slice(0, -1) : tail.text;
	const body = output === '' && process.state !== 'running' ? '(no output)' : output;
	const notes = [stateLine(process), note, truncationLine(tail.truncation)].filter(
		(line) => line !== '',
	);
	const text = [body, `[${notes.join(' ')}]`].filter((part) => part !== '').join('\n\n');
	const details: ProcessDetails = tail.truncation.truncated
		? { process, truncation: tail.truncation }
		: { process };
	return { content: [{ type: 'text', text }], details };
}

function truncationLine(truncation: ShellOutputTruncation): string {
	if (!truncation.truncated) return '';
	return `The text above is the last ${truncation.outputLines} lines, ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}.`;
}

/**
 * The end of an output file, bounded to Pi's default view: 2000 lines or
 * 50 KB. A file that does not exist yet reads as empty. A file over four
 * times the byte limit is read with `tail`, so a large output does not
 * reach the host whole.
 */
async function outputTail(
	env: WorkspaceEnv,
	path: string,
): Promise<{ text: string; truncation: ShellOutputTruncation }> {
	const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
	const size = info.ok ? info.value.size : 0;
	const text = size > WHOLE_READ_BYTES ? await tailOf(env, path) : await wholeOf(env, path);
	const { content, ...truncation } = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return {
		text: content,
		truncation: {
			...truncation,
			truncated: truncation.truncated || size > WHOLE_READ_BYTES,
			totalBytes: Math.max(truncation.totalBytes, size),
		},
	};
}

async function wholeOf(env: WorkspaceEnv, path: string): Promise<string> {
	const read = await env.readTextFile(path, BACKGROUND_CONTEXT);
	return read.ok ? read.value : '';
}

async function tailOf(env: WorkspaceEnv, path: string): Promise<string> {
	let view: ShellOutputView | undefined;
	await env.exec(
		// just-bash's tail refuses `--`. The path is absolute, so it cannot read as an option.
		`tail -c ${DEFAULT_MAX_BYTES} ${quoted(path)}`,
		{
			capture: { limits: { maxBytes: 2 * DEFAULT_MAX_BYTES, maxLines: 2 * DEFAULT_MAX_LINES } },
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		BACKGROUND_CONTEXT,
	);
	return view?.text ?? '';
}
