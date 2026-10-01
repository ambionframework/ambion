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
 * `bash` starts its process as one operation on the bash resource, so a
 * process starts after every earlier operation of the bash resource. The
 * process then runs off the bash resource. Each handle tool reads the end
 * of the output file as one more operation on the bash resource. No tool
 * holds the bash resource while it waits for a process. `docs/processes.md` states the texts.
 */

import {
	type AmbionTool,
	contentText,
	defineTool,
	type ToolContext,
} from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import type { WorkspaceEnv } from './backend.ts';
import type { Capability } from './capability.ts';
import type { ShellOutputTruncation } from './port.ts';
import { DEFAULT_GRACE_SECONDS, PROCESSES_DIR, type ProcessRecord } from './process-files.ts';
import { readOutput } from './process-output.ts';
import { MAX_TIMER_SECONDS } from './process-run.ts';
import type { ProcessTable } from './process-table.ts';
import { deadlineNote, psTable, stateLine } from './process-text.ts';
import type { WorkspaceResource } from './resource.ts';
import { type DetailedResult, ToolFailure } from './tools.ts';
import { DEFAULT_MAX_BYTES, formatSize } from './truncate.ts';

/** Seconds a process may run when `bash` names no timeout. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** Seconds a `bash` call waits for its process when it names no `wait`. */
const DEFAULT_BASH_WAIT_SECONDS = 30;

/** Seconds a `wait` call waits when it names no timeout. */
const DEFAULT_WAIT_SECONDS = 30;

/** The longest one call waits for a process. A longer wait holds the activation open. */
const MAX_WAIT_SECONDS = 600;

/** The most handles one `wait` call takes. */
const MAX_WAIT_HANDLES = 16;

/** Seconds a wait leaves before the room ends the activation, so the agent can still answer. */
const DEADLINE_MARGIN_SECONDS = 30;

/** Seconds before the deadline from which a result points a running process to a scheduled say. */
const SAY_NOTE_SECONDS = 120;

/** A call that did not wait, or whose wait the deadline did not cut. */
const NOT_CUT = { cut: false } as const;

/** The least and the most seconds of the grace of a process. */
const MIN_GRACE_SECONDS = 1;
const MAX_GRACE_SECONDS = 300;

/** What the process tools need from the workspace: the bash resource and the process table. */
export interface ProcessToolOptions {
	readonly bash: WorkspaceResource<WorkspaceEnv>['use'];
	readonly processes: ProcessTable;
}

/** Guidance for the process tools. */
export function processToolGuidance(): string {
	return [
		`bash starts each command as a background process and returns its handle, such as bash-1a2b3c4d5e6f.`,
		`Give a long-running process a name, such as tests or dev-server, so you can tell your processes apart.`,
		`The call waits up to wait seconds, ${DEFAULT_BASH_WAIT_SECONDS} by default, and then gives the state of the process and its output.`,
		`The whole output of a process goes to ${PROCESSES_DIR}/<handle>/out. Read it with read.`,
		`status and cancel take a handle, and wait takes a list of handles. status gives the state of a process,`,
		`wait waits for the first of them to end, and cancel stops one. ps lists your running processes.`,
		`A process keeps running after your activation ends. It stops after timeout seconds, ${DEFAULT_TIMEOUT_SECONDS} by default.`,
		`A stop sends SIGTERM, then SIGKILL after grace seconds, ${DEFAULT_GRACE_SECONDS} by default. Raise grace for a process that must clean up.`,
		`No message tells you when a process ends. When your answer needs the result, call wait before you answer.`,
		`A wait stops before your activation ends.`,
		`A process that outlives your activation shows in the reminder at the start of your next activation.`,
		`To check a long process later, call schedule with delaySeconds. The room wakes you with it then.`,
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
	grace: Type.Optional(
		Type.Number({
			description: `Seconds from SIGTERM to SIGKILL when the workspace stops the process, from ${MIN_GRACE_SECONDS} to ${MAX_GRACE_SECONDS}. The default is ${DEFAULT_GRACE_SECONDS}. A command that traps TERM uses this time to clean up.`,
		}),
	),
});

const psSchema = Type.Object({});

const handleSchema = Type.Object({ handle });

const waitSchema = Type.Object({
	handles: Type.Array(handle, {
		minItems: 1,
		maxItems: MAX_WAIT_HANDLES,
		description: 'The processes to wait for. The call returns when the first of them ends.',
	}),
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
	process: ProcessRecord;
	/** The bytes of the output that the result shows: from the cursor to the end the read saw. */
	read: { from: number; to: number };
	truncation?: ShellOutputTruncation;
}

/** What `wait` on several handles gives in `details`: every status in the order of the handles, and each process it shows. */
export interface WaitDetails {
	processes: readonly ProcessRecord[];
	ended: readonly ProcessDetails[];
}

/** What `ps` gives in `details`. */
export interface PsDetails {
	processes: readonly ProcessRecord[];
}

/** The process capability: the five process tools, their note, and the reminder of the table. */
export function processCapability(options: ProcessToolOptions): Capability {
	return {
		tools: createProcessTools(options),
		notes: [processToolGuidance()],
		remind: options.processes.remind,
	};
}

/** Build the `bash`, `ps`, `status`, `wait` and `cancel` tools over the process table. */
function createProcessTools(options: ProcessToolOptions): readonly AmbionTool[] {
	const table = options.processes;
	return Object.freeze([
		defineTool({
			name: 'bash',
			label: 'bash',
			description: `Start a bash command as a background process in your home directory, and return its handle. The call waits up to wait seconds for the process to end, and gives its state and its combined stdout and stderr. The whole output goes to ${PROCESSES_DIR}/<handle>/out.`,
			parameters: bashSchema,
			execute: (params: BashParams, ctx) => started(options, params, ctx),
		}),
		defineTool({
			name: 'ps',
			label: 'Processes',
			description: 'List your running processes.',
			parameters: psSchema,
			execute: async (_params: object, ctx) => listed(table, ctx),
		}),
		defineTool({
			name: 'status',
			label: 'Process status',
			description:
				'Give the state of a process and its new output: the output after your last result for it.',
			parameters: handleSchema,
			execute: async (params: HandleParams, ctx) => {
				const process = await table.find(ctx.agent, params.handle, ctx.signal);
				const note = deadlineLine(NOT_CUT, process, [process], ctx);
				return failedOr(await described(options, process, ctx, note), [process]);
			},
		}),
		defineTool({
			name: 'wait',
			label: 'Wait for a process',
			description:
				'Wait for the first of your processes in handles to end, up to timeout seconds. Give the state and the new output of each one that ended, and the state of each one that still runs. A process keeps running when the time ends first. A process that has ended makes a wait return at once, so drop its handle from handles.',
			parameters: waitSchema,
			execute: (params: WaitParams, ctx) => waited(options, params, ctx),
		}),
		defineTool({
			name: 'cancel',
			label: 'Cancel a process',
			description:
				'Stop a running process, and give its state and its new output. The stop sends SIGTERM to the process group, and SIGKILL after the grace of the process, 10 seconds by default. A command can trap TERM, clean up, and exit in that time. The call waits for the end up to 15 seconds. A process that has not ended by then still shows running, and the stop goes on.',
			parameters: handleSchema,
			execute: async (params: HandleParams, ctx) => {
				const { status, cancelled } = await table.cancel(ctx.agent, params.handle);
				return cancelResult(await described(options, status, ctx), cancelled);
			},
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

/** The grace of a process: `DEFAULT_GRACE_SECONDS` when the caller names none. */
function checkedGrace(value: number | undefined): number {
	if (value === undefined) return DEFAULT_GRACE_SECONDS;
	if (!Number.isFinite(value) || value < MIN_GRACE_SECONDS || value > MAX_GRACE_SECONDS) {
		throw new Error(
			`Invalid grace: give a number of seconds from ${MIN_GRACE_SECONDS} to ${MAX_GRACE_SECONDS}.`,
		);
	}
	return value;
}

/** The seconds a call waits, and whether the deadline of the activation cut them. */
type WaitWindow = { seconds: number; cut: boolean };

/**
 * The seconds a call may wait: the seconds it asks for, or fewer when the
 * room ends the activation sooner. The wait then ends
 * `DEADLINE_MARGIN_SECONDS` before the deadline.
 */
function withinActivation(asked: number, ctx: ToolContext): WaitWindow {
	if (ctx.deadline === undefined) return { seconds: asked, cut: false };
	const left = Math.max(0, (ctx.deadline - Date.now()) / 1000 - DEADLINE_MARGIN_SECONDS);
	return left < asked ? { seconds: left, cut: true } : { seconds: asked, cut: false };
}

/**
 * Whether a running process can run past the reach of a wait in this
 * activation, and the room would take a `schedule` call: the call runs in an
 * activation of the room.
 */
function outlasts(process: ProcessRecord, ctx: ToolContext): boolean {
	if (process.state !== 'running' || ctx.deadline === undefined) return false;
	const ends = Date.parse(process.startedAt) + process.timeout * 1000;
	return ends > ctx.deadline - DEADLINE_MARGIN_SECONDS * 1000;
}

/**
 * The note near the end of the activation for `running`: the seconds left,
 * the wait that the deadline cut while `cut` still runs, and the scheduled
 * say for each of `running` that outlasts the reach of a wait. The say
 * shows in the last `SAY_NOTE_SECONDS` of the activation.
 */
function deadlineLine(
	wait: { cut: boolean },
	cut: ProcessRecord,
	running: readonly ProcessRecord[],
	ctx: ToolContext,
): string {
	if (ctx.deadline === undefined) return '';
	const left = Math.max(0, Math.round((ctx.deadline - Date.now()) / 1000));
	const near = left <= SAY_NOTE_SECONDS;
	const later = near ? running.filter((one) => outlasts(one, ctx)).map((one) => one.handle) : [];
	return deadlineNote(left, wait.cut && cut.state === 'running', later);
}

/**
 * Start the process, wait up to `wait` seconds, and describe it. A process
 * that ended badly in that time makes the call an error with the same text.
 */
async function started(
	options: ProcessToolOptions,
	params: BashParams,
	ctx: ToolContext,
): Promise<DetailedResult<ProcessDetails>> {
	const timeout = checkedSeconds(params.timeout, DEFAULT_TIMEOUT_SECONDS, MAX_TIMER_SECONDS);
	if (timeout === 0) throw new Error('Invalid timeout: give a number of seconds above 0.');
	const asked = checkedSeconds(params.wait, DEFAULT_BASH_WAIT_SECONDS, MAX_WAIT_SECONDS);
	const spec = {
		command: params.command,
		timeout,
		grace: checkedGrace(params.grace),
		...(params.name === undefined ? {} : { name: params.name }),
		...(ctx.room === undefined ? {} : { room: ctx.room }),
	};
	const process = await options.bash(
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
	const note = deadlineLine(wait, ended, [ended], ctx);
	return failedOr(await described(options, ended, ctx, note), [ended]);
}

/**
 * Wait for the first of the processes in `handles` to end. For one process,
 * the result is the result of `status`. For several, see `waitedOnSeveral`.
 * A handle that repeats counts once.
 */
async function waited(
	options: ProcessToolOptions,
	params: WaitParams,
	ctx: ToolContext,
): Promise<DetailedResult<ProcessDetails | WaitDetails>> {
	const handles = handlesOf(params);
	const asked = checkedSeconds(params.timeout, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);
	const wait = withinActivation(asked, ctx);
	const processes = await options.processes.wait(ctx.agent, handles, wait.seconds, ctx.signal);
	const [first] = processes;
	if (first === undefined) throw new Error('Invalid handles: give at least one handle.');
	if (handles.length === 1) {
		const note = deadlineLine(wait, first, [first], ctx);
		return failedOr(await described(options, first, ctx, note), [first]);
	}
	return waitedOnSeveral(options, processes, first, wait, ctx);
}

/**
 * The result of a wait on several handles: the output of each process that
 * ended, within one budget, then the state line of each one that still
 * runs. A last line names each handle that ended, since a wait that holds it
 * returns at once.
 */
async function waitedOnSeveral(
	options: ProcessToolOptions,
	processes: readonly ProcessRecord[],
	first: ProcessRecord,
	wait: WaitWindow,
	ctx: ToolContext,
): Promise<DetailedResult<WaitDetails>> {
	const ended = processes.filter((process) => process.state !== 'running');
	const running = processes.filter((process) => process.state === 'running');
	const { shown, held } = await describedWithin(options, ended, ctx);
	const note = deadlineLine(ended.length === 0 ? wait : NOT_CUT, first, running, ctx);
	const text = [
		...shown.map(textOf),
		...held.map((process) => `[${stateLine(process)} ${HELD}]`),
		...running.map((process) => `[${stateLine(process)}]`),
		...(ended.length === 0 ? [] : [`[${dropLine(ended)}]`]),
		...(note === '' ? [] : [`[${note}]`]),
	].join('\n\n');
	const result = {
		content: [{ type: 'text' as const, text }],
		details: { processes: [...processes], ended: shown.map((one) => one.details) },
	};
	return failedOr(result, ended);
}

/** The most bytes of text one wait on several handles gives of the output of the processes that ended. */
const WAIT_OUTPUT_BYTES = DEFAULT_MAX_BYTES;

/** What a process that ended says when its output does not fit the result. */
const HELD = 'Its new output did not fit this result: call status with its handle to read it.';

/**
 * Describe the processes that ended, in the order of the handles, until the
 * text holds `WAIT_OUTPUT_BYTES`. Each one adds at most one view of 50 KB, so
 * the text holds at most about twice the budget. A process past the budget is not described, so its
 * cursor stays and a later `status` gives its output.
 */
async function describedWithin(
	options: ProcessToolOptions,
	ended: readonly ProcessRecord[],
	ctx: ToolContext,
): Promise<{ shown: DetailedResult<ProcessDetails>[]; held: ProcessRecord[] }> {
	const shown: DetailedResult<ProcessDetails>[] = [];
	const held: ProcessRecord[] = [];
	let bytes = 0;
	for (const process of ended) {
		if (bytes >= WAIT_OUTPUT_BYTES) {
			held.push(process);
			continue;
		}
		const result = await described(options, process, ctx);
		bytes += new TextEncoder().encode(textOf(result)).length;
		shown.push(result);
	}
	return { shown, held };
}

/** The line that tells the agent to drop each handle that ended from its next wait. */
function dropLine(ended: readonly ProcessRecord[]): string {
	const handles = ended.map((process) => process.handle).join(', ');
	const which = ended.length === 1 ? 'it has ended' : 'they have ended';
	return `Drop ${handles} from handles: ${which}, and a wait that holds one returns at once.`;
}

/**
 * The result of `cancel`. A process that had ended before the cancel leads
 * with a line that says so: the cancel stopped nothing. A process that the
 * cancel ended can read `exited`, when its command ended inside the grace.
 */
function cancelResult(
	result: DetailedResult<ProcessDetails>,
	cancelled: boolean,
): DetailedResult<ProcessDetails> {
	const { process } = result.details;
	if (cancelled || process.state === 'running') return result;
	const lead = `Process ${process.handle} had ended before the cancel, so the cancel stopped nothing.`;
	return { ...result, content: [{ type: 'text', text: `${lead}\n\n${textOf(result)}` }] };
}

/** Whether a process ended badly: a code other than 0, a timeout, or a failure. */
function endedBadly(process: ProcessRecord): boolean {
	return (
		process.state === 'timed_out' ||
		process.state === 'failed' ||
		(process.state === 'exited' && process.exitCode !== 0)
	);
}

/**
 * The result, or an error with its text when a process it reports ended
 * badly. The text holds the output and the state, so the agent can act on it.
 */
function failedOr<D>(
	result: DetailedResult<D>,
	reported: readonly ProcessRecord[],
): DetailedResult<D> {
	if (reported.some(endedBadly)) throw new ToolFailure(textOf(result), result.details);
	return result;
}

/** The handles of a `wait` call, each once. The schema holds the count to 1 to 16. */
function handlesOf(params: WaitParams): readonly string[] {
	return [...new Set(params.handles)];
}

function textOf(result: DetailedResult<unknown>): string {
	return contentText(result.content);
}

/** The `ps` result: the table of the caller's running processes. */
async function listed(table: ProcessTable, ctx: ToolContext): Promise<DetailedResult<PsDetails>> {
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
	process: ProcessRecord,
	ctx: ToolContext,
	note = '',
): Promise<DetailedResult<ProcessDetails>> {
	const dir = process.output.slice(0, process.output.lastIndexOf('/'));
	const read = await options.bash(
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
function bodyOf(output: string, process: ProcessRecord, from: number): string {
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
