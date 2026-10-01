/**
 * The rules every `ExecutionEnv` backend needs, independent of the
 * filesystem behind it.
 *
 * Seven rules live here: `resolvePath`, the `~` and relative path rule that
 * every backend resolves a path with; `HomeEnv`, which implements the file
 * members once over the storage operations and the error classifier of a
 * backend; `Deadline` and `withDeadline`, which tell an abort apart from a
 * timeout; `boundedView` and `deliverView`, the bounded output view that a
 * shell command's caller reads before `exec` resolves; the temporary names
 * and paths under `/tmp` that a temp file and a temp directory share; and
 * `runScript` and `shellQuote`, which run one script and quote one word in
 * it.
 *
 * A backend writes no spill file: every `bash` call writes its whole output
 * to a process file. This module imports no `just-bash`.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type {
	Context,
	ExecutionEnv,
	FileInfo,
	Result,
	ShellExecOptions,
	ShellExecResult,
	ShellOutputLimits,
	ShellOutputUpdate,
	ShellOutputView,
} from '@earendil-works/pi-agent-core';
import { ExecutionError, err, FileError, ok } from '@earendil-works/pi-agent-core';
import { truncateHead, truncateTail } from './truncate.ts';

/**
 * The options of one command on a workspace environment: Pi's options, and the
 * grace of a stop.
 */
export interface WorkspaceExecOptions extends ShellExecOptions {
	/**
	 * Seconds from `SIGTERM` to `SIGKILL` when an abort or the timeout stops
	 * the command. Absent or 0, the stop sends `SIGKILL` at once. A backend
	 * with no signals, such as just-bash, ends the command at once.
	 */
	grace?: number;
}

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

/** What the failed call expected at the path: a file, a directory, or either. */
export type FileExpect = 'file' | 'directory' | 'any';

/**
 * The storage operations of a backend, one for each file member of
 * `ExecutionEnv`. Each operation takes a resolved absolute path and throws
 * what the storage throws. `HomeEnv` resolves the path, checks the abort
 * signal, and classifies the error.
 */
export interface FileOperations {
	readText(path: string): Promise<string>;
	readBinary(path: string): Promise<Uint8Array>;
	write(path: string, content: string | Uint8Array): Promise<void>;
	append(path: string, content: string | Uint8Array): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	info(path: string): Promise<FileInfo>;
	/** One `FileInfo` for each entry, with the path of the entry under `path`. */
	list(path: string): Promise<FileInfo[]>;
	canonical(path: string): Promise<string>;
	exists(path: string): Promise<boolean>;
	makeDir(path: string, recursive: boolean): Promise<void>;
	/**
	 * Takes the context because a backend can remove a tree through `exec`.
	 * The workstation runs `rm -rf`.
	 */
	remove(
		path: string,
		options: Parameters<ExecutionEnv['remove']>[1],
		context: Context,
	): Promise<void>;
	/** Create the directory at `path`. `HomeEnv` chose the path. */
	makeTempDir(path: string): Promise<void>;
	/** Create the empty file at `path`. `HomeEnv` chose the path. */
	makeTempFile(path: string): Promise<void>;
}

type FileResult<T> = Promise<Result<T, FileError>>;

/**
 * The members of an `ExecutionEnv` that follow from the agent's home, the
 * working directory, and the file operations of a backend. `cwd` is the home
 * for the life of the env.
 *
 * A backend extends this class. It supplies `files`, the throwing storage
 * operations, and `classify`, which turns what an operation threw into a
 * `FileError`. Both are abstract members: they read the state of the
 * backend, which exists only after `super()` returns. A backend supplies the
 * shell members, `exec` and `cleanup`, and can override a file member that
 * needs more than one operation.
 */
export abstract class HomeEnv {
	readonly cwd: string;

	protected constructor(protected readonly home: string) {
		this.cwd = home;
	}

	/** The storage operations. Each takes a resolved absolute path. */
	protected abstract readonly files: FileOperations;

	/** Turn what an operation threw at `path` into a `FileError`. */
	protected abstract classify(
		error: unknown,
		path: string,
		expect: FileExpect,
	): FileError | Promise<FileError>;

	/** `~` and `~/` are the agent's home, and a relative path is under `cwd`. */
	protected resolve(path: string): string {
		return resolvePath(this.home, this.cwd, path);
	}

	/** Run one operation. An aborted context gives `aborted`, and a throw goes to `classify`. */
	private async attempt<T>(
		path: string,
		expect: FileExpect,
		context: Context,
		run: () => Promise<T>,
	): FileResult<T> {
		if (context.abortSignal?.aborted) {
			return err(new FileError('aborted', 'Operation aborted', path));
		}
		try {
			return ok(await run());
		} catch (error) {
			return err(await this.classify(error, path, expect));
		}
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	readTextFile(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, () => this.files.readText(resolved));
	}

	readBinaryFile(path: string, context: Context): FileResult<Uint8Array> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, () => this.files.readBinary(resolved));
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, () => this.files.write(resolved, content));
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', context, () => this.files.append(resolved, content));
	}

	/** An error carries the source path. */
	renameFile(sourcePath: string, destinationPath: string, context: Context): FileResult<void> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		return this.attempt(source, 'any', context, () => this.files.rename(source, destination));
	}

	fileInfo(path: string, context: Context): FileResult<FileInfo> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () => this.files.info(resolved));
	}

	listDir(path: string, context: Context): FileResult<FileInfo[]> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'directory', context, () => this.files.list(resolved));
	}

	canonicalPath(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () => this.files.canonical(resolved));
	}

	exists(path: string, context: Context): FileResult<boolean> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () => this.files.exists(resolved));
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () =>
			this.files.makeDir(resolved, options?.recursive ?? true),
		);
	}

	remove(
		path: string,
		options: Parameters<ExecutionEnv['remove']>[1],
		context: Context,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', context, () =>
			this.files.remove(resolved, options, context),
		);
	}

	createTempDir(prefix: string | undefined, context: Context): FileResult<string> {
		const dir = tempDirPath(prefix);
		return this.attempt(dir, 'any', context, async () => {
			await this.files.makeTempDir(dir);
			return dir;
		});
	}

	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): FileResult<string> {
		const file = tempFilePath(options);
		return this.attempt(file, 'any', context, async () => {
			await this.files.makeTempFile(file);
			return file;
		});
	}

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

/** The view that `update` makes of `current`. */
function applyShellOutputUpdate(
	current: ShellOutputView | undefined,
	update: ShellOutputUpdate,
): ShellOutputView {
	switch (update.kind) {
		case 'replace':
			return update.output;
		case 'append':
			return { text: `${current?.text ?? ''}${update.text}`, ...update.metadata };
		case 'slide':
			return {
				text: `${current?.text.slice(update.drop) ?? ''}${update.text}`,
				...update.metadata,
			};
		case 'metadata':
			return { text: current?.text ?? '', ...update.metadata };
	}
}

/**
 * Hand the one view of a command's output to the caller's `onUpdate`, and
 * return the result that names the exit code and the truncation.
 */
export function deliverView(
	view: ShellOutputView,
	exitCode: number,
	options: ShellExecOptions | undefined,
	context: Context,
): ShellExecResult {
	options?.onUpdate?.({ kind: 'replace', output: view }, context);
	return { exitCode, truncation: view.truncation };
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

/** `word` in single quotes, as one word for `bash`. */
export function shellQuote(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** What `runScript` gives: the result of `exec`, and the text of the output view. */
export interface ScriptRun extends ShellExecResult {
	/** The text of the last output view, or empty when the command gave none. */
	readonly output: string;
}

/**
 * Run `script` on `env`, and collect the text of the output view that
 * `exec` hands to `onUpdate`. A failure of `exec` is its error result. The
 * caller checks the exit code and the truncation.
 */
export async function runScript(
	env: Pick<ExecutionEnv, 'exec'>,
	script: string,
	options: Omit<WorkspaceExecOptions, 'onUpdate'> | undefined,
	context: Context,
): Promise<Result<ScriptRun, ExecutionError>> {
	let view: ShellOutputView | undefined;
	const ran = await env.exec(
		script,
		{
			...options,
			onUpdate: (update) => {
				view = applyShellOutputUpdate(view, update);
			},
		},
		context,
	);
	if (!ran.ok) return ran;
	return ok({ ...ran.value, output: view?.text ?? '' });
}
