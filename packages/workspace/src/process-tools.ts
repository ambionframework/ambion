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
	formatSize,
	type ShellOutputTruncation,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import { PROCESSES_DIR, type ProcessStatus } from './process-files.ts';
import { readOutput } from './process-output.ts';
import type { ProcessTable } from './process-table.ts';
import { psTable, stateLine } from './process-text.ts';
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

/** The most handles one `wait` call takes. */
const MAX_WAIT_HANDLES = 16;

/** Seconds a wait leaves before the room ends the activation, so the agent can still answer. */
const DEADLINE_MARGIN_SECONDS = 30;

/** The largest timeout a Node timer holds, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

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
		`The call waits up to wait seconds, ${DEFAULT_BASH_WAIT_SECONDS} by default, and then gives the state of the process and its output.`,
		`The whole output of a process goes to ${PROCESSES_DIR}/<handle>/out. Read it with read.`,
		`status, wait and cancel take a handle. status gives the state of the process, wait waits for it to end,`,
		`and cancel stops it. ps lists your running processes.`,
		`A process keeps running after your activation ends. It stops after timeout seconds, ${DEFAULT_TIMEOUT_SECONDS} by default.`,
		`No message tells you when a process ends. When your answer needs the result, call wait before you answer.`,
		`A wait stops before your activation ends.`,
		`A process that outlives your activation shows in the reminder at the start of your next activation.`,
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
	handle: Type.Optional(handle),
	handles: Type.Optional(
		Type.Array(handle, {
			minItems: 1,
			maxItems: MAX_WAIT_HANDLES,
			description:
				'Several handles, in place of handle. The call returns when the first of these processes ends.',
		}),
	),
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
	/** The bytes of the output that the result shows: from the cursor to the end the read saw. */
	read: { from: number; to: number };
	truncation?: ShellOutputTruncation;
}

/** What `wait` with `handles` gives in `details`: every status in the order of the handles, and each process that ended. */
export interface WaitDetails {
	processes: readonly ProcessStatus[];
	ended: readonly ProcessDetails[];
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
			description: `Start a bash command as a background process in your home directory, and return its handle. The call waits up to wait seconds for the process to end, and gives its state and its combined stdout and stderr. The whole output goes to ${PROCESSES_DIR}/<handle>/out.`,
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
			description:
				'Give the state of a process and its new output: the output after your last result for it.',
			parameters: handleSchema,
			execute: recorded('status', async (params: HandleParams, ctx) =>
				described(options, await table.find(ctx.agent, params.handle, ctx.signal), ctx),
			),
		}),
		defineTool({
			name: 'wait',
			label: 'Wait for a process',
			description:
				'Wait for a process to end, up to timeout seconds. Give its state and its new output. The process keeps running when the time ends first. Give handles in place of handle to wait for the first of several processes to end.',
			parameters: waitSchema,
			execute: recorded('wait', (params: WaitParams, ctx) => waited(options, params, ctx)),
		}),
		defineTool({
			name: 'cancel',
			label: 'Cancel a process',
			description:
				'Stop a running process, and give its state and its new output. A process that takes over 10 seconds to stop still shows running.',
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
	const [ended = process] = await options.processes.wait(
		ctx.agent,
		[process.handle],
		wait.seconds,
		ctx.signal,
	);
	const result = await described(options, ended, ctx, cutLine(wait, ended, ctx));
	if (unsuccessful(ended)) throw new Error(textOf(result));
	return result;
}

/**
 * Wait for one process, or for the first of several to end. With
 * `handles`, the result gives the new output of each process that ended,
 * and the state line of each one that still runs. A handle that repeats
 * counts once.
 */
async function waited(
	options: ProcessToolOptions,
	params: WaitParams,
	ctx: ToolContext,
): Promise<AgentToolResult<ProcessDetails | WaitDetails>> {
	const handles = handlesOf(params);
	const asked = checkedSeconds(params.timeout, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
	const wait = withinActivation(asked, ctx);
	const processes = await options.processes.wait(ctx.agent, handles, wait.seconds, ctx.signal);
	const [first] = processes;
	if (first === undefined) throw new Error('Invalid handles: give at least one handle.');
	if (params.handles === undefined)
		return described(options, first, ctx, cutLine(wait, first, ctx));
	const ended: AgentToolResult<ProcessDetails>[] = [];
	for (const process of processes) {
		if (process.state !== 'running') ended.push(await described(options, process, ctx));
	}
	const running = processes.filter((process) => process.state === 'running');
	const note = ended.length === 0 ? cutLine(wait, first, ctx) : '';
	const text = [
		...ended.map(textOf),
		...running.map((process) => `[${stateLine(process)}]`),
		...(note === '' ? [] : [`[${note}]`]),
	].join('\n\n');
	return {
		content: [{ type: 'text', text }],
		details: { processes, ended: ended.map((result) => result.details) },
	};
}

/** The handles of a `wait` call: `handle` or `handles`, one of the two. */
function handlesOf(params: WaitParams): readonly string[] {
	if ((params.handle === undefined) === (params.handles === undefined)) {
		throw new Error('Invalid handles: give handle or handles, and not both.');
	}
	const handles = params.handle === undefined ? [...new Set(params.handles)] : [params.handle];
	if (handles.length === 0 || handles.length > MAX_WAIT_HANDLES) {
		throw new Error(`Invalid handles: give 1 to ${MAX_WAIT_HANDLES} handles.`);
	}
	return handles;
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

/**
 * The output after the cursor, and the line that states the process. The
 * read moves the cursor, so the next result of the agent gives the output
 * after this one.
 */
async function described(
	options: ProcessToolOptions,
	process: ProcessStatus,
	ctx: ToolContext,
	note = '',
): Promise<AgentToolResult<ProcessDetails>> {
	const dir = process.output.slice(0, process.output.lastIndexOf('/'));
	const read = await options.shell(
		ctx.agent,
		async (env) => {
			const output = await readOutput(env, dir);
			await options.processes.markSeen(env, process);
			return output;
		},
		ctx.signal,
	);
	const output = read.text.endsWith('\n') ? read.text.slice(0, -1) : read.text;
	const notes = [
		stateLine(process),
		note,
		output === '' || read.truncation.truncated ? '' : startLine(read.from),
		truncationLine(read.truncation, read.from),
	].filter((line) => line !== '');
	const text = [bodyOf(output, process, read.from), `[${notes.join(' ')}]`]
		.filter((part) => part !== '')
		.join('\n\n');
	const details: ProcessDetails = {
		process,
		read: { from: read.from, to: read.to },
		...(read.truncation.truncated ? { truncation: read.truncation } : {}),
	};
	return { content: [{ type: 'text', text }], details };
}

/**
 * The text before the state line: the new output, or a note for none. A
 * running process that has written nothing yet gives nothing.
 */
function bodyOf(output: string, process: ProcessStatus, from: number): string {
	if (output !== '') return output;
	if (from > 0) return '(no new output)';
	return process.state === 'running' ? '' : '(no output)';
}

/** The note for a result that starts past the start of the output. */
function startLine(from: number): string {
	return from === 0
		? ''
		: `The text above starts at byte ${from} of the output. An earlier result showed the bytes before it.`;
}

/** The note for a view that keeps only the end of the new output: `totalBytes` counts the bytes after `from`. */
function truncationLine(truncation: ShellOutputTruncation, from: number): string {
	if (!truncation.truncated) return '';
	const after = from === 0 ? '' : ` after byte ${from}`;
	return `The text above is the last ${truncation.outputLines} lines, ${formatSize(truncation.outputBytes)} of the ${formatSize(truncation.totalBytes)}${after}.`;
}
