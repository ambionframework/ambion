/**
 * The adapter around a just-bash `Bash` instance: Pi's `ExecutionEnv`, whose
 * members return `Result`s and never throw, over `Bash`, whose filesystem
 * throws plain `Error`s.
 *
 * The adapter holds the just-bash mapping alone: `files` calls each
 * `Bash.fs` member, `list` adds one `lstat` per entry to one `readdir`, and
 * `classify` turns just-bash's thrown errors into Pi's codes.
 * `@ambionframework/workspace` holds the rules every backend needs. `HomeEnv`
 * implements the file members over `files` and `classify`, and the module
 * supplies the deadline, the bounded output view, and the temporary names.
 *
 * `cwd` is the agent's home for the life of the env. just-bash restores its
 * working directory after every `exec`, so a `cd` lasts for one command.
 */

import { posix } from 'node:path';
import type { FileOperations } from '@ambionframework/workspace';
import {
	boundedView,
	DEFAULT_TIMEOUT_SECONDS,
	deliverView,
	HomeEnv,
	TMP,
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

	/**
	 * One `Bash.fs` call for each file member. `readdir` gives no sizes, so
	 * `list` adds one `lstat` per entry.
	 */
	protected readonly files: FileOperations = {
		readText: (path) => this.bash.fs.readFile(path),
		readBinary: (path) => this.bash.fs.readFileBuffer(path),
		write: (path, content) => this.bash.fs.writeFile(path, content),
		append: (path, content) => this.bash.fs.appendFile(path, content),
		rename: (source, destination) => this.bash.fs.mv(source, destination),
		info: async (path) => toFileInfo(path, await this.bash.fs.lstat(path)),
		list: async (path) => {
			const names = await this.bash.fs.readdir(path);
			return Promise.all(
				names.map(async (name) => {
					const entry = posix.join(path, name);
					return toFileInfo(entry, await this.bash.fs.lstat(entry));
				}),
			);
		},
		canonical: (path) => this.bash.fs.realpath(path),
		exists: (path) => this.bash.fs.exists(path),
		makeDir: (path, recursive) => this.bash.fs.mkdir(path, { recursive }),
		remove: (path, options) =>
			this.bash.fs.rm(path, {
				recursive: options?.recursive ?? false,
				force: options?.force ?? false,
			}),
		makeTempDir: (path) => this.bash.fs.mkdir(path, { recursive: true }),
		// Neither filesystem starts with `/tmp`, and a random component keeps
		// agents that share one apart. The file needs `TMP` first.
		makeTempFile: async (path) => {
			await this.bash.fs.mkdir(TMP, { recursive: true });
			await this.bash.fs.writeFile(path, '');
		},
	};

	/** just-bash codes carry no hint of the expected kind, so the hint goes unused. */
	protected classify(error: unknown, path: string): FileError {
		return toFileError(error, path);
	}

	/**
	 * just-bash has no streaming callback and no per-call deadline. The
	 * adapter awaits the command, bounds the combined output to the caller's
	 * limits, hands one final view to `onUpdate`, and returns the metadata:
	 * Pi's `bash` tool reads the output through that update. The adapter
	 * writes no spill file: the `bash` tool keeps the whole output in a
	 * process file. The deadline is a
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
			const view = boundedView(result.stdout + result.stderr, options?.capture?.limits);
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
