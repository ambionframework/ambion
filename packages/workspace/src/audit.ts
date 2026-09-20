/**
 * A rotating, append-only JSONL log of workspace tool calls, kept on the
 * workspace's own filesystem.
 *
 * The log is an ordinary file: an agent reads it with `read` or `bash cat`,
 * the same as any file a peer wrote. Writing one entry runs inside the same
 * queued operation as the tool call it records, over the same `ExecutionEnv`,
 * so the entry and the call it describes never separate under concurrent
 * work, and a rotation never races another agent's write.
 */

import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Context, ExecutionEnv } from '@earendil-works/pi-agent-core';

/** Where the log lives when the caller names no path. */
export const DEFAULT_AUDIT_LOG = '/workspace/audit.jsonl';

/** Bytes the file may hold before the next entry rotates it, when the caller names none. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** One workspace tool call, as the audit log records it. */
export interface AuditEntry {
	/** When the call finished, as an ISO 8601 timestamp. */
	readonly time: string;
	/** Name of the room the call ran in. Empty for a call made outside a room. */
	readonly room: string;
	/** Name of the calling agent. */
	readonly agent: string;
	/** Name of the tool called. */
	readonly tool: string;
	readonly callId: string;
	/** The tool's full parameters. */
	readonly arguments: unknown;
	/** The tool's full result. Absent when the call ended in `error`. */
	readonly result?: unknown;
	/** Present when the call threw instead of returning. */
	readonly error?: { readonly name: string; readonly message: string };
}

export interface AuditLogOptions {
	/** The JSONL file this log appends to. The default is `/workspace/audit.jsonl`. */
	readonly path?: string;
	/** Bytes the file may hold before the next entry rotates it. Default 5 MiB. */
	readonly maxBytes?: number;
	/** Told about a write or rotation failure. The call that triggered it still returns. */
	readonly onError?: (error: Error) => void;
}

export interface AuditLog {
	readonly path: string;
	readonly maxBytes: number;
	/** Append one entry over `env`. Never throws: a failure goes to `onError` instead. */
	record(env: ExecutionEnv, entry: AuditEntry, context: Context): Promise<void>;
}

/** One JSONL line for `entry`, falling back to a short notice if it will not serialize. */
function line(entry: AuditEntry): string {
	try {
		return `${JSON.stringify(entry)}\n`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `${JSON.stringify({
			time: entry.time,
			room: entry.room,
			agent: entry.agent,
			tool: entry.tool,
			callId: entry.callId,
			error: { name: 'SerializationError', message },
		})}\n`;
	}
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

/** Append one line, creating the parent directory first, and rotate past `maxBytes`. */
async function append(
	env: ExecutionEnv,
	path: string,
	maxBytes: number,
	entry: AuditEntry,
	context: Context,
): Promise<void> {
	const made = await env.createDir(posix.dirname(path), { recursive: true }, context);
	if (!made.ok) throw made.error;
	const appended = await env.appendFile(path, line(entry), context);
	if (!appended.ok) throw appended.error;
	const info = await env.fileInfo(path, context);
	if (!info.ok) throw info.error;
	if (info.value.size >= maxBytes) {
		const renamed = await env.renameFile(path, rotatedName(path), context);
		if (!renamed.ok) throw renamed.error;
	}
}

/**
 * Open one rotating JSONL audit log. `record` runs inside the caller's own
 * `use` operation, so it needs no queue of its own: the workspace resource
 * already lets one operation touch the filesystem at a time.
 */
export function openAuditLog(options: AuditLogOptions = {}): AuditLog {
	const path = options.path ?? DEFAULT_AUDIT_LOG;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const record = async (env: ExecutionEnv, entry: AuditEntry, context: Context): Promise<void> => {
		try {
			await append(env, path, maxBytes, entry, context);
		} catch (error) {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	};
	return Object.freeze({ path, maxBytes, record });
}

/** `maxBytes` as whole mebibytes or kibibytes when it divides evenly, bytes otherwise. */
function humanBytes(bytes: number): string {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
	return `${bytes} bytes`;
}

/** Guidance telling an agent the log exists, where it lives, and what it holds. */
export function auditGuidance(log: AuditLog): string {
	return [
		`Every tool call on this workspace is recorded at ${log.path}, one JSON line per`,
		`call: the room, the agent, the tool, its full arguments, and its full result or`,
		`error. Read it to see what happened here, including calls other agents made. Past`,
		`${humanBytes(log.maxBytes)} the file rotates: it moves beside itself under a`,
		`timestamped name, and a new file starts at ${log.path}.`,
	].join('\n');
}
