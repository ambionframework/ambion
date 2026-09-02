/**
 * The adapter around a just-bash `Bash` instance: Pi's `ExecutionEnv`, whose
 * members return `Result`s and never throw, over `Bash`, whose filesystem
 * throws plain `Error`s.
 *
 * Beyond the member-by-member mapping, the adapter has six jobs, and each
 * one is named where it happens: classify just-bash's thrown errors into
 * Pi's codes; deliver a command's output through the callbacks before `exec`
 * resolves; create `/tmp` before a temp file needs it; expand `~` to the home
 * `connect` gave the agent; tell an abort apart from a deadline; and build
 * `listDir` from one `readdir` plus one `lstat` per entry.
 *
 * `cwd` is the agent's home for the life of the env. just-bash restores its
 * working directory after every `exec`, so a `cd` lasts for one command.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type {
	ExecutionEnv,
	FileErrorCode,
	FileInfo,
	Result,
	ShellExecOptions,
} from '@earendil-works/pi-agent-core';
import { ExecutionError, err, FileError, ok } from '@earendil-works/pi-agent-core';
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

const TMP = '/tmp';

/** What a command gets when its caller names no timeout. Pi's `bash` tool names none by default. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

const randomName = () => randomBytes(6).toString('hex');

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
		if (path === '~') return this.home;
		const expanded = path.startsWith('~/') ? posix.join(this.home, path.slice(2)) : path;
		return posix.resolve(this.cwd, expanded);
	}

	async absolutePath(path: string): FileResult<string> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): FileResult<string> {
		return ok(posix.join(...parts));
	}

	readTextFile(path: string, signal?: AbortSignal): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, () => this.bash.fs.readFile(resolved));
	}

	async readTextLines(
		path: string,
		options: { maxLines?: number; abortSignal?: AbortSignal } = {},
	): FileResult<string[]> {
		const text = await this.readTextFile(path, options.abortSignal);
		if (!text.ok) return text;
		const lines = text.value.split('\n');
		return ok(options.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	readBinaryFile(path: string, signal?: AbortSignal): FileResult<Uint8Array> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, () => this.bash.fs.readFileBuffer(resolved));
	}

	writeFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, () => this.bash.fs.writeFile(resolved, content));
	}

	appendFile(path: string, content: string | Uint8Array, signal?: AbortSignal): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, () => this.bash.fs.appendFile(resolved, content));
	}

	renameFile(sourcePath: string, destinationPath: string, signal?: AbortSignal): FileResult<void> {
		const source = this.resolve(sourcePath);
		const destination = this.resolve(destinationPath);
		return this.attempt(source, signal, () => this.bash.fs.mv(source, destination));
	}

	fileInfo(path: string, signal?: AbortSignal): FileResult<FileInfo> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, async () =>
			toFileInfo(resolved, await this.bash.fs.lstat(resolved)),
		);
	}

	/** Pi's `FileInfo` carries a size and a time, and only `lstat` has them. */
	listDir(path: string, signal?: AbortSignal): FileResult<FileInfo[]> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, async () => {
			const names = await this.bash.fs.readdir(resolved);
			return Promise.all(
				names.map(async (name) => {
					const entry = posix.join(resolved, name);
					return toFileInfo(entry, await this.bash.fs.lstat(entry));
				}),
			);
		});
	}

	canonicalPath(path: string, signal?: AbortSignal): FileResult<string> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, () => this.bash.fs.realpath(resolved));
	}

	exists(path: string, signal?: AbortSignal): FileResult<boolean> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, signal, () => this.bash.fs.exists(resolved));
	}

	createDir(
		path: string,
		options: { recursive?: boolean; abortSignal?: AbortSignal } = {},
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, options.abortSignal, () =>
			this.bash.fs.mkdir(resolved, { recursive: options.recursive ?? true }),
		);
	}

	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } = {},
	): FileResult<void> {
		const resolved = this.resolve(path);
		return this.attempt(resolved, options.abortSignal, () =>
			this.bash.fs.rm(resolved, {
				recursive: options.recursive ?? false,
				force: options.force ?? false,
			}),
		);
	}

	/** Neither filesystem starts with `/tmp`, and a random component keeps agents sharing one apart. */
	createTempDir(prefix = 'tmp-', signal?: AbortSignal): FileResult<string> {
		const dir = posix.join(TMP, `${prefix}${randomName()}`);
		return this.attempt(dir, signal, async () => {
			await this.bash.fs.mkdir(dir, { recursive: true });
			return dir;
		});
	}

	createTempFile(
		options: { prefix?: string; suffix?: string; abortSignal?: AbortSignal } = {},
	): FileResult<string> {
		const file = posix.join(TMP, `${options.prefix ?? ''}${randomName()}${options.suffix ?? ''}`);
		return this.attempt(file, options.abortSignal, async () => {
			await this.bash.fs.mkdir(TMP, { recursive: true });
			await this.bash.fs.writeFile(file, '');
			return file;
		});
	}

	/**
	 * just-bash has no streaming callback and no per-call deadline. The
	 * adapter awaits the command, hands the captured output to each callback
	 * once, and then resolves: Pi's `bash` tool stops accepting output on the
	 * line after `exec` returns. The deadline is a timer on an abort
	 * controller of the adapter's own, so exit 124 from the caller's signal
	 * and exit 124 from the timer come back as different errors. A call that
	 * names no timeout gets the adapter's default, so a command that never
	 * ends cannot hold an activation open.
	 */
	async exec(
		command: string,
		options: ShellExecOptions = {},
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		const deadline = new Deadline(options.abortSignal, options.timeout ?? this.timeout);
		try {
			const result = await this.bash.exec(command, {
				cwd: options.cwd === undefined ? undefined : this.resolve(options.cwd),
				env: options.env,
				signal: deadline.signal,
			});
			const stopped = deadline.error();
			if (stopped) return err(stopped);
			if (result.stdout) options.onStdout?.(result.stdout);
			if (result.stderr) options.onStderr?.(result.stderr);
			return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode });
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

/**
 * One signal for a command, fired by the caller's abort or by the per-call
 * timeout, and which of the two it was. just-bash answers both with exit 124.
 */
class Deadline {
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

function toFileInfo(path: string, stat: FsStat): FileInfo {
	return {
		name: posix.basename(path),
		path,
		kind: stat.isSymbolicLink ? 'symlink' : stat.isDirectory ? 'directory' : 'file',
		size: stat.size,
		mtimeMs: stat.mtime.getTime(),
	};
}
