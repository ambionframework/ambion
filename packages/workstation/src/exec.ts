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
 * The output arrives in the order the server sends it. `exec` hands one
 * view to `onUpdate` after the command ends, the same as `BashEnv`, and
 * `spill` writes the whole output when the view cuts it.
 */

import { constants } from 'node:os';
import type { MinimalWriter } from '@ambionframework/workspace';
import { boundedView, Deadline, spill } from '@ambionframework/workspace';
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
import { commandScript, invalidNames, PGID_PREFIX } from './script.ts';

/** What a command gets when its caller names no timeout, the same as `BashEnv`. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** How long an aborted command's channel may stay open after the kill. */
const CLOSE_GRACE_MS = 2_000;

/** The line `setsid --wait` writes when its child ends on a signal. */
const SETSID_NOTICE = /^setsid: child \d+ did not exit normally\n?$/;

/** What `runCommand` needs from the connection. */
export interface CommandHost {
	/** Open one `exec` channel for `command`. */
	open(command: string): Promise<ClientChannel>;
	/** Whether `cwd` is a directory. */
	isDirectory(cwd: string): Promise<boolean>;
	/** Where `spill` writes a cut output. */
	readonly writer: MinimalWriter;
}

/** The command's output as it arrives, with the script's own stderr lines taken out. */
class Output {
	private readonly parts: string[] = [];
	private stderrHead = '';
	private headDone = false;
	pgid: number | undefined;
	onPgid: (() => void) | undefined;

	stdout(chunk: Buffer): void {
		this.parts.push(chunk.toString('utf8'));
	}

	/** Buffer stderr until the first newline, and read the group ID from it. */
	stderr(chunk: Buffer): void {
		const text = chunk.toString('utf8');
		if (this.headDone) {
			this.parts.push(text);
			return;
		}
		this.stderrHead += text;
		const newline = this.stderrHead.indexOf('\n');
		if (newline === -1) return;
		const first = this.stderrHead.slice(0, newline);
		const rest = this.stderrHead.slice(newline + 1);
		this.headDone = true;
		this.stderrHead = '';
		if (first.startsWith(PGID_PREFIX)) this.pgid = Number(first.slice(PGID_PREFIX.length));
		else this.parts.push(`${first}\n`);
		if (rest !== '') this.parts.push(rest);
		this.onPgid?.();
	}

	/** The combined output, with `setsid`'s own notice taken out. */
	text(): string {
		const tail = this.headDone ? '' : this.stderrHead;
		return (this.parts.join('') + tail)
			.split(/(?<=\n)/)
			.filter((line) => !SETSID_NOTICE.test(line))
			.join('');
	}
}

/** The exit status of a finished channel, 128 + the signal number for a signal. */
function exitCodeOf(code: number | null | undefined, signal: string | undefined): number {
	if (typeof code === 'number') return code;
	if (signal === undefined) return 1;
	const number = (constants.signals as Record<string, number | undefined>)[`SIG${signal}`];
	return 128 + (number ?? 0);
}

/** Wait for the channel to close, and give its exit status. */
function finished(channel: ClientChannel, output: Output): Promise<number> {
	return new Promise((resolve) => {
		let code: number | null | undefined;
		let signal: string | undefined;
		channel.on('data', (chunk: Buffer) => output.stdout(chunk));
		channel.stderr.on('data', (chunk: Buffer) => output.stderr(chunk));
		channel.on('exit', (exit: number | null, name?: string) => {
			code = exit;
			signal = name ?? undefined;
		});
		channel.on('close', () => resolve(exitCodeOf(code, signal)));
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
	output: Output,
	deadline: Deadline,
): void {
	const stop = () => {
		const kill = () => {
			if (output.pgid !== undefined) void killGroup(host, output.pgid);
		};
		if (output.pgid === undefined) output.onPgid = kill;
		else kill();
		setTimeout(() => channel.close(), CLOSE_GRACE_MS).unref();
	};
	if (deadline.signal.aborted) stop();
	else deadline.signal.addEventListener('abort', stop, { once: true });
}

async function viewOf(
	host: CommandHost,
	output: string,
	options: ShellExecOptions | undefined,
	exitCode: number,
	context: Context,
): Promise<ShellExecResult> {
	const view = boundedView(output, options?.capture?.limits);
	if (view.truncation.truncated && options?.capture?.spill === true) {
		view.spillPath = await spill(host.writer, output);
	}
	options?.onUpdate?.({ kind: 'replace', output: view }, context);
	return {
		exitCode,
		truncation: view.truncation,
		...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
	};
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

/** Run `command` in `cwd` on the workstation. */
export async function runCommand(
	host: CommandHost,
	command: string,
	cwd: string,
	options: ShellExecOptions | undefined,
	context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
	const deadline = new Deadline(context.abortSignal, options?.timeout ?? DEFAULT_TIMEOUT_SECONDS);
	try {
		const early = deadline.error() ?? (await refusal(host, cwd, options));
		if (early) return err(early);
		const channel = await host.open('exec setsid --wait bash -s');
		const output = new Output();
		const done = finished(channel, output);
		stopWhenAborted(host, channel, output, deadline);
		channel.end(commandScript(command, cwd, options?.env));
		const exitCode = await done;
		const stopped = deadline.error();
		if (stopped) return err(stopped);
		return ok(await viewOf(host, output.text(), options, exitCode, context));
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return err(new ExecutionError('unknown', cause.message, cause));
	} finally {
		deadline.clear();
	}
}
