/**
 * A rotating, append-only file on the workspace filesystem: the core every
 * append-only log in this package shares.
 *
 * `openLog` is the ready-made form: one absolute path, one JSON-compatible
 * record per line. `ensureDir`, `appendOnly`, and `rotateIfDue` are the
 * pieces it is built from. Another log with its own entry shape and its own
 * failure handling, such as the tool-call log of `audit.ts`, uses the same
 * pieces. `ensureDir` and `appendOnly` are two calls: a caller that retries
 * a failed write with a fallback line retries the write alone, so a
 * directory failure never reads as a failed write.
 *
 * A caller supplies `env` on every call, not once at open: a log opens once,
 * over no filesystem in particular, and every append names the connection it
 * runs over. This is what lets one log outlive any single agent's
 * connection, the way the workspace's own tools do.
 *
 * `path` must be an absolute file path, normalized, with no trailing slash.
 * A relative path resolves against the home of whichever agent connects
 * first, so two agents would each write and read a different file. A
 * trailing slash or an unnormalized path (a doubled slash, a `.` or `..`
 * segment) can name one file on one backend and another on the next. The
 * log refuses each at open.
 *
 * Rotation runs after a write, never before: the record that first pushes
 * the file past the threshold stays in the file it landed in, and the next
 * record starts the fresh one. A record is never split.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Context, ExecutionEnv, JsonValue } from '@earendil-works/pi-agent-core';

/** Bytes a log may hold before the next append rotates it, when a caller names none. */
const DEFAULT_ROTATE_BYTES = 8 * 1024 * 1024;

/** `path`, or a thrown error naming what needed it to be an absolute, normalized file path. */
export function checkedLogPath(path: string, of: string): string {
	if (!posix.isAbsolute(path) || path.endsWith('/') || posix.normalize(path) !== path) {
		throw new Error(`${of} must be an absolute file path, with no trailing slash: '${path}'.`);
	}
	return path;
}

/** A positive, finite byte count, or a thrown error naming what needed one. */
export function checkedByteThreshold(bytes: number, of: string): number {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		throw new Error(`${of} must be a positive, finite number, not ${bytes}.`);
	}
	return bytes;
}

/**
 * The name a rotated file takes. The random suffix keeps two rotations in
 * the same millisecond from naming the same file, which would otherwise
 * drop the earlier one.
 */
function rotatedName(path: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return `${path}.${stamp}-${randomBytes(3).toString('hex')}`;
}

/** The suffix `rotatedName` adds: the ISO time with `:` and `.` as `-`, and six hex digits. */
const ROTATED = /^\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;

/** Whether `name` is the log file `fileName` or a file that `rotatedName` made of it. */
export function isLogFile(name: string, fileName: string): boolean {
	return (
		name === fileName || (name.startsWith(fileName) && ROTATED.test(name.slice(fileName.length)))
	);
}

/** Create the parent directory of `path`. */
export async function ensureDir(env: ExecutionEnv, path: string, context: Context): Promise<void> {
	const made = await env.createDir(posix.dirname(path), { recursive: true }, context);
	if (!made.ok) throw made.error;
}

/** Append `text` to `path`. The parent directory must exist. */
export async function appendOnly(
	env: ExecutionEnv,
	path: string,
	text: string,
	context: Context,
): Promise<void> {
	const appended = await env.appendFile(path, text, context);
	if (!appended.ok) throw appended.error;
}

/** Rename `path` aside under a timestamped name once it has reached `rotateBytes`. */
export async function rotateIfDue(
	env: ExecutionEnv,
	path: string,
	rotateBytes: number,
	context: Context,
): Promise<void> {
	const info = await env.fileInfo(path, context);
	if (!info.ok) throw info.error;
	if (info.value.size < rotateBytes) return;
	const renamed = await env.renameFile(path, rotatedName(path), context);
	if (!renamed.ok) throw renamed.error;
}

/**
 * Run `work`, and give a failure to `onError` in place of the caller. A log
 * that keeps a second copy, such as the audit log or the room mirror, must
 * not fail the work that it records. A throwing `onError` changes nothing.
 */
export async function bestEffort(
	work: () => Promise<void>,
	onError: ((error: Error) => void) | undefined,
): Promise<void> {
	try {
		await work();
	} catch (error) {
		try {
			onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// The work failed once already. A broken callback does not break the caller.
		}
	}
}

export interface WorkspaceLogOptions {
	/** The absolute path this log appends to. */
	readonly path: string;
	/** Bytes the file may hold before the next append rotates it. */
	readonly rotateBytes?: number;
}

/** One append-only JSON Lines log, at one absolute path. */
export interface WorkspaceLog {
	readonly path: string;
	readonly rotateBytes: number;
	/** Append one JSON-compatible record as one line over `env`. */
	append(env: ExecutionEnv, record: JsonValue, context: Context): Promise<void>;
}

/**
 * Open one append-only log at `options.path`. Opening a log does no I/O; the
 * path is created on the first `append`.
 */
export function openLog(options: WorkspaceLogOptions): WorkspaceLog {
	const path = checkedLogPath(options.path, 'A log path');
	const rotateBytes = checkedByteThreshold(
		options.rotateBytes ?? DEFAULT_ROTATE_BYTES,
		'rotateBytes',
	);
	const log: WorkspaceLog = {
		path,
		rotateBytes,
		async append(env, record, context) {
			await ensureDir(env, path, context);
			await appendOnly(env, path, `${JSON.stringify(record)}\n`, context);
			await rotateIfDue(env, path, rotateBytes, context);
		},
	};
	return Object.freeze(log);
}
