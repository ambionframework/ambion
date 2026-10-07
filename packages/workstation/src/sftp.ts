/**
 * SFTP calls as promises, and the classification of an SFTP status into
 * a `FileErrorCode` of the workspace port.
 *
 * OpenSSH's `sftp-server` answers with a coarse status: `ENOTDIR` comes back
 * as `NO_SUCH_FILE`, and `EISDIR`, `EEXIST`, and `ENOTEMPTY` all come back as
 * `FAILURE`. On either status, one `lstat` of the path, and of its parent when
 * the path is missing, picks the code by the kind of operation. The
 * `lstat` runs after the failed call, so a change between the two can pick
 * the wrong code. It changes no file.
 */

import { posix } from 'node:path';
import type { FileErrorCode, FileExpect } from '@ambionframework/workspace';
import { FileError } from '@ambionframework/workspace';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';

/** The SFTP v3 status codes that `ssh2` puts on an error's `code`. */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;
const FAILURE = 4;
const OP_UNSUPPORTED = 8;

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

/** The most bytes that one whole-file read returns. A range read has no such limit. */
const MAX_READ_BYTES = 10 * 1024 * 1024;

/** The size of one SFTP read request. `ssh2` splits a request that is longer than the server takes. */
const CHUNK_BYTES = 256 * 1024;

const refuseSize = (path: string, size: string): FileError =>
	new FileError(
		'invalid',
		`${path} is ${size}, more than the ${MAX_READ_BYTES} bytes that a read returns.`,
		path,
	);

/** Read the chunks of an open handle, and count them against the limit. */
async function readChunks(
	sftp: SFTPWrapper,
	handle: Buffer,
	path: string,
	stopped: () => boolean,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	while (!stopped()) {
		const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
		const count = await call<number>((done) =>
			sftp.read(handle, chunk, 0, CHUNK_BYTES, total, done),
		);
		if (count === 0) return Buffer.concat(chunks, total);
		total += count;
		if (total > MAX_READ_BYTES) throw refuseSize(path, 'larger than its size on `stat`');
		chunks.push(chunk.subarray(0, count));
	}
	throw new Error('The session ended during the read.');
}

/**
 * The facts of the regular file at `path`. The check runs before an open,
 * because an open of a FIFO blocks the SFTP server.
 */
async function regularFile(sftp: SFTPWrapper, path: string): Promise<Stats> {
	const stats = await stat(sftp, path);
	if (stats.isDirectory()) throw new FileError('is_directory', `${path} is a directory.`, path);
	if (!stats.isFile()) throw new FileError('invalid', `${path} is not a regular file.`, path);
	return stats;
}

/**
 * Read one regular file of at most `MAX_READ_BYTES`. The size that `stat`
 * reports and the bytes that arrive both count, so a file that grows or
 * reports size 0 stops at the limit. The handle closes on every path.
 * `stopped` ends the loop when the session ends.
 */
export async function readBounded(
	sftp: SFTPWrapper,
	path: string,
	stopped: () => boolean,
): Promise<Buffer> {
	const stats = await regularFile(sftp, path);
	if (stats.size > MAX_READ_BYTES) throw refuseSize(path, `${stats.size} bytes`);
	const handle = await call<Buffer>((done) => sftp.open(path, 'r', done));
	try {
		return await readChunks(sftp, handle, path, stopped);
	} finally {
		sftp.close(handle, () => undefined);
	}
}

/** Read `length` bytes of an open handle from `start`, or fewer at the end of the file. */
async function readFrom(
	sftp: SFTPWrapper,
	handle: Buffer,
	start: number,
	length: number,
	stopped: () => boolean,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	while (total < length) {
		if (stopped()) throw new Error('The session ended during the read.');
		const want = Math.min(CHUNK_BYTES, length - total);
		const chunk = Buffer.allocUnsafe(want);
		const count = await call<number>((done) =>
			sftp.read(handle, chunk, 0, want, start + total, done),
		);
		if (count === 0) break;
		total += count;
		chunks.push(chunk.subarray(0, count));
	}
	return Buffer.concat(chunks, total);
}

/**
 * Read at most `length` bytes of one regular file from the byte `start`. The
 * read has no size limit: it asks for `CHUNK_BYTES` at a time and stops at
 * `length` bytes or at the end of the file. The handle closes on every path.
 * `stopped` ends the loop when the session ends.
 */
export async function readRange(
	sftp: SFTPWrapper,
	path: string,
	start: number,
	length: number,
	stopped: () => boolean,
): Promise<Buffer> {
	await regularFile(sftp, path);
	const handle = await call<Buffer>((done) => sftp.open(path, 'r', done));
	try {
		return await readFrom(sftp, handle, start, length, stopped);
	} finally {
		sftp.close(handle, () => undefined);
	}
}

/** The kind of the object at `path`, or undefined when nothing is there. */
async function kindAt(sftp: SFTPWrapper, path: string): Promise<'directory' | 'other' | undefined> {
	try {
		return (await lstat(sftp, path)).isDirectory() ? 'directory' : 'other';
	} catch {
		return undefined;
	}
}

/** The code for a path that exists, by what the call expected there. */
function codeForExisting(kind: 'directory' | 'other', expect: FileExpect): FileErrorCode {
	if (kind === 'directory' && expect === 'file') return 'is_directory';
	if (kind === 'other' && expect === 'directory') return 'not_directory';
	return 'invalid';
}

/** The code for a path that is missing: a parent that is a file answers `not_directory`. */
async function codeForMissing(sftp: SFTPWrapper, path: string): Promise<FileErrorCode> {
	const parent = posix.dirname(path);
	if (parent === path) return 'not_found';
	return (await kindAt(sftp, parent)) === 'other' ? 'not_directory' : 'not_found';
}

async function coarseCode(
	sftp: SFTPWrapper,
	path: string,
	expect: FileExpect,
): Promise<FileErrorCode> {
	const kind = await kindAt(sftp, path);
	return kind === undefined ? codeForMissing(sftp, path) : codeForExisting(kind, expect);
}

/** Turn what one SFTP call threw into a `FileError`, with one `lstat` for a coarse status. */
export async function toFileError(
	sftp: SFTPWrapper,
	error: unknown,
	path: string,
	expect: FileExpect,
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
