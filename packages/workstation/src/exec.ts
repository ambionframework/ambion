/**
 * One command on the workstation: a channel that runs
 * `exec setsid --wait bash -s`, the script on its standard input, and one
 * bounded view of the output when the command ends.
 *
 * `setsid --wait` makes the script's `bash` the leader of a new process
 * group and waits for it, so the channel reports the command's exit status.
 * The script's first stderr line gives the group ID. A login shell can write
 * lines of its own first, such as a `.bashrc` that Debian's bash reads for
 * `sshd`, so `exec` looks for that line among the others. An abort or a deadline
 * opens a second channel and kills the whole group, as Pi's
 * `NodeExecutionEnv` does on a local machine. The SSH signal request cannot:
 * it reaches the session's own child alone.
 *
 * The command's output arrives on the channel's stdout, and `Capture` holds
 * it within a bound. `exec` hands one view to `onUpdate` after the command
 * ends, through the workspace's `deliverView`, the same as the just-bash
 * backends. A child that keeps the output open after the
 * command exits gets `EXIT_GRACE_MS` after the last output, and at most
 * `EXIT_DRAIN_MS` in all, and then the channel closes. A command that exits
 * before its deadline gives its exit status, whatever arrives after it.
 */

import { constants } from 'node:os';
import {
	DEFAULT_TIMEOUT_SECONDS,
	type Deadline,
	deliverView,
	spillPath,
	withDeadline,
} from '@ambionframework/workspace';
import {
	type Context,
	ExecutionError,
	err,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
} from '@earendil-works/pi-agent-core';
import type { ClientChannel } from 'ssh2';
import { Capture } from './capture.ts';
import { commandScript, invalidNames, PGID_PREFIX } from './script.ts';

/** The longest timeout a timer holds, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** How long an aborted command's channel may stay open after the kill. */
const CLOSE_GRACE_MS = 2_000;

/**
 * How long the channel stays open after the last output, once the command
 * exits. `sshd` sends the exit status first and the output it still holds
 * after it, and over a slow link the rest waits on a window adjustment.
 * Pi's 100 ms fits a local pipe and can cut a remote output.
 */
const EXIT_GRACE_MS = 1_000;

/**
 * The longest the channel stays open after the command exits. A background
 * child that keeps writing would otherwise hold the result until the deadline.
 */
const EXIT_DRAIN_MS = 5_000;

/**
 * How late the grace timer may fire and still close the channel. A later
 * timer measured a stall of this process, and output can wait unread in a
 * pipe or a socket behind it. The timer then waits one more grace.
 */
const GRACE_LATE_MS = EXIT_GRACE_MS / 2;

/** The line the view ends with when `EXIT_DRAIN_MS` closed the channel while output still arrived. */
const DRAIN_NOTICE = `\n[The workstation closed the output ${EXIT_DRAIN_MS / 1000} seconds after the command exited. The view does not show the output after that.]\n`;

/** How much of the script's own stderr `exec` keeps. The command's stderr joins its stdout. */
const SCRIPT_STDERR_BYTES = 64 * 1024;

/** The line `setsid --wait` writes when its child ends on a signal. */
const SETSID_NOTICE = /^setsid: child \d+ did not exit normally$/;

/** What `runCommand` needs from the connection. */
export interface CommandHost {
	/** Open one `exec` channel for `command`. */
	open(command: string): Promise<ClientChannel>;
	/** Whether `path` is a directory. */
	isDirectory(path: string): Promise<boolean>;
	/** Whether a file exists at `path`. */
	exists(path: string): Promise<boolean>;
	/** Remove the file at `path`, and ignore a failure. */
	discard(path: string): Promise<void>;
}

/**
 * The group ID line. The script prints a newline first, so the line stands
 * alone even after login shell output with no newline at its end.
 */
const GROUP_LINE = new RegExp(`\n${PGID_PREFIX}(\\d+)\n`);

/** More than the longest group ID line: the text a search keeps when it trims. */
const GROUP_LINE_MAX = 64;

/** The script's own stderr: the group ID line, and any other line the login shell or the script writes. */
class ScriptStderr {
	/** What the view shows, up to `SCRIPT_STDERR_BYTES`. */
	private shown = '';
	/** The stderr that comes before the group ID line, which the search reads. */
	private head = '';
	pgid: number | undefined;
	onPgid: (() => void) | undefined;

	push(chunk: Buffer): void {
		const text = chunk.toString('utf8');
		if (this.pgid !== undefined) {
			this.show(text);
			return;
		}
		this.head += text;
		const line = GROUP_LINE.exec(this.head);
		if (line === null) {
			this.trimHead();
			return;
		}
		const before = this.head.slice(0, line.index);
		this.show(before === '' || before.endsWith('\n') ? before : `${before}\n`);
		this.show(this.head.slice(line.index + line[0].length));
		this.head = '';
		const pgid = Number(line[1]);
		// Group 0 and group 1 are never the script's: `kill -- -0` reaches the caller's own group.
		if (pgid <= 1) return;
		this.pgid = pgid;
		this.onPgid?.();
	}

	/** Keep the search's text within the cap: a line that is not whole yet stays in the tail. */
	private trimHead(): void {
		if (this.head.length <= SCRIPT_STDERR_BYTES) return;
		const cut = this.head.length - GROUP_LINE_MAX;
		this.show(this.head.slice(0, cut));
		this.head = this.head.slice(cut);
	}

	private show(text: string): void {
		if (this.shown.length < SCRIPT_STDERR_BYTES) this.shown += text;
	}

	/** The lines to show, without `setsid`'s own notice. */
	lines(): string {
		return (this.shown + this.head)
			.split(/(?<=\n)/)
			.filter((line) => !SETSID_NOTICE.test(line.replace(/\n$/, '')))
			.join('');
	}
}

/** How a channel ended: the exit status, or none when it closed first. */
interface Ending {
	readonly exited: boolean;
	/** Whether the deadline had fired when the exit status arrived. */
	readonly late: boolean;
	/** Whether `EXIT_DRAIN_MS` closed the channel while output still arrived. */
	readonly cut: boolean;
	readonly code: number | null | undefined;
	readonly signal: string | undefined;
}

/** The exit status of a finished channel, 128 + the signal number for a signal. */
function exitCodeOf(code: number | null | undefined, signal: string | undefined): number {
	if (typeof code === 'number') return code;
	if (signal === undefined) return 1;
	const number = (constants.signals as Record<string, number | undefined>)[`SIG${signal}`];
	return 128 + (number ?? 0);
}

/**
 * Wait for the channel to close. After the exit status, each chunk of output
 * restarts a short timer, up to a limit, and the timer closes the channel.
 */
function finished(
	channel: ClientChannel,
	output: Capture,
	stderr: ScriptStderr,
	deadline: AbortSignal,
): Promise<Ending> {
	return new Promise((resolve) => {
		let ending: Ending = {
			exited: false,
			late: false,
			cut: false,
			code: undefined,
			signal: undefined,
		};
		let grace: NodeJS.Timeout | undefined;
		let drainEnd = Number.POSITIVE_INFINITY;
		const arm = () => {
			if (!ending.exited) return;
			clearTimeout(grace);
			const left = Math.max(0, drainEnd - Date.now());
			const cut = left < EXIT_GRACE_MS;
			const wait = Math.min(EXIT_GRACE_MS, left);
			const due = Date.now() + wait;
			grace = setTimeout(() => {
				if (!cut && Date.now() - due > GRACE_LATE_MS) return arm();
				ending = { ...ending, cut };
				channel.close();
			}, wait);
		};
		channel.on('data', (chunk: Buffer) => {
			output.push(chunk);
			arm();
		});
		channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		channel.on('exit', (code: number | null, signal?: string) => {
			const late = deadline.aborted;
			ending = { exited: true, late, cut: false, code, signal: signal ?? undefined };
			drainEnd = Date.now() + EXIT_DRAIN_MS;
			arm();
		});
		channel.on('close', () => {
			clearTimeout(grace);
			resolve(ending);
		});
	});
}

/**
 * Kill the command's process group through a second channel. The kill runs
 * in bash: the login shell can be `dash`, whose `kill` refuses `-KILL --`.
 */
async function killGroup(host: CommandHost, pgid: number): Promise<void> {
	try {
		const killer = await host.open(`exec bash -c 'kill -KILL -- -${pgid}' 2>/dev/null`);
		await new Promise<void>((resolve) => {
			killer.on('close', () => resolve());
			killer.resume();
			killer.stderr.resume();
		});
	} catch {
		// The group can end, or the connection drop, before the kill lands.
	}
}

/** Kill the group once its ID is known, and close the channel after a grace period. */
function stopWhenAborted(
	host: CommandHost,
	channel: ClientChannel,
	stderr: ScriptStderr,
	deadline: Deadline,
): void {
	const stop = () => {
		const kill = () => {
			if (stderr.pgid !== undefined) void killGroup(host, stderr.pgid);
		};
		if (stderr.pgid === undefined) stderr.onPgid = kill;
		else kill();
		setTimeout(() => channel.close(), CLOSE_GRACE_MS).unref();
	};
	if (deadline.signal.aborted) stop();
	else deadline.signal.addEventListener('abort', stop, { once: true });
}

/** A timeout that no timer can hold, refused the same as in `NodeExecutionEnv`. */
function invalidTimeout(timeout: number | undefined): ExecutionError | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds');
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		return new ExecutionError(
			'timeout',
			`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`,
		);
	}
	return undefined;
}

/** Refuse a command before any channel opens: a bad variable name or a missing directory. */
async function refusal(host: CommandHost, cwd: string, options: ShellExecOptions | undefined) {
	const invalid = invalidNames(options?.env);
	if (invalid.length > 0) {
		return new ExecutionError(
			'spawn_error',
			`Invalid environment variable names: ${invalid.join(', ')}`,
		);
	}
	if (!(await host.isDirectory(cwd))) {
		return new ExecutionError(
			'spawn_error',
			`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
		);
	}
	return undefined;
}

/** One command from its channel to its ending, with its output and its script lines. */
async function run(
	host: CommandHost,
	command: string,
	cwd: string,
	options: ShellExecOptions | undefined,
	spill: string | undefined,
	deadline: Deadline,
) {
	const channel = await host.open('exec setsid --wait bash -s');
	const output = new Capture(options?.capture?.limits);
	const stderr = new ScriptStderr();
	const done = finished(channel, output, stderr, deadline.signal);
	stopWhenAborted(host, channel, stderr, deadline);
	channel.end(commandScript(command, cwd, options?.env, spill));
	const ending = await done;
	output.pushText(stderr.lines());
	if (ending.cut) output.pushText(DRAIN_NOTICE);
	return { ending, output };
}

/** Hand the one view to `onUpdate`, with the spill file when the view cut the output. */
async function result(
	host: CommandHost,
	output: Capture,
	exitCode: number,
	spill: string | undefined,
	options: ShellExecOptions | undefined,
	context: Context,
): Promise<ShellExecResult> {
	const view = output.view();
	if (view.truncation.truncated && spill !== undefined && (await host.exists(spill))) {
		view.spillPath = spill;
	}
	return deliverView(view, exitCode, options, context);
}

/** The result of a command that ran to its channel's close. */
async function settled(
	host: CommandHost,
	ran: Awaited<ReturnType<typeof run>>,
	spill: string | undefined,
	options: ShellExecOptions | undefined,
	context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
	if (!ran.ending.exited) {
		return err(new ExecutionError('unknown', 'The channel closed before the command ended.'));
	}
	const exitCode = exitCodeOf(ran.ending.code, ran.ending.signal);
	return ok(await result(host, ran.output, exitCode, spill, options, context));
}

/** Run the command under its deadline, and turn what it throws into an `ExecutionError`. */
async function attempt(
	host: CommandHost,
	command: string,
	cwd: string,
	options: ShellExecOptions | undefined,
	spill: string | undefined,
	context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
	const timeout = options?.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	return withDeadline(context.abortSignal, timeout, async (deadline) => {
		const early = deadline.error() ?? (await refusal(host, cwd, options));
		if (early) return err(early);
		const ran = await run(host, command, cwd, options, spill, deadline);
		// A command that exited before its deadline keeps its exit status.
		const stopped = ran.ending.exited && !ran.ending.late ? undefined : deadline.error();
		if (stopped) return err(stopped);
		return settled(host, ran, spill, options, context);
	});
}

/** Run `command` in `cwd` on the workstation, and remove a spill file the result does not name. */
export async function runCommand(
	host: CommandHost,
	command: string,
	cwd: string,
	options: ShellExecOptions | undefined,
	context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
	const invalid = invalidTimeout(options?.timeout);
	if (invalid) return err(invalid);
	const spill = options?.capture?.spill === true ? spillPath() : undefined;
	const outcome = await attempt(host, command, cwd, options, spill, context);
	const kept = outcome.ok && outcome.value.spillPath !== undefined;
	if (spill !== undefined && !kept) await host.discard(spill);
	return outcome;
}
