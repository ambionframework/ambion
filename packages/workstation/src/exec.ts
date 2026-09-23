/**
 * One command on the workstation: a channel that runs
 * `exec setsid --wait bash -s`, the script on its standard input, and one
 * bounded view of the output when the command ends.
 *
 * `setsid --wait` makes the script's `bash` the leader of a new process
 * group and waits for it, so the channel reports the command's exit status.
 * The script's first stderr line gives the group ID. An abort or a deadline
 * opens a second channel and kills the whole group, as Pi's
 * `NodeExecutionEnv` does on a local machine. The SSH signal request cannot:
 * it reaches the session's own child alone.
 *
 * The command's output arrives on the channel's stdout, and `Capture` holds
 * it within a bound. `exec` hands one view to `onUpdate` after the command
 * ends, the same as `BashEnv`. A child that keeps the output open after the
 * command exits gets `EXIT_GRACE_MS`, and then the channel closes, as in
 * `NodeExecutionEnv`.
 */

import { constants } from 'node:os';
import { Deadline, spillPath } from '@ambionframework/workspace';
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

/** What a command gets when its caller names no timeout, the same as `BashEnv`. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** The longest timeout a timer holds, in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/** How long an aborted command's channel may stay open after the kill. */
const CLOSE_GRACE_MS = 2_000;

/** How long the output may keep arriving after the command exits, the same as Pi. */
const EXIT_GRACE_MS = 100;

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

/** The script's own stderr: the group ID line first, then any line of the script itself. */
class ScriptStderr {
	private text = '';
	pgid: number | undefined;
	onPgid: (() => void) | undefined;

	push(chunk: Buffer): void {
		if (this.text.length < SCRIPT_STDERR_BYTES) this.text += chunk.toString('utf8');
		if (this.pgid !== undefined) return;
		const newline = this.text.indexOf('\n');
		if (newline === -1) return;
		const first = this.text.slice(0, newline);
		if (!first.startsWith(PGID_PREFIX)) return;
		this.pgid = Number(first.slice(PGID_PREFIX.length));
		this.text = this.text.slice(newline + 1);
		this.onPgid?.();
	}

	/** The lines to show, without `setsid`'s own notice. */
	lines(): string {
		return this.text
			.split(/(?<=\n)/)
			.filter((line) => !SETSID_NOTICE.test(line.replace(/\n$/, '')))
			.join('');
	}
}

/** How a channel ended: the exit status, or none when it closed first. */
interface Ending {
	readonly exited: boolean;
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
 * restarts a short timer, and the timer closes the channel.
 */
function finished(channel: ClientChannel, output: Capture, stderr: ScriptStderr): Promise<Ending> {
	return new Promise((resolve) => {
		let ending: Ending = { exited: false, code: undefined, signal: undefined };
		let grace: NodeJS.Timeout | undefined;
		const arm = () => {
			if (!ending.exited) return;
			clearTimeout(grace);
			grace = setTimeout(() => channel.close(), EXIT_GRACE_MS);
		};
		channel.on('data', (chunk: Buffer) => {
			output.push(chunk);
			arm();
		});
		channel.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
		channel.on('exit', (code: number | null, signal?: string) => {
			ending = { exited: true, code, signal: signal ?? undefined };
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
	const done = finished(channel, output, stderr);
	stopWhenAborted(host, channel, stderr, deadline);
	channel.end(commandScript(command, cwd, options?.env, spill));
	const ending = await done;
	output.pushText(stderr.lines());
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
	options?.onUpdate?.({ kind: 'replace', output: view }, context);
	return {
		exitCode,
		truncation: view.truncation,
		...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
	};
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
	const deadline = new Deadline(context.abortSignal, options?.timeout ?? DEFAULT_TIMEOUT_SECONDS);
	try {
		const early = deadline.error() ?? (await refusal(host, cwd, options));
		if (early) return err(early);
		const ran = await run(host, command, cwd, options, spill, deadline);
		const stopped = deadline.error();
		if (stopped) return err(stopped);
		return await settled(host, ran, spill, options, context);
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return err(new ExecutionError('unknown', cause.message, cause));
	} finally {
		deadline.clear();
	}
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
