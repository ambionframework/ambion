/**
 * The rules every `WorkspaceEnv` backend needs, independent of the
 * filesystem behind it.
 *
 * Six rules live here: `resolvePath`, the `~` and relative path rule that
 * every backend resolves a path with; `HomeEnv`, which implements the file
 * members once over the storage operations and the error classifier of a
 * backend; `Deadline` and `withDeadline`, which tell an abort apart from a
 * timeout; `boundedView` and `deliverView`, the bounded output view that a
 * shell command's caller reads before `exec` resolves; `randomName`, the
 * short name that keeps two temporary names apart; and `runScript` and
 * `shellQuote`, which run one script and quote one word in it.
 *
 * A backend keeps the bounded view of an output and no more: every `bash`
 * call writes its whole output to a process file. This module imports no
 * `just-bash`.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { WorkspaceEnv } from './backend.ts';
import {
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileResult,
	ok,
	type Result,
	type ShellExecResult,
	type ShellOutputLimits,
	type ShellOutputView,
	type WorkspaceExecOptions,
} from './port.ts';
import { truncateHead, truncateTail } from './truncate.ts';

/** What a command gets when its caller names no timeout. The `bash` tool names none by default. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

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
 * `WorkspaceEnv`. Each operation takes a resolved absolute path and throws
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
	 * Takes the signal because a backend can remove a tree through `exec`.
	 * The workstation runs `rm -rf`.
	 */
	remove(
		path: string,
		options: Parameters<WorkspaceEnv['remove']>[1],
		signal: AbortSignal | undefined,
	): Promise<void>;
}

/**
 * The file members of a `WorkspaceEnv` that follow from the agent's home, the
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

	/** Run one operation. An aborted signal gives `aborted`, and a throw goes to `classify`. */
	private async attempt<T>(
		path: string,
		expect: FileExpect,
		signal: AbortSignal | undefined,
		run: () => Promise<T>,
	): FileResult<T> {
		if (signal?.aborted) {
			return err(new FileError('aborted', 'Operation aborted', path));
		}
		try {
			return ok(await run());
		} catch (error) {
			return err(await this.classify(error, path, expect));
		}
	}

	async absolutePath(path: string): FileResult<string> {
		return ok(this.resolve(path));
	}

	readTextFile(path: string, signal?: AbortSignal): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', signal, () => this.files.readText(resolved));
	}

	readBinaryFile(path: string, signal?: AbortSignal): FileResult<Uint8Array> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', signal, () => this.files.readBinary(resolved));
	}

	writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', signal, () => this.files.write(resolved, content));
	}

	appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'file', signal, () => this.files.append(resolved, content));
	}

	/** An error carries the source path. */
	renameFile(sourcePath: string, destinationPath: string, signal?: AbortSignal): FileResult<void> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		return this.attempt(source, 'any', signal, () => this.files.rename(source, destination));
	}

	fileInfo(path: string, signal?: AbortSignal): FileResult<FileInfo> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', signal, () => this.files.info(resolved));
	}

	listDir(path: string, signal?: AbortSignal): FileResult<FileInfo[]> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'directory', signal, () => this.files.list(resolved));
	}

	canonicalPath(path: string, signal?: AbortSignal): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', signal, () => this.files.canonical(resolved));
	}

	exists(path: string, signal?: AbortSignal): FileResult<boolean> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', signal, () => this.files.exists(resolved));
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		signal?: AbortSignal,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', signal, () =>
			this.files.makeDir(resolved, options?.recursive ?? true),
		);
	}

	remove(
		path: string,
		options: Parameters<WorkspaceEnv['remove']>[1],
		signal?: AbortSignal,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, 'any', signal, () =>
			this.files.remove(resolved, options, signal),
		);
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
 * return the result that names the exit code and the truncation.
 */
export function deliverView(
	view: ShellOutputView,
	exitCode: number,
	options: WorkspaceExecOptions | undefined,
): ShellExecResult {
	options?.onUpdate?.(view);
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
	env: Pick<WorkspaceEnv, 'exec'>,
	script: string,
	options: Omit<WorkspaceExecOptions, 'onUpdate'> | undefined,
	signal?: AbortSignal,
): Promise<Result<ScriptRun, ExecutionError>> {
	let view: ShellOutputView | undefined;
	const ran = await env.exec(
		script,
		{
			...options,
			onUpdate: (output) => {
				view = output;
			},
		},
		signal,
	);
	if (!ran.ok) return ran;
	return ok({ ...ran.value, output: view?.text ?? '' });
}
