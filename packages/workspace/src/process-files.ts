/**
 * The processes of one agent, as files in its home: the source of truth
 * for the process table.
 *
 * Each process is a directory, `~/.processes/<handle>/`. The table writes
 * `spec` at the start, `stop` before it stops the process, and `seen` when
 * a result shows the end. The command's wrapper writes `pid`, `out`, and
 * `exit`. The state of a process follows from the files that exist, so a
 * new run of the host reads the same table from the same files.
 *
 * One shell command reads the whole table of an agent, so a read costs one
 * `exec` on every backend. The script uses plain POSIX shell, which the
 * just-bash shell and a real bash both run.
 *
 * `docs/processes.md` is the design contract.
 */

import {
	applyShellOutputUpdate,
	BACKGROUND_CONTEXT,
	type ShellOutputView,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';

/** The kinds of process. A handle starts with its kind. */
export type ProcessKind = 'bash';

/** Where a process is in its life. Every state but `running` is final. */
export type ProcessState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed';

/** What the files of one process say about it. A caller gets a frozen value. */
export interface ProcessStatus {
	/** The key of the process. */
	readonly handle: string;
	/** The label the agent gave the process, when it gave one. */
	readonly name?: string;
	readonly kind: ProcessKind;
	/** The owner agent: the agent whose call started the process. */
	readonly agent: string;
	/** The command as the agent gave it. */
	readonly command: string;
	readonly state: ProcessState;
	/** The absolute path of the file that holds the whole output. */
	readonly output: string;
	/** Seconds the process may run before the table stops it. */
	readonly timeout: number;
	/** The room of the call that started the process, when it had one. Metadata alone. */
	readonly room?: string;
	readonly startedAt: string;
	/** Set when the state is final and the files name the time. */
	readonly endedAt?: string;
	/** Set when the state is `exited`. */
	readonly exitCode?: number;
	/** Set when the state is `failed`. */
	readonly error?: string;
}

/** What `spec` holds: the facts of a process at its start. */
export interface ProcessSpec {
	readonly handle: string;
	readonly name?: string;
	readonly kind: ProcessKind;
	readonly agent: string;
	readonly command: string;
	readonly timeout: number;
	readonly room?: string;
	readonly startedAt: string;
}

/** The directory in each agent's home that holds its processes. */
export const PROCESSES_DIR = '~/.processes';

/** A handle: a kind, a dash, and 12 hex digits. The pattern keeps a handle out of the shell's syntax. */
const HANDLE = /^[a-z]+-[0-9a-f]{12}$/;

/** The error of a process that no run of the host runs now, and that left no end. */
export const LOST = 'The host run ended before the process did.';

/** Why the table stops a process. The first stop names it in `stop`. */
export type StopCause = 'cancelled' | 'timed_out' | 'failed';

/** The files of one process, as the listing reads them. */
export interface ProcessFiles {
	readonly dir: string;
	readonly spec: ProcessSpec;
	/** `<code> <time>`, written by the wrapper when the command ends. */
	readonly exit?: string;
	/** `<cause> <time> [message]`, written by the table before it stops the process. */
	readonly stop?: string;
	/** A result or a reminder showed the end. */
	readonly seen: boolean;
	/** The shell that ran the command still runs it, on a backend that can tell. */
	readonly alive: boolean;
}

/** Whether `handle` has the form of a handle. */
export function isHandle(handle: string): boolean {
	return HANDLE.test(handle);
}

/** Quote one word for `bash`. */
export function quoted(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The absolute directory of the agent's processes. */
export async function processesDir(env: WorkspaceEnv): Promise<string> {
	const dir = await env.absolutePath(PROCESSES_DIR, BACKGROUND_CONTEXT);
	if (!dir.ok) throw dir.error;
	return dir.value;
}

/** Create the directory of a new process and write its `spec`. Returns the directory. */
export async function writeSpec(
	env: WorkspaceEnv,
	root: string,
	spec: ProcessSpec,
): Promise<string> {
	const dir = `${root}/${spec.handle}`;
	const made = await env.createDir(dir, { recursive: true }, BACKGROUND_CONTEXT);
	if (!made.ok) throw made.error;
	const written = await env.writeFile(
		`${dir}/spec`,
		`${JSON.stringify(spec)}\n`,
		BACKGROUND_CONTEXT,
	);
	if (!written.ok) throw written.error;
	const output = await env.writeFile(`${dir}/out`, '', BACKGROUND_CONTEXT);
	if (!output.ok) throw output.error;
	return dir;
}

/**
 * The command with its wrapper. The wrapper writes the shell's pid, runs
 * the command in a subshell with its input from `/dev/null` and its output
 * and errors to `out`, and then writes the exit code and the time to `exit`.
 * A rename makes `exit` whole or absent. The subshell keeps an `exit` in
 * the command from ending the wrapper, and the command stands on lines of
 * its own, so a comment or a here-document at its end does not reach the
 * closing parenthesis.
 */
export function wrapped(command: string, dir: string): string {
	const at = quoted(dir);
	return [
		`echo "$$" > ${at}/pid`,
		`(`,
		command,
		`) < /dev/null > ${at}/out 2>&1`,
		`echo "$? $(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${at}/exit.tmp && mv ${at}/exit.tmp ${at}/exit`,
	].join('\n');
}

/** One line for `stop`: the cause, the time, and an optional message on the same line. */
export function stopLine(cause: StopCause, message?: string): string {
	const at = new Date().toISOString();
	const text = message === undefined ? '' : ` ${message.replace(/\s+/g, ' ').trim()}`;
	return `${cause} ${at}${text}\n`;
}

/** Write `stop` for a process. Best-effort: a failed write leaves the files to name the end. */
export async function writeStop(env: WorkspaceEnv, dir: string, line: string): Promise<void> {
	await env.writeFile(`${dir}/stop`, line, BACKGROUND_CONTEXT);
}

/**
 * Write `exit` for a run whose shell ended before the wrapper wrote it, for
 * example on a syntax error in the command. The code is the shell's own.
 */
export async function writeExit(env: WorkspaceEnv, dir: string, code: number): Promise<void> {
	const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
	await env.writeFile(`${dir}/exit`, `${code} ${at}\n`, BACKGROUND_CONTEXT);
}

/** Write `seen` for a process whose end a result or a reminder showed. Best-effort. */
export async function writeSeen(env: WorkspaceEnv, dir: string): Promise<void> {
	await env.writeFile(`${dir}/seen`, '', BACKGROUND_CONTEXT);
}

/**
 * The script that prints the files of every process under `root`, or of
 * the one process `handle`. It prints one record for each directory with a
 * `spec`, one line for each fact. The liveness check matches the handle in
 * the command line of the pid, so a pid that the system reused for another
 * program does not read as the process.
 */
function listingScript(root: string, handle?: string): string {
	const names = handle === undefined ? '*' : quoted(handle);
	return [
		`cd ${quoted(root)} 2>/dev/null || exit 0`,
		`for h in ${names}; do`,
		`  [ -f "$h/spec" ] || continue`,
		`  echo "P $h"`,
		`  echo "S $(cat "$h/spec")"`,
		`  [ -f "$h/exit" ] && echo "X $(cat "$h/exit")"`,
		`  [ -f "$h/stop" ] && echo "T $(cat "$h/stop")"`,
		`  [ -f "$h/seen" ] && echo "N"`,
		`  if [ ! -f "$h/exit" ] && [ -f "$h/pid" ]; then`,
		`    ps -ww -o args= -p "$(cat "$h/pid")" 2>/dev/null | grep -q -- "$h" && echo "L"`,
		`  fi`,
		`done`,
		`exit 0`,
	].join('\n');
}

/** The most bytes a listing may print. A spec holds the whole command. */
const LISTING_BYTES = 8 * 1024 * 1024;

/** Run a script on `env`, and return what it printed. */
async function printed(env: WorkspaceEnv, script: string, bytes: number): Promise<string> {
	let view: ShellOutputView | undefined;
	const result = await env.exec(
		script,
		{
			capture: { limits: { maxBytes: bytes, maxLines: Number.MAX_SAFE_INTEGER, retain: 'head' } },
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		BACKGROUND_CONTEXT,
	);
	if (!result.ok) throw result.error;
	return view?.text ?? '';
}

/** A spec, or undefined for text that does not parse as one. */
function parseSpec(text: string): ProcessSpec | undefined {
	try {
		const spec: unknown = JSON.parse(text);
		if (typeof spec !== 'object' || spec === null) return undefined;
		const { handle, agent, command, timeout, startedAt } = spec as Record<string, unknown>;
		const valid =
			typeof handle === 'string' &&
			isHandle(handle) &&
			typeof agent === 'string' &&
			typeof command === 'string' &&
			typeof timeout === 'number' &&
			typeof startedAt === 'string';
		return valid ? (spec as ProcessSpec) : undefined;
	} catch {
		return undefined;
	}
}

interface Draft {
	handle: string;
	spec?: ProcessSpec;
	exit?: string;
	stop?: string;
	seen: boolean;
	alive: boolean;
}

/** Fold one line of the listing into the record it belongs to. */
function fold(drafts: Draft[], line: string): void {
	const key = line.slice(0, 1);
	const rest = line.slice(2);
	if (key === 'P') {
		drafts.push({ handle: rest, seen: false, alive: false });
		return;
	}
	const draft = drafts.at(-1);
	if (draft === undefined) return;
	if (key === 'S') draft.spec = parseSpec(rest);
	else if (key === 'X') draft.exit = rest;
	else if (key === 'T') draft.stop = rest;
	else if (key === 'N') draft.seen = true;
	else if (key === 'L') draft.alive = true;
}

/** The files of every process of the agent under `root`, or of the one process `handle`. */
export async function readFiles(
	env: WorkspaceEnv,
	root: string,
	handle?: string,
): Promise<ProcessFiles[]> {
	if (handle !== undefined && !isHandle(handle)) return [];
	const drafts: Draft[] = [];
	for (const line of (await printed(env, listingScript(root, handle), LISTING_BYTES)).split('\n')) {
		fold(drafts, line);
	}
	return drafts.flatMap((draft) =>
		draft.spec === undefined || draft.spec.handle !== draft.handle
			? []
			: [
					{
						dir: `${root}/${draft.handle}`,
						spec: draft.spec,
						seen: draft.seen,
						alive: draft.alive,
						...(draft.exit === undefined ? {} : { exit: draft.exit }),
						...(draft.stop === undefined ? {} : { stop: draft.stop }),
					},
				],
	);
}

type Ending = Pick<ProcessStatus, 'state' | 'endedAt' | 'exitCode' | 'error'>;

/** The end that `stop` names: its cause, its time, and for a failure its message. */
function stopEnding(stop: string): Ending {
	const [cause = '', at, ...message] = stop.split(' ');
	const endedAt = at === undefined || at === '' ? {} : { endedAt: at };
	if (cause === 'cancelled' || cause === 'timed_out') return { state: cause, ...endedAt };
	return { state: 'failed', ...endedAt, error: message.join(' ') || 'The process failed.' };
}

/** The end that `exit` names: the exit code and the time. */
function exitEnding(exit: string): Ending {
	const [code = '', at] = exit.split(' ');
	const exitCode = Number.parseInt(code, 10);
	if (!Number.isSafeInteger(exitCode))
		return { state: 'failed', error: 'The exit record is not a number.' };
	return { state: 'exited', exitCode, ...(at === undefined || at === '' ? {} : { endedAt: at }) };
}

/**
 * The end that the files give. `exit` alone is the end the command chose.
 * `stop` names the cause of a stop, and it wins over `exit`: the table
 * writes it before it aborts. A process whose shell still runs stays
 * `running` until the stop ends it. With no file of an end, the process
 * runs while this run of the host owns it or its shell still runs, and it
 * is lost otherwise.
 */
function endingOf(files: ProcessFiles, live: boolean): Ending {
	if (files.stop === undefined && files.exit !== undefined) return exitEnding(files.exit);
	if (live) return { state: 'running' };
	if (files.stop !== undefined) return stopEnding(files.stop);
	return { state: 'failed', error: LOST };
}

/** The status that the files give. `owned` says that this run of the host runs the process now. */
export function statusOf(files: ProcessFiles, owned: boolean): ProcessStatus {
	const { spec } = files;
	const ending = endingOf(files, owned || files.alive);
	return Object.freeze({
		handle: spec.handle,
		...(spec.name === undefined ? {} : { name: spec.name }),
		kind: spec.kind,
		agent: spec.agent,
		command: spec.command,
		output: `${files.dir}/out`,
		timeout: spec.timeout,
		...(spec.room === undefined ? {} : { room: spec.room }),
		startedAt: spec.startedAt,
		...ending,
	});
}

/**
 * The script that kills the process group of a process that an earlier run
 * of the host started. It checks the pid first, as the listing does. It
 * kills the group only when the group is not the killer's own, so a
 * backend that runs commands in the host's group loses one shell and no
 * more.
 */
function killScript(dir: string, handle: string): string {
	return [
		`pid=$(cat ${quoted(`${dir}/pid`)} 2>/dev/null) || exit 0`,
		`ps -ww -o args= -p "$pid" 2>/dev/null | grep -q -- ${quoted(handle)} || exit 0`,
		`group=$(ps -o pgid= -p "$pid" | tr -d ' ')`,
		`own=$(ps -o pgid= -p "$$" | tr -d ' ')`,
		`if [ -n "$group" ] && [ "$group" != "$own" ]; then kill -KILL -- "-$group"; else kill -KILL "$pid"; fi`,
		`exit 0`,
	].join('\n');
}

/** Run the kill script. Best-effort: a process that ended already leaves nothing to kill. */
export async function killGroup(env: WorkspaceEnv, dir: string, handle: string): Promise<void> {
	await env.exec(killScript(dir, handle), undefined, BACKGROUND_CONTEXT);
}
