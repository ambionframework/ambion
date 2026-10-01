/**
 * The values that the port of a bash backend passes: the result of an
 * operation, its two errors, the metadata of a file, and the output view of a
 * command. The port is `WorkspaceEnv` in `backend.ts`.
 *
 * Every operation of the port returns a `Result` and never throws. An
 * operation takes an optional `AbortSignal` as its last argument. An aborted
 * signal ends the operation with the code `aborted`.
 *
 * The shapes derive from the harness types of Pi (earendil-works/pi, MIT
 * License, Mario Zechner). The module imports types alone.
 */

import type { Truncation } from './truncate.ts';

/** The result of an operation that fails in an expected way. A failure is a value, and no operation throws. */
export type Result<TValue, TError> =
	{ readonly ok: true; readonly value: TValue } | { readonly ok: false; readonly error: TError };

/** What a file operation returns. */
export type FileResult<T> = Promise<Result<T, FileError>>;

/** A successful `Result`. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** A failed `Result`. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** Why a file operation failed, in terms that no backend changes. */
export type FileErrorCode =
	| 'aborted'
	| 'not_found'
	| 'permission_denied'
	| 'not_directory'
	| 'is_directory'
	| 'invalid'
	| 'not_supported'
	| 'unknown';

/** The error of a file operation. */
export class FileError extends Error {
	readonly code: FileErrorCode;
	/** The absolute path that the operation addressed, when known. */
	readonly path?: string;

	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'FileError';
		this.code = code;
		if (path !== undefined) this.path = path;
	}
}

/** Why a command did not run to its end, in terms that no backend changes. */
export type ExecutionErrorCode = 'aborted' | 'timeout' | 'spawn_error' | 'unknown';

/** The error of a command that did not run to its end. */
export class ExecutionError extends Error {
	readonly code: ExecutionErrorCode;

	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'ExecutionError';
		this.code = code;
	}
}

/** The facts of one file, directory, or symbolic link. A symbolic link is not followed. */
export interface FileInfo {
	/** The last segment of `path`. */
	readonly name: string;
	/** The absolute path that the operation addressed. */
	readonly path: string;
	readonly kind: 'file' | 'directory' | 'symlink';
	/** The size in bytes. */
	readonly size: number;
	/** The modification time, in milliseconds since the Unix epoch. */
	readonly mtimeMs: number;
}

/** The bounds of one output view. `retain` defaults to `tail`. */
export interface ShellOutputLimits {
	readonly maxBytes: number;
	readonly maxLines: number;
	readonly retain?: 'head' | 'tail';
}

/** What a view cut, and what the whole output held. */
export type ShellOutputTruncation = Omit<Truncation, 'content'>;

/** The bounded output of a command, and the facts of its cut. */
export interface ShellOutputView {
	readonly text: string;
	readonly truncation: ShellOutputTruncation;
}

/** What a command that ran to its end gives: the exit code and the facts of the cut. */
export interface ShellExecResult {
	readonly exitCode: number;
	readonly truncation: ShellOutputTruncation;
}

/** The options of one command. */
export interface WorkspaceExecOptions {
	/** The directory of the command. A relative path is under the `cwd` of the env. */
	readonly cwd?: string;
	/** Variables that the command sees in addition to the defaults of the backend. */
	readonly env?: Readonly<Record<string, string>>;
	/** Seconds until the command stops with the code `timeout`. Absent, the backend names the bound. */
	readonly timeout?: number;
	/**
	 * Seconds from `SIGTERM` to `SIGKILL` when an abort or the timeout stops
	 * the command. Absent or 0, the stop sends `SIGKILL` at once. A backend
	 * with no signals, such as just-bash, ends the command at once.
	 */
	readonly grace?: number;
	/** The bound of the output view. Absent, the view holds the whole output. */
	readonly capture?: { readonly limits: ShellOutputLimits };
	/** Receives the one view of the output, after the command ends and before `exec` resolves. */
	readonly onUpdate?: (view: ShellOutputView) => void;
}
