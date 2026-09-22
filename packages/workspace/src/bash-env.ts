/**
 * The adapter around a just-bash `Bash` instance: Pi's `ExecutionEnv`, whose
 * members return `Result`s and never throw, over `Bash`, whose filesystem
 * throws plain `Error`s.
 *
 * The adapter holds the just-bash mapping alone: classify just-bash's
 * thrown errors into Pi's codes, build `listDir` from one `readdir` plus
 * one `lstat` per entry, and call each `Bash.fs` member for its matching
 * `ExecutionEnv` member. `./execution-env.ts` holds the rules every backend
 * needs — path resolution, the deadline, the bounded output view, and the
 * temporary names — and this adapter calls them.
 *
 * `cwd` is the agent's home for the life of the env. just-bash restores its
 * working directory after every `exec`, so a `cd` lasts for one command.
 */

import { posix } from 'node:path';
import type {
	Context,
	ExecutionEnv,
	FileErrorCode,
	FileInfo,
	Result,
	ShellExecOptions,
	ShellExecResult,
} from '@earendil-works/pi-agent-core';
import { ExecutionError, err, FileError, ok } from '@earendil-works/pi-agent-core';
import type { Bash, FsStat } from 'just-bash';
import {
	boundedView,
	Deadline,
	resolvePath,
	spill,
	TMP,
	tempDirPath,
	tempFilePath,
} from './execution-env.ts';

type FileResult<T> = Promise<Result<T, FileError>>;

/** just-bash puts the code at the front of the message; the wording after it differs per filesystem. */
const ERROR_CODES: Record<string, FileErrorCode> = {
	ENOENT: 'not_found',
	EISDIR: 'is_directory',
	ERR_FS_EISDIR: 'is_directory',
	ENOTDIR: 'not_directory',
	ENOTEMPTY: 'invalid',
	EEXIST: 'invalid',
	EINVAL: 'invalid',
	EFBIG: 'invalid',
	EACCES: 'permission_denied',
	EPERM: 'permission_denied',
};

/**
 * Pi's `write` and `edit` rethrow a `canonicalPath` failure unless its code
 * is `not_found` or `not_supported`, so this mapping decides whether the
 * built-in tools work on a new file at all.
 */
function toFileError(error: unknown, path: string): FileError {
	const message = error instanceof Error ? error.message : String(error);
	const code = ERROR_CODES[/^([A-Z][A-Z0-9_]*):/.exec(message)?.[1] ?? ''] ?? 'unknown';
	return new FileError(code, message, path, error instanceof Error ? error : undefined);
}

/** What a command gets when its caller names no timeout. Pi's `bash` tool names none by default. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

export class BashEnv implements ExecutionEnv {
	readonly cwd: string;

	/** The timeout, in seconds, for a command whose caller names none. */
	private readonly timeout: number;

	constructor(
		private readonly bash: Bash,
		private readonly home: string,
		options: { timeout?: number } = {},
	) {
		this.cwd = home;
		this.timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
	}

	/** Run one filesystem call, and turn whatever it throws into a `FileError`. */
	private async attempt<T>(
		path: string,
		signal: AbortSignal | undefined,
		fn: () => Promise<T>,
	): FileResult<T> {
		if (signal?.aborted) return err(new FileError('aborted', 'Operation aborted', path));
		try {
			return ok(await fn());
		} catch (error) {
			return err(toFileError(error, path));
		}
	}

	/** `~` and `~/` are the agent's home, and a relative path is under `cwd`. */
	private resolve(path: string): string {
		return resolvePath(this.home, this.cwd, path);
	}

	async absolutePath(path: string): FileResult<string> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): FileResult<string> {
		return ok(posix.join(...parts));
	}

	readTextFile(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () => this.bash.fs.readFile(resolved));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number } | undefined,
		context: Context,
	): FileResult<string[]> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split('\n');
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	readBinaryFile(path: string, context: Context): FileResult<Uint8Array> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () => this.bash.fs.readFileBuffer(resolved));
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () =>
			this.bash.fs.writeFile(resolved, content),
		);
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () =>
			this.bash.fs.appendFile(resolved, content),
		);
	}

	renameFile(sourcePath: string, destinationPath: string, context: Context): FileResult<void> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		return this.attempt(source, context.abortSignal, () => this.bash.fs.mv(source, destination));
	}

	fileInfo(path: string, context: Context): FileResult<FileInfo> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, async () =>
			toFileInfo(resolved, await this.bash.fs.lstat(resolved)),
		);
	}

	/** Pi's `FileInfo` carries a size and a time, and only `lstat` has them. */
	listDir(path: string, context: Context): FileResult<FileInfo[]> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, async () => {
			const names = await this.bash.fs.readdir(resolved);
			return Promise.all(
				names.map(async (name) => {
					const entry = posix.join(resolved, name);
					return toFileInfo(entry, await this.bash.fs.lstat(entry));
				}),
			);
		});
	}

	canonicalPath(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () => this.bash.fs.realpath(resolved));
	}

	exists(path: string, context: Context): FileResult<boolean> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () => this.bash.fs.exists(resolved));
	}

	createDir(
		path: string,
		options: { recursive?: boolean } | undefined,
		context: Context,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () =>
			this.bash.fs.mkdir(resolved, { recursive: options?.recursive ?? true }),
		);
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () =>
			this.bash.fs.rm(resolved, {
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			}),
		);
	}

	/** Neither filesystem starts with `/tmp`, and a random component keeps agents sharing one apart. */
	createTempDir(prefix: string | undefined, context: Context): FileResult<string> {
		const dir = tempDirPath(prefix);
		return this.attempt(dir, context.abortSignal, async () => {
			await this.bash.fs.mkdir(dir, { recursive: true });
			return dir;
		});
	}

	createTempFile(
		options: { prefix?: string; suffix?: string } | undefined,
		context: Context,
	): FileResult<string> {
		const file = tempFilePath(options);
		return this.attempt(file, context.abortSignal, async () => {
			await this.bash.fs.mkdir(TMP, { recursive: true });
			await this.bash.fs.writeFile(file, '');
			return file;
		});
	}

	/**
	 * just-bash has no streaming callback and no per-call deadline. The
	 * adapter awaits the command, bounds the combined output to the caller's
	 * limits, hands one final view to `onUpdate`, and returns the metadata:
	 * Pi's `bash` tool reads the output through that update. When the caller
	 * asks for a spill and the limits cut the output, the adapter writes the
	 * whole output to a file under `/tmp` and names it as `spillPath`, so the
	 * caller can point a reader at the part the view dropped. The deadline is a
	 * timer on an abort controller of the adapter's own, so exit 124 from the
	 * context's signal and exit 124 from the timer come back as different
	 * errors. A call that names no timeout gets the adapter's default, so a
	 * command that never ends cannot hold an activation open.
	 */
	async exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const deadline = new Deadline(context.abortSignal, options?.timeout ?? this.timeout);
		try {
			const result = await this.bash.exec(command, {
				cwd: options?.cwd === undefined ? undefined : this.resolve(options.cwd),
				env: options?.env,
				signal: deadline.signal,
			});
			const stopped = deadline.error();
			if (stopped) return err(stopped);
			const combined = result.stdout + result.stderr;
			const view = boundedView(combined, options?.capture?.limits);
			if (view.truncation.truncated && options?.capture?.spill === true) {
				view.spillPath = await spill(this.bash.fs, combined);
			}
			options?.onUpdate?.({ kind: 'replace', output: view }, context);
			return ok({
				exitCode: result.exitCode,
				truncation: view.truncation,
				...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
			});
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			return err(new ExecutionError('unknown', cause.message, cause));
		} finally {
			deadline.clear();
		}
	}

	/** just-bash exposes nothing to dispose. The collector reclaims a dropped instance. */
	async cleanup(): Promise<void> {}
}

function toFileInfo(path: string, stat: FsStat): FileInfo {
	return {
		name: posix.basename(path),
		path,
		kind: stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file',
		size: stat.size,
		mtimeMs: stat.mtime.getTime(),
	};
}
