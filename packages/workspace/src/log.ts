/**
 * An append-only JSON Lines log, scoped to one directory and rotated by size.
 *
 * A log holds one active file and every file it has rotated, all under one
 * root directory a caller names at open. `append` writes one JSON-compatible
 * record as one line to the active file, and rotates that file first when it
 * has reached the byte threshold. A record is never split across a rotation:
 * rotation runs before a write, never in the middle of one.
 *
 * **A log stays inside its root.** `fileName` names one plain file, with no
 * path separator, so a caller cannot point a log's writes outside `root`
 * through the name. Two logs at two roots on one workspace never collide, so
 * a host opens one log per concern: a room's full record, an audit trail, a
 * metrics feed, each at its own path.
 *
 * **Rotation reads the directory, not memory.** The rotation index counts up
 * from the highest one already on disk, so a log opened again after a
 * restart keeps counting where the last run left off, with no in-memory
 * count to lose.
 *
 * A log is one core over `ExecutionEnv`, the filesystem port every workspace
 * backend implements. `append` must run one call at a time over one log; a
 * caller inside `resource.use()` gets this for free from the owner's queue.
 *
 * The design contract is `docs/workspace.md`.
 */

import { posix } from 'node:path';
import type { Context, ExecutionEnv, JsonValue } from '@earendil-works/pi-agent-core';

/** Bytes past which a log rotates before its next append, when a caller names none. */
export const DEFAULT_ROTATE_BYTES = 8 * 1024 * 1024;

/** Name for a log's active file, when a caller names none. */
export const DEFAULT_LOG_FILE = 'log.jsonl';

export interface WorkspaceLogOptions {
	/** The directory every file this log writes stays under. Created on first append. */
	readonly root: string;
	/** Name of the active file under root. One plain segment, no path separator. */
	readonly fileName?: string;
	/** Bytes past which the active file rotates before the next append. */
	readonly rotateBytes?: number;
}

/** One append-only JSON Lines log, confined to `root`. */
export interface WorkspaceLog {
	/** The directory every file this log writes stays under. */
	readonly root: string;
	/** Name of the active file under root. */
	readonly fileName: string;
	/** The active file's path, under root. */
	readonly activePath: string;
	/**
	 * Append one JSON-compatible record as one line. Rotates the active file
	 * first when it has reached the byte threshold.
	 */
	append(record: JsonValue, context: Context): Promise<void>;
}

function checkedFileName(fileName: string): string {
	if (fileName === '' || fileName.includes('/') || fileName === '.' || fileName === '..') {
		throw new Error(`A log file name must be one plain segment, not a path: '${fileName}'.`);
	}
	return fileName;
}

function checkedRotateBytes(rotateBytes: number): number {
	if (!Number.isFinite(rotateBytes) || rotateBytes <= 0) {
		throw new Error(`rotateBytes must be a positive number, not ${rotateBytes}.`);
	}
	return rotateBytes;
}

/** A file name's stem and extension, split at its last dot. No dot leaves the extension empty. */
function splitName(fileName: string): { stem: string; ext: string } {
	const dot = fileName.lastIndexOf('.');
	if (dot <= 0) return { stem: fileName, ext: '' };
	return { stem: fileName.slice(0, dot), ext: fileName.slice(dot) };
}

/** The rotation index a rotated name carries, or nothing when the name does not match this log. */
function rotationIndex(name: string, stem: string, ext: string): number | undefined {
	const prefix = `${stem}.`;
	if (!name.startsWith(prefix) || !name.endsWith(ext)) return undefined;
	const middle = name.slice(prefix.length, name.length - ext.length);
	const index = Number.parseInt(middle, 10);
	if (!Number.isSafeInteger(index) || index <= 0 || `${index}` !== middle) return undefined;
	return index;
}

/**
 * One past the highest rotation index already on disk for this log's name.
 * Read fresh from the directory on every rotation, so no in-memory count
 * survives a restart, and none needs to.
 */
async function nextRotationIndex(
	env: ExecutionEnv,
	root: string,
	stem: string,
	ext: string,
	context: Context,
): Promise<number> {
	const listed = await env.listDir(root, context);
	if (!listed.ok) {
		if (listed.error.code === 'not_found') return 1;
		throw listed.error;
	}
	let max = 0;
	for (const entry of listed.value) {
		if (entry.kind !== 'file') continue;
		const index = rotationIndex(entry.name, stem, ext);
		if (index !== undefined && index > max) max = index;
	}
	return max + 1;
}

/** Rename the active file aside when it has reached the byte threshold. A missing file needs none. */
async function rotateIfDue(
	env: ExecutionEnv,
	root: string,
	activePath: string,
	stem: string,
	ext: string,
	rotateBytes: number,
	context: Context,
): Promise<void> {
	const info = await env.fileInfo(activePath, context);
	if (!info.ok) {
		if (info.error.code === 'not_found') return;
		throw info.error;
	}
	if (info.value.size < rotateBytes) return;
	const index = await nextRotationIndex(env, root, stem, ext, context);
	const rotated = posix.join(root, `${stem}.${index}${ext}`);
	const renamed = await env.renameFile(activePath, rotated, context);
	if (!renamed.ok) throw renamed.error;
}

/**
 * Open one append-only log over `env`, confined to `options.root`.
 *
 * Every path this log touches is under `root`: the active file at
 * `root/fileName`, and every file rotated beside it. Opening a log does no
 * I/O; `root` is created on the first `append`.
 */
export function openLog(env: ExecutionEnv, options: WorkspaceLogOptions): WorkspaceLog {
	const fileName = checkedFileName(options.fileName ?? DEFAULT_LOG_FILE);
	const rotateBytes = checkedRotateBytes(options.rotateBytes ?? DEFAULT_ROTATE_BYTES);
	const { root } = options;
	const activePath = posix.join(root, fileName);
	const { stem, ext } = splitName(fileName);

	const log: WorkspaceLog = {
		root,
		fileName,
		activePath,
		async append(record, context) {
			const made = await env.createDir(root, { recursive: true }, context);
			if (!made.ok) throw made.error;
			await rotateIfDue(env, root, activePath, stem, ext, rotateBytes, context);
			const written = await env.appendFile(activePath, `${JSON.stringify(record)}\n`, context);
			if (!written.ok) throw written.error;
		},
	};
	return Object.freeze(log);
}
