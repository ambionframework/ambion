/**
 * SFTP calls as promises, and the classification of an SFTP status into
 * Pi's `FileErrorCode`.
 *
 * OpenSSH's `sftp-server` answers with a coarse status: `ENOTDIR` comes back
 * as `NO_SUCH_FILE`, and `EISDIR`, `EEXIST`, and `ENOTEMPTY` all come back as
 * `FAILURE`. On either status, one `lstat` of the path, and of its parent when
 * the path is missing, picks the Pi code by the kind of operation. The
 * `lstat` runs after the failed call, so a change between the two can pick
 * the wrong code. It changes no file.
 */

import { posix } from 'node:path';
import { FileError, type FileErrorCode } from '@earendil-works/pi-agent-core';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';

/** The SFTP v3 status codes that `ssh2` puts on an error's `code`. */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;
const OP_UNSUPPORTED = 8;

/** What the failed call expected at the path: a file, a directory, or either. */
export type Expect = 'file' | 'directory' | 'any';

/** Run one callback-style SFTP call as a promise, and catch what it throws at once. */
export function call<T>(
	start: (done: (error: Error | undefined | null, value?: T) => void) => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		try {
			start((error, value) => (error ? reject(error) : resolve(value as T)));
		} catch (error) {
			reject(error);
		}
	});
}

/** The SFTP status on an `ssh2` error, or undefined for a fault of the connection. */
export function statusOf(error: unknown): number | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'number' ? code : undefined;
}

export function isMissing(error: unknown): boolean {
	return statusOf(error) === NO_SUCH_FILE;
}

export const lstat = (sftp: SFTPWrapper, path: string): Promise<Stats> =>
	call<Stats>((done) => sftp.lstat(path, done));

export const stat = (sftp: SFTPWrapper, path: string): Promise<Stats> =>
	call<Stats>((done) => sftp.stat(path, done));

export const readdir = (sftp: SFTPWrapper, path: string): Promise<FileEntryWithStats[]> =>
	call<FileEntryWithStats[]>((done) => sftp.readdir(path, done));

/** The kind of the object at `path`, or undefined when nothing is there. */
async function kindAt(sftp: SFTPWrapper, path: string): Promise<'directory' | 'other' | undefined> {
	try {
		return (await lstat(sftp, path)).isDirectory() ? 'directory' : 'other';
	} catch {
		return undefined;
	}
}

/** The Pi code for a path that exists, by what the call expected there. */
function codeForExisting(kind: 'directory' | 'other', expect: Expect): FileErrorCode {
	if (kind === 'directory' && expect === 'file') return 'is_directory';
	if (kind === 'other' && expect === 'directory') return 'not_directory';
	return 'invalid';
}

/** The Pi code for a path that is missing: a parent that is a file answers `not_directory`. */
async function codeForMissing(sftp: SFTPWrapper, path: string): Promise<FileErrorCode> {
	const parent = posix.dirname(path);
	if (parent === path) return 'not_found';
	return (await kindAt(sftp, parent)) === 'other' ? 'not_directory' : 'not_found';
}

async function coarseCode(sftp: SFTPWrapper, path: string, expect: Expect): Promise<FileErrorCode> {
	const kind = await kindAt(sftp, path);
	return kind === undefined ? codeForMissing(sftp, path) : codeForExisting(kind, expect);
}

/** Turn what one SFTP call threw into a `FileError`, with one `lstat` for a coarse status. */
export async function toFileError(
	sftp: SFTPWrapper,
	error: unknown,
	path: string,
	expect: Expect,
): Promise<FileError> {
	if (error instanceof FileError) return error;
	const cause = error instanceof Error ? error : new Error(String(error));
	const status = statusOf(error);
	if (status === PERMISSION_DENIED)
		return new FileError('permission_denied', cause.message, path, cause);
	if (status === OP_UNSUPPORTED) return new FileError('not_supported', cause.message, path, cause);
	if (status === NO_SUCH_FILE || status === FAILURE) {
		return new FileError(await coarseCode(sftp, path, expect), cause.message, path, cause);
	}
	return new FileError('unknown', cause.message, path, cause);
}
