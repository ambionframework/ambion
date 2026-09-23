/**
 * The adapter around a just-bash `Bash` instance: Pi's `ExecutionEnv`, whose
 * members return `Result`s and never throw, over `Bash`, whose filesystem
 * throws plain `Error`s.
 *
 * The adapter holds the just-bash mapping alone: classify just-bash's
 * thrown errors into Pi's codes, build `listDir` from one `readdir` plus
 * one `lstat` per entry, and call each `Bash.fs` member for its matching
 * `ExecutionEnv` member. `@ambionframework/workspace` holds the rules every
 * backend needs — path resolution and the members that follow from it, the
 * deadline, the bounded output view, and the temporary names — and this
 * adapter calls them.
 *
 * `cwd` is the agent's home for the life of the env. just-bash restores its
 * working directory after every `exec`, so a `cd` lasts for one command.
 */

import { posix } from 'node:path';
import {
	boundedView,
	DEFAULT_TIMEOUT_SECONDS,
	deliverView,
	HomeEnv,
	spill,
	TMP,
	tempDirPath,
	tempFilePath,
	withDeadline,
} from '@ambionframework/workspace';
import type {
	Context,
	ExecutionEnv,
	ExecutionError,
	FileErrorCode,
	FileInfo,
	Result,
	ShellExecOptions,
	ShellExecResult,
} from '@earendil-works/pi-agent-core';
import { err, FileError, ok } from '@earendil-works/pi-agent-core';
import type { Bash, FsStat } from 'just-bash';

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

export class BashEnv extends HomeEnv implements ExecutionEnv {
	/** The timeout, in seconds, for a command whose caller names none. */
	private readonly timeout: number;

	constructor(
		private readonly bash: Bash,
		home: string,
		options: { timeout?: number } = {},
	) {
		super(home);
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

	readTextFile(path: string, context: Context): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, context.abortSignal, () => this.bash.fs.readFile(resolved));
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
		options: Parameters<ExecutionEnv['remove']>[1],
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
	exec(
		command: string,
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		const timeout = options?.timeout ?? this.timeout;
		return withDeadline(context.abortSignal, timeout, async (deadline) => {
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
			return ok(deliverView(view, result.exitCode, options, context));
		});
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
