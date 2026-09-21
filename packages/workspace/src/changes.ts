/**
 * A rotating, append-only JSONL log of the paths workspace tools changed,
 * kept on the workspace's own filesystem.
 *
 * The change log answers one question for a host or a summary: what changed
 * during an exchange. Each entry names the paths one successful call
 * changed, with the agent, the activation and the exchange it ran in. The
 * log is best-effort, like the audit log. The journal stays the record.
 *
 * The append and the rotation are `log.ts`'s shared mechanism. A record runs
 * inside the same queued operation as the tool call it describes.
 */

import { posix } from 'node:path';
import type { Context, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { appendLine, checkedLogPath, rotateIfDue } from './log.ts';

/** Where the log lives when the caller names no path. */
export const DEFAULT_CHANGE_LOG = '/workspace/changes.jsonl';

/** Bytes the file may hold before the next entry rotates it, when the caller names none. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** One successful tool call that changed paths on the workspace. */
export interface WorkspaceChange {
	/** When the call finished, as an ISO 8601 timestamp. */
	readonly time: string;
	/** Name of the room the call ran in. Empty for a call made outside a room. */
	readonly room: string;
	/** Name of the calling agent. */
	readonly agent: string;
	/** Name of the tool called. */
	readonly tool: string;
	/** The activation the call ran in. Absent for a call made outside a room. */
	readonly activation?: string;
	/** The exchange open when the activation read the record. Absent when none was open. */
	readonly exchange?: { readonly owner: string; readonly from: number };
	/** The absolute paths the call changed. */
	readonly paths: readonly string[];
}

/** The exchange whose changes a caller asks for. */
export interface ChangeQuery {
	readonly exchange: { readonly owner: string; readonly from: number };
}

export interface ChangeLogOptions {
	/** The JSONL file this log appends to. The default is `/workspace/changes.jsonl`. */
	readonly path?: string;
	/** Bytes the file may hold before the next entry rotates it. Default 5 MiB. */
	readonly maxBytes?: number;
	/** Told about a write or rotation failure. The call that triggered it still returns. */
	readonly onError?: (error: Error) => void;
}

export interface ChangeLog {
	readonly path: string;
	readonly maxBytes: number;
	/** Append one entry over `env`. Never throws: a failure goes to `onError` instead. */
	record(env: ExecutionEnv, entry: WorkspaceChange, context: Context): Promise<void>;
	/** Every entry, oldest first, including rotated files. Skips a line that does not parse. */
	read(env: ExecutionEnv, context: Context): Promise<WorkspaceChange[]>;
}

/** The entries that ran in the queried exchange. An entry with no exchange never matches. */
export function select(entries: readonly WorkspaceChange[], query: ChangeQuery): WorkspaceChange[] {
	return entries.filter(
		(entry) =>
			entry.exchange?.owner === query.exchange.owner && entry.exchange.from === query.exchange.from,
	);
}

/** The entries of one JSONL text. A line that does not parse is not an entry. */
function parse(text: string): WorkspaceChange[] {
	const entries: WorkspaceChange[] = [];
	for (const raw of text.split('\n')) {
		if (raw === '') continue;
		try {
			entries.push(JSON.parse(raw) as WorkspaceChange);
		} catch {
			// A torn line from a crash holds no complete entry.
		}
	}
	return entries;
}

/** Rotated files sort by their ISO timestamp, so name order is age order. */
async function filesOldestFirst(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<string[]> {
	const listed = await env.listDir(posix.dirname(path), context);
	if (!listed.ok) return [];
	const base = posix.basename(path);
	const rotated = listed.value
		.filter((file) => file.kind === 'file' && file.name.startsWith(`${base}.`))
		.map((file) => file.path)
		.sort();
	return [...rotated, path];
}

async function readAll(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<WorkspaceChange[]> {
	const entries: WorkspaceChange[] = [];
	for (const file of await filesOldestFirst(env, path, context)) {
		const text = await env.readTextFile(file, context);
		if (text.ok) entries.push(...parse(text.value));
	}
	return entries;
}

/** Tell `onError`, if one was given. A throwing callback must not replace the tool's own outcome. */
function reportError(onError: ((error: Error) => void) | undefined, error: unknown): void {
	try {
		onError?.(error instanceof Error ? error : new Error(String(error)));
	} catch {
		// Best-effort: a broken onError callback does not break the call itself.
	}
}

/** Open one rotating JSONL change log. `record` runs inside the caller's own `use` operation. */
export function openChangeLog(options: ChangeLogOptions = {}): ChangeLog {
	const path = checkedLogPath(options.path ?? DEFAULT_CHANGE_LOG, 'A change log path');
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const record = async (
		env: ExecutionEnv,
		entry: WorkspaceChange,
		context: Context,
	): Promise<void> => {
		try {
			await appendLine(env, path, `${JSON.stringify(entry)}\n`, context);
			await rotateIfDue(env, path, maxBytes, context);
		} catch (error) {
			reportError(options.onError, error);
		}
	};
	const read = (env: ExecutionEnv, context: Context) => readAll(env, path, context);
	return Object.freeze({ path, maxBytes, record, read });
}
