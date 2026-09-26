/**
 * The rules every `ExecutionEnv` backend needs, independent of the
 * filesystem behind it.
 *
 * Six rules live here: `resolvePath`, the `~` and relative path rule that
 * every backend resolves a path with; `HomeEnv`, the members that follow
 * from that rule alone; `Deadline` and `withDeadline`, which tell an abort
 * apart from a timeout; `boundedView` and `deliverView`, the bounded output
 * view that a shell command's caller reads before `exec` resolves; and the
 * temporary names and paths under `/tmp` that a spill file, a temp file, and
 * a temp directory share.
 *
 * `spill` takes a `MinimalWriter`, one `mkdir` plus one `writeFile`, so a
 * backend supplies its own filesystem here without this module reaching
 * into a specific one. This module imports no `just-bash`.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type {
	Context,
	ExecutionEnv,
	FileError,
	Result,
	ShellExecOptions,
	ShellExecResult,
	ShellOutputLimits,
	ShellOutputView,
} from '@earendil-works/pi-agent-core';
import { ExecutionError, err, ok, truncateHead, truncateTail } from '@earendil-works/pi-agent-core';

/** What a command gets when its caller names no timeout. Pi's `bash` tool names none by default. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

/** The directory every backend's temporary names and paths sit under. */
export const TMP = '/tmp';

/** A short random component that keeps two temporary names apart. */
export function randomName(): string {
	return randomBytes(6).toString('hex');
}

/** `~` and `~/` are the agent's home, and a relative path is under `cwd`. */
export function resolvePath(home: string, cwd: string, path: string): string {
	if (path === '~') return home;
	const expanded = path.startsWith('~/') ? posix.join(home, path.slice(2)) : path;
	return posix.resolve(cwd, expanded);
}

/**
 * The members of an `ExecutionEnv` that follow from the agent's home and the
 * working directory alone. `cwd` is the home for the life of the env. A
 * backend extends this class and supplies every file and shell member.
 */
export abstract class HomeEnv {
	readonly cwd: string;

	protected constructor(protected readonly home: string) {
		this.cwd = home;
	}

	/** `~` and `~/` are the agent's home, and a relative path is under `cwd`. */
	protected resolve(path: string): string {
		return resolvePath(this.home, this.cwd, path);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	abstract readTextFile(path: string, context: Context): Promise<Result<string, FileError>>;

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split('\n');
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openTextLineReader(
		path: string,
		context: Context,
	): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		return ok(textLineReader(text.value));
	}
}

/** Pi exports no name for the reader that `openTextLineReader` opens. */
type TextLineReader = Extract<
	Awaited<ReturnType<ExecutionEnv['openTextLineReader']>>,
	{ ok: true }
>['value'];
type TextLine = NonNullable<
	Extract<Awaited<ReturnType<TextLineReader['readLine']>>, { ok: true }>['value']
>;

/** A reader over text already in memory. A final line with no `\n` is not terminated. */
function textLineReader(text: string): TextLineReader {
	const lines: TextLine[] = text
		.split('\n')
		.map((line, index, all) => ({ text: line, terminated: index < all.length - 1 }));
	if (lines.at(-1)?.text === '') lines.pop();
	let next = 0;
	return {
		readLine: async () => ok(lines[next++]),
		close: async () => {},
	};
}

/** A path for a new temporary directory. Neither filesystem starts with `/tmp`. */
export function tempDirPath(prefix: string | undefined): string {
	return posix.join(TMP, `${prefix ?? 'tmp-'}${randomName()}`);
}

/** A path for a new temporary file. */
export function tempFilePath(options: { prefix?: string; suffix?: string } | undefined): string {
	return posix.join(TMP, `${options?.prefix ?? ''}${randomName()}${options?.suffix ?? ''}`);
}

/** A path for a new spill file, the whole output a bounded view cut. */
export function spillPath(): string {
	return posix.join(TMP, `shell-${randomName()}.out`);
}

/** The filesystem `spill` needs: one call to create `/tmp`, one to write the file. */
export interface MinimalWriter {
	mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
	writeFile(path: string, content: string): Promise<unknown>;
}

/** Keep the whole output in a file so a reader can reach what a bounded view cut. */
export async function spill(writer: MinimalWriter, content: string): Promise<string | undefined> {
	const path = spillPath();
	try {
		await writer.mkdir(TMP, { recursive: true });
		await writer.writeFile(path, content);
		return path;
	} catch {
		return undefined; // Spill is best-effort; a failed write leaves the view alone.
	}
}

/**
 * Bound the combined command output to the caller's limits, tail by default.
 * Absent limits leave the output whole: the caller named no bound.
 */
export function boundedView(
	output: string,
	limits: ShellOutputLimits | undefined,
): ShellOutputView {
	const options = {
		maxLines: limits?.maxLines ?? Number.POSITIVE_INFINITY,
		maxBytes: limits?.maxBytes ?? Number.POSITIVE_INFINITY,
	};
	const result =
		limits?.retain === 'head' ? truncateHead(output, options) : truncateTail(output, options);
	const { content, ...truncation } = result;
	return { text: content, truncation };
}

/**
 * Hand the one view of a command's output to the caller's `onUpdate`, and
 * return the result that names the exit code, the truncation, and the spill
 * file when the view has one.
 */
export function deliverView(
	view: ShellOutputView,
	exitCode: number,
	options: ShellExecOptions | undefined,
	context: Context,
): ShellExecResult {
	options?.onUpdate?.({ kind: 'replace', output: view }, context);
	return {
		exitCode,
		truncation: view.truncation,
		...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
	};
}

/**
 * One signal for a command, fired by the caller's abort or by a per-call
 * timeout, and which of the two it was. A backend that reports the same
 * exit code for both still tells them apart here.
 */
export class Deadline {
	private readonly controller = new AbortController();
	private readonly timer: NodeJS.Timeout | undefined;
	private timedOut = false;
	private readonly abort = () => this.controller.abort();

	constructor(
		private readonly caller: AbortSignal | undefined,
		private readonly timeout: number | undefined,
	) {
		caller?.addEventListener('abort', this.abort, { once: true });
		if (caller?.aborted) this.abort();
		if (timeout !== undefined) {
			this.timer = setTimeout(() => {
				this.timedOut = true;
				this.abort();
			}, timeout * 1000);
		}
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** Why the command stopped early, or undefined when it ran to its end. */
	error(): ExecutionError | undefined {
		if (this.caller?.aborted) return new ExecutionError('aborted', 'Command aborted');
		if (this.timedOut) {
			return new ExecutionError('timeout', `Command timed out after ${this.timeout} seconds`);
		}
		return undefined;
	}

	clear(): void {
		clearTimeout(this.timer);
		this.caller?.removeEventListener('abort', this.abort);
	}
}

/**
 * Run one command under a `Deadline` from the caller's signal and `timeout`.
 * `run` returns the result. What it throws becomes an `unknown`
 * `ExecutionError`, and the deadline clears in every case.
 */
export async function withDeadline<T>(
	signal: AbortSignal | undefined,
	timeout: number | undefined,
	run: (deadline: Deadline) => Promise<Result<T, ExecutionError>>,
): Promise<Result<T, ExecutionError>> {
	const deadline = new Deadline(signal, timeout);
	try {
		return await run(deadline);
	} catch (error) {
		const cause = error instanceof Error ? error : new Error(String(error));
		return err(new ExecutionError('unknown', cause.message, cause));
	} finally {
		deadline.clear();
	}
}
