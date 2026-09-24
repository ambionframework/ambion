/**
 * A rotating, append-only JSONL log of workspace tool calls, kept on the
 * workspace's own filesystem.
 *
 * The log is an ordinary file: an agent reads it with `read` or `bash cat`,
 * the same as any file a peer wrote. Writing one entry runs inside the same
 * queued operation as the tool call it records, over the same `ExecutionEnv`,
 * so the entry and the call it describes never separate under concurrent
 * work, and a rotation never races another agent's write.
 *
 * The append and the rotation are `log.ts`'s shared mechanism. This module
 * adds what is specific to a tool-call entry: the JSONL shape, a short
 * fallback notice when the full entry will not serialize or will not fit,
 * and reporting a write failure to `onError` instead of the tool call.
 */

import type { Context, ExecutionEnv } from '@earendil-works/pi-agent-core';
import {
	appendOnly,
	bestEffort,
	checkedByteThreshold,
	checkedLogPath,
	ensureDir,
	rotateIfDue,
} from './log.ts';

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
	/** The activation the call ran in. Absent for a call made outside a room. */
	readonly activation?: string;
	/** The exchange open when the activation read the record. Absent when none was open. */
	readonly exchange?: { readonly owner: string; readonly from: number };
	/** The tool's full parameters. */
	readonly arguments: unknown;
	/**
	 * The tool's result. Absent when the call ended in `error`. An image
	 * content part keeps its shape, with its byte count in place of its data:
	 * the log records that the tool returned a picture, not the picture.
	 */
	readonly result?: unknown;
	/** Present when the call threw. */
	readonly error?: { readonly name: string; readonly message: string };
}

export interface AuditLogOptions {
	/** The JSONL file this log appends to. The default is `/workspace/audit.jsonl`. */
	readonly path?: string;
	/** Bytes the file may hold before the next entry rotates it. Default 5 MiB. */
	readonly maxBytes?: number;
	/** Told about a directory, write, or rotation failure. The call that triggered it still returns. */
	readonly onError?: (error: Error) => void;
}

export interface AuditLog {
	readonly path: string;
	readonly maxBytes: number;
	/** Append one entry over `env`. Never throws: a failure goes to `onError` instead. */
	record(env: ExecutionEnv, entry: AuditEntry, context: Context): Promise<void>;
}

/** A short line in place of the full entry, naming why the full one could not be written. */
function notice(entry: AuditEntry, name: string, message: string): string {
	return `${JSON.stringify({
		time: entry.time,
		room: entry.room,
		agent: entry.agent,
		tool: entry.tool,
		callId: entry.callId,
		...(entry.activation === undefined ? {} : { activation: entry.activation }),
		error: { name, message },
	})}\n`;
}

/** One JSONL line for `entry`, falling back to a short notice if it will not serialize. */
function line(entry: AuditEntry): string {
	try {
		return `${JSON.stringify(entry)}\n`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return notice(entry, 'SerializationError', message);
	}
}

/**
 * Append one line, falling back to a short notice when the filesystem
 * refuses the full entry (an oversized `write` call's content, past the
 * room left on a bounded backend), so the call still leaves a trace. Rotates
 * past `maxBytes` once whichever line landed. The fallback retries the write
 * alone: a directory failure goes to `onError`, and it never reads as an
 * entry that is too large.
 */
async function recordEntry(
	env: ExecutionEnv,
	path: string,
	maxBytes: number,
	entry: AuditEntry,
	context: Context,
): Promise<void> {
	await ensureDir(env, path, context);
	try {
		await appendOnly(env, path, line(entry), context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await appendOnly(env, path, notice(entry, 'RecordTooLarge', message), context);
	}
	await rotateIfDue(env, path, maxBytes, context);
}

/**
 * Open one rotating JSONL audit log. `record` runs inside the caller's own
 * `use` operation, so it needs no queue of its own: the workspace resource
 * already lets one operation touch the filesystem at a time.
 */
export function openAuditLog(options: AuditLogOptions = {}): AuditLog {
	const path = checkedLogPath(options.path ?? DEFAULT_AUDIT_LOG, 'An audit log path');
	const maxBytes = checkedByteThreshold(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes');
	const record = (env: ExecutionEnv, entry: AuditEntry, context: Context): Promise<void> =>
		bestEffort(() => recordEntry(env, path, maxBytes, entry, context), options.onError);
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
		`call: the room, the agent, the tool, the activation and the exchange it ran in,`,
		`its full arguments, and its full result or error. Read it to see what happened`,
		`here, including calls other agents and other rooms made. Filter it with jq:`,
		`select on room, tool, agent, or activation to find one call among many. Past`,
		`${humanBytes(log.maxBytes)} the file rotates: it moves beside itself under a`,
		`timestamped name, and a new file starts at ${log.path}.`,
	].join('\n');
}
