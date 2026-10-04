/**
 * The processes of one agent, as files in its home: the source of truth
 * for the process table.
 *
 * Each process is a directory, `~/.processes/<handle>/`. The table writes
 * `spec` at the start, `stop` before it cancels the process, and `seen` when
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

import type { WorkspaceEnv } from './backend.ts';
import { runScript, shellQuote } from './execution-env.ts';

/** The kinds of process. A handle starts with its kind. */
export type ProcessKind = 'bash';

/** Where a process is in its life. Every state but `running` is final. */
export type ProcessState = 'running' | 'exited' | 'timed_out' | 'cancelled' | 'failed';

/** What the files of one process say about it. A caller gets a frozen value. */
export interface Process {
	/** The key of the process. */
	readonly handle: string;
	/** The label the agent gave the process, when it gave one. */
	readonly name?: string;
	readonly kind: ProcessKind;
	/** The owner agent: the agent whose call started the process. */
	readonly agent: string;
	/** The command as the agent gave it. */
	readonly command: string;
	/** The port that the workspace set in `$PORT` for the command. Zero for a spec written before ports. */
	readonly port: number;
	readonly state: ProcessState;
	/** The absolute path of the file that holds the whole output. */
	readonly output: string;
	/** Seconds the process may run before the table cancels it. */
	readonly timeout: number;
	/** Seconds from `SIGTERM` to `SIGKILL` when the table cancels the process. */
	readonly grace: number;
	/** The room of the call that started the process, when it had one. Metadata alone. */
	readonly room?: string;
	readonly startedAt: string;
	/** Set when the state is final and the files name the time of the end. */
	readonly endedAt?: string;
	/** Set when the state is `exited`. */
	readonly exitCode?: number;
	/** Set when the state is `failed`. */
	readonly error?: string;
	/** True while the state is `running` and a cancel of the table waits for the end. */
	readonly stopping?: boolean;
}

/** What `spec` holds: the facts of a process at its start. */
export interface ProcessSpec {
	readonly handle: string;
	readonly name?: string;
	readonly kind: ProcessKind;
	readonly agent: string;
	readonly command: string;
	/** The port that the workspace sets in `$PORT` for the command. */
	readonly port: number;
	readonly timeout: number;
	/** Seconds from `SIGTERM` to `SIGKILL` when the table cancels the process. */
	readonly grace: number;
	readonly room?: string;
	readonly startedAt: string;
}

/** The grace of a `bash` call that names none. */
export const DEFAULT_GRACE_SECONDS = 10;

/** The directory in each agent's home that holds its processes. */
export const PROCESSES_DIR = '~/.processes';

/** A handle: a kind, a dash, and 12 hex digits. The pattern keeps a handle out of the shell's syntax. */
const HANDLE = /^[a-z]+-[0-9a-f]{12}$/;

/** The error of a process that no run of the host runs now, and that left no end. */
export const LOST = 'The host run ended before the process did.';

/** Why the table cancels a process. The first cancel names it in `stop`. */
export type CancelCause = 'cancelled' | 'timed_out' | 'failed';

/** The files of one process, as the listing reads them. */
export interface ProcessFiles {
	readonly dir: string;
	readonly spec: ProcessSpec;
	/** `<code> <time>`, written by the wrapper when the command ends. */
	readonly exit?: string;
	/** `<cause> <time> [message]`, written by the table before it cancels the process. */
	readonly stop?: string;
	/** A result or a reminder showed the end. */
	readonly seen: boolean;
	/** The wrapper wrote `pid`: a shell started the command. */
	readonly pid: boolean;
	/** The shell that ran the command still runs it, on a backend that can tell. */
	readonly alive: boolean;
}

/** Whether `handle` has the form of a handle. */
export function isHandle(handle: string): boolean {
	return HANDLE.test(handle);
}

/** The absolute directory of the agent's processes. */
export async function processesDir(env: WorkspaceEnv): Promise<string> {
	const dir = await env.absolutePath(PROCESSES_DIR);
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
	const made = await env.createDir(dir, { recursive: true });
	if (!made.ok) throw made.error;
	const written = await env.writeFile(`${dir}/spec`, `${JSON.stringify(spec)}\n`);
	if (!written.ok) throw written.error;
	const output = await env.writeFile(`${dir}/out`, '');
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
 *
 * `trap : TERM` keeps the wrapper alive through the `SIGTERM` of a cancel, so
 * it writes `exit` when the command ends inside the grace. The handler
 * resets to the default in each program that the command runs, so each
 * program gets the signal as usual. An ignored signal stays ignored in each
 * program, so the wrapper does not ignore `TERM`. just-bash has no `trap`,
 * and the redirect hides its error.
 *
 * The subshell traps `TERM` with `exit $?`. A shell that forks the last
 * program of a list, as bash 3.2 on macOS does, then waits for that program
 * and ends with its code. Without the trap, the `SIGTERM` ends the subshell
 * with code 143 before a program that ends cleanly inside the grace. A
 * command that runs no program when the signal arrives ends with the code
 * of its last command, and `stop` alone records the cancel.
 */
export function wrapped(command: string, dir: string): string {
	const at = shellQuote(dir);
	return [
		'trap : TERM 2>/dev/null',
		`echo "$$" > ${at}/pid`,
		`(`,
		`trap 'exit $?' TERM 2>/dev/null`,
		command,
		`) < /dev/null > ${at}/out 2>&1`,
		`echo "$? $(date -u +%Y-%m-%dT%H:%M:%SZ)" > ${at}/exit.tmp && mv ${at}/exit.tmp ${at}/exit`,
	].join('\n');
}

/** One line for `stop`: the cause, the time, and an optional message on the same line. */
export function stopLine(cause: CancelCause, message?: string): string {
	const at = new Date().toISOString();
	const text = message === undefined ? '' : ` ${message.replace(/\s+/g, ' ').trim()}`;
	return `${cause} ${at}${text}\n`;
}

/**
 * The `stop` line for a lost process. The first read that finds the process
 * lost with a `pid` writes it. The listing runs no `ps` for a process with
 * this line while its pid is not in `/proc`.
 */
export function lostLine(): string {
	return stopLine('failed', LOST);
}

/**
 * Write `stop` for a process that has no `exit`. One shell command checks
 * and writes, so a cancel that meets the natural end of the command leaves
 * the end as the command gave it.
 */
export async function writeStop(env: WorkspaceEnv, dir: string, line: string): Promise<void> {
	const at = shellQuote(dir);
	const script = `[ -f ${at}/exit ] || printf '%s' ${shellQuote(line)} > ${at}/stop`;
	const result = await env.exec(script, undefined);
	if (!result.ok) throw result.error;
}

/**
 * Write `exit` for a run whose shell ended before the wrapper wrote it, for
 * example on a syntax error in the command. The code is the shell's own.
 */
export async function writeExit(env: WorkspaceEnv, dir: string, code: number): Promise<void> {
	const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
	await env.writeFile(`${dir}/exit`, `${code} ${at}\n`);
}

/** Write `seen` for a process whose end a result or a reminder showed. Best-effort. */
export async function writeSeen(env: WorkspaceEnv, dir: string): Promise<void> {
	await env.writeFile(`${dir}/seen`, 'seen\n');
}

/**
 * The script that prints the files of every process under `root`, or of
 * the one process `handle`. It prints one line for each fact, as
 * `<handle>/<fact>:<text>`. One `find` hands every small file to one
 * `grep`, and `/dev/null` makes `grep` print each file name. A glob or a
 * test for each directory costs a command each on just-bash, so the script
 * uses none for a finished process. The liveness check runs only where
 * `ps` exists. It matches the handle in the command line of the pid, so a
 * pid that the system reused for another program does not read as the
 * process. It skips a process whose `stop` names it lost and whose pid is
 * not in `/proc`. Shell builtins read the line and test the directory, so
 * the skip starts no program. A pid still in `/proc` gets the `ps` check,
 * so a line that a failed `ps` wrote for a live shell does not hide it. On
 * a system with no `/proc`, no pid has a directory there, so the line
 * alone skips the process.
 */
function listingScript(root: string, handle?: string): string {
	const from = handle === undefined ? '. -mindepth 2' : shellQuote(handle);
	const names = handle === undefined ? '*' : shellQuote(handle);
	return [
		`cd ${shellQuote(root)} 2>/dev/null || exit 0`,
		`find ${from} -maxdepth ${handle === undefined ? 2 : 1} -type f \\( -name spec -o -name exit -o -name stop -o -name seen -o -name pid \\) -exec grep '' /dev/null {} + 2>/dev/null`,
		`command -v ps >/dev/null 2>&1 || exit 0`,
		`for f in ${names}/pid; do`,
		`  h="\${f%/pid}"`,
		`  [ -f "$f" ] && [ ! -f "$h/exit" ] || continue`,
		`  [ -f "$h/stop" ] && read -r c t m 2>/dev/null < "$h/stop" && [ "$c $m" = ${shellQuote(`failed ${LOST}`)} ] && read -r p 2>/dev/null < "$f" && [ ! -d "/proc/$p" ] && continue`,
		`  ps -ww -o args= -p "$(cat "$f")" 2>/dev/null | grep -q -- "$h" && echo "$h/alive:"`,
		`done`,
		`exit 0`,
	].join('\n');
}

/** The most bytes a listing may print. A spec holds the whole command. */
const LISTING_BYTES = 8 * 1024 * 1024;

/** Run a script on `env`, and return what it printed. */
async function printed(env: WorkspaceEnv, script: string, bytes: number): Promise<string> {
	const result = await runScript(env, script, {
		capture: { limits: { maxBytes: bytes, maxLines: Number.MAX_SAFE_INTEGER, retain: 'head' } },
	});
	if (!result.ok) throw result.error;
	return result.value.output;
}

/** A spec, or undefined for text that does not parse as one. */
function parseSpec(text: string): ProcessSpec | undefined {
	try {
		const spec: unknown = JSON.parse(text);
		if (typeof spec !== 'object' || spec === null) return undefined;
		const { handle, agent, command, timeout, startedAt, grace } = spec as Record<string, unknown>;
		const valid =
			typeof handle === 'string' &&
			isHandle(handle) &&
			typeof agent === 'string' &&
			typeof command === 'string' &&
			typeof timeout === 'number' &&
			typeof startedAt === 'string' &&
			typeof grace === 'number';
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
	pid: boolean;
	alive: boolean;
}

/** Fold one line of the listing into the record of its handle. */
function fold(drafts: Map<string, Draft>, text: string): void {
	const line = text.startsWith('./') ? text.slice(2) : text;
	const colon = line.indexOf(':');
	const slash = line.indexOf('/');
	if (colon < 0 || slash < 0 || slash > colon) return;
	const handle = line.slice(0, slash);
	if (!isHandle(handle)) return;
	const fact = line.slice(slash + 1, colon);
	const rest = line.slice(colon + 1);
	const draft = drafts.get(handle) ?? { handle, seen: false, pid: false, alive: false };
	drafts.set(handle, draft);
	record(draft, fact, rest);
}

/** Record one fact of a process in its draft. */
function record(draft: Draft, fact: string, text: string): void {
	switch (fact) {
		case 'spec':
			draft.spec = parseSpec(text);
			break;
		case 'exit':
			draft.exit = text;
			break;
		case 'stop':
			draft.stop = text;
			break;
		case 'seen':
		case 'pid':
		case 'alive':
			draft[fact] = true;
			break;
	}
}

/** The files of every process of the agent under `root`, or of the one process `handle`. */
export async function readFiles(
	env: WorkspaceEnv,
	root: string,
	handle?: string,
): Promise<ProcessFiles[]> {
	if (handle !== undefined && !isHandle(handle)) return [];
	const drafts = new Map<string, Draft>();
	for (const line of (await printed(env, listingScript(root, handle), LISTING_BYTES)).split('\n')) {
		fold(drafts, line);
	}
	return [...drafts.values()].flatMap((draft) =>
		draft.spec === undefined || draft.spec.handle !== draft.handle
			? []
			: [
					{
						dir: `${root}/${draft.handle}`,
						spec: draft.spec,
						seen: draft.seen,
						pid: draft.pid,
						alive: draft.alive,
						...(draft.exit === undefined ? {} : { exit: draft.exit }),
						...(draft.stop === undefined ? {} : { stop: draft.stop }),
					},
				],
	);
}

type Ending = Pick<Process, 'state' | 'endedAt' | 'exitCode' | 'error' | 'stopping'>;

/**
 * The end that `stop` names: its cause, its time, and for a failure its
 * message. The time of a lost process names the read that found it lost,
 * and no end, so its status has no `endedAt`.
 */
function stopEnding(stop: string): Ending {
	const [cause = '', at, ...message] = stop.split(' ');
	const error = message.join(' ');
	if (error === LOST) return { state: 'failed', error };
	const endedAt = at === undefined || at === '' ? {} : { endedAt: at };
	if (cause === 'cancelled' || cause === 'timed_out') return { state: cause, ...endedAt };
	return { state: 'failed', ...endedAt, error: error || 'The process failed.' };
}

/**
 * A process that still runs. A `stop` that names a cancel or a timeout
 * means that the table cancelled the process. A `failed` line, from a run
 * that broke or from a read that found the process lost, names no cancel.
 */
function runningEnding(stop: string | undefined): Ending {
	const state = stop === undefined ? undefined : stopEnding(stop).state;
	const stopping = state === 'cancelled' || state === 'timed_out';
	return stopping ? { state: 'running', stopping } : { state: 'running' };
}

/** The exit code of a shell that `SIGTERM` ended: 128 + 15. */
const TERM_EXIT = 143;

/** The end that `exit` names: the exit code and the time. */
function exitEnding(exit: string): Ending {
	const [code = '', at] = exit.split(' ');
	const exitCode = Number.parseInt(code, 10);
	if (!Number.isSafeInteger(exitCode))
		return { state: 'failed', error: 'The exit record is not a number.' };
	return { state: 'exited', exitCode, ...(at === undefined || at === '' ? {} : { endedAt: at }) };
}

/**
 * The end that `exit` names, after a cancel of the table when `stop` names
 * one. The wrapper outlives the `SIGTERM` of a cancel and writes the code of
 * the command. Code 143 is the code of a command that the `SIGTERM` ended,
 * so the cause in `stop` names that end. Every other code is the end that
 * the command chose inside the grace.
 */
function exitedEnding(exit: string, stop: string | undefined): Ending {
	const ending = exitEnding(exit);
	if (ending.exitCode !== TERM_EXIT || stop === undefined) return ending;
	const named = stopEnding(stop);
	if (named.state === 'failed') return ending;
	return ending.endedAt === undefined
		? { state: named.state }
		: { state: named.state, endedAt: ending.endedAt };
}

/**
 * The end that the files give. `exit` is the end the command chose, and
 * a cancel writes no `stop` after it. `stop` names the cause of a cancel: the
 * table writes it before it aborts. A command that the `SIGTERM` of the
 * cancel ended reads that cause. A process whose shell still runs stays
 * `running` until the cancel ends it. With no file of an end, the process
 * runs while this run of the host owns it or its shell still runs, and it
 * is lost otherwise.
 */
function endingOf(files: ProcessFiles, live: boolean): Ending {
	if (files.exit !== undefined) return exitedEnding(files.exit, files.stop);
	if (live) return runningEnding(files.stop);
	if (files.stop !== undefined) return stopEnding(files.stop);
	return { state: 'failed', error: LOST };
}

/** The status that the files give. `owned` says that this run of the host runs the process now. */
export function statusOf(files: ProcessFiles, owned: boolean): Process {
	const { spec } = files;
	const ending = endingOf(files, owned || files.alive);
	return Object.freeze({
		handle: spec.handle,
		...(spec.name === undefined ? {} : { name: spec.name }),
		kind: spec.kind,
		agent: spec.agent,
		command: spec.command,
		// A spec written before ports has none: port 0 means the process does not listen.
		port: spec.port ?? 0,
		output: `${files.dir}/out`,
		timeout: spec.timeout,
		grace: spec.grace,
		...(spec.room === undefined ? {} : { room: spec.room }),
		startedAt: spec.startedAt,
		...ending,
	});
}

/** The signals of a cancel: `TERM` first, and `KILL` after the grace. */
export type CancelSignal = 'TERM' | 'KILL';

/**
 * The script that signals the process group of a process that an earlier
 * run of the host started. It checks the pid first, as the listing does, so
 * a cancel sends no signal after the wrapper has ended. It signals the group
 * only when the group is not the script's own, so a backend that runs
 * commands in the host's group loses one shell and no more.
 */
function signalScript(dir: string, handle: string, signal: CancelSignal): string {
	return [
		`pid=$(cat ${shellQuote(`${dir}/pid`)} 2>/dev/null) || exit 0`,
		`ps -ww -o args= -p "$pid" 2>/dev/null | grep -q -- ${shellQuote(handle)} || exit 0`,
		`group=$(ps -o pgid= -p "$pid" | tr -d ' ')`,
		`own=$(ps -o pgid= -p "$$" | tr -d ' ')`,
		`if [ -n "$group" ] && [ "$group" != "$own" ]; then kill -${signal} -- "-$group"; else kill -${signal} "$pid"; fi`,
		`exit 0`,
	].join('\n');
}

/** Run the signal script. Best-effort: a process that ended already leaves nothing to signal. */
export async function signalGroup(
	env: WorkspaceEnv,
	dir: string,
	handle: string,
	signal: CancelSignal,
): Promise<void> {
	await env.exec(signalScript(dir, handle, signal), undefined);
}
