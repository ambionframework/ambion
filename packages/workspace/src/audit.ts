/**
 * A rotating, append-only JSONL log of workspace tool calls, kept on the
 * workspace's own filesystem.
 *
 * The log is an ordinary file: an agent reads it with `read` or `bash cat`,
 * the same as any file a peer wrote. Writing one entry runs as one more
 * operation on the bash resource after the call ends. Another operation can
 * run between the call and its entry. A rotation never races another agent's
 * write, because each entry is an operation on the one bash resource.
 *
 * The append and the rotation are `log.ts`'s shared mechanism. This module
 * adds what is specific to a tool-call entry: the JSONL shape, a short
 * fallback notice when the full entry will not serialize or will not fit,
 * and reporting a write failure to `onError` instead of the tool call.
 */

import type { WorkspaceEnv } from './backend.ts';
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
const DEFAULT_AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;

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
	readonly exchange?: { readonly person?: string; readonly from: number };
	/** The tool's full parameters. */
	readonly arguments: unknown;
	/**
	 * The tool's result. Absent when the call ended in `error`. An image
	 * content part keeps its shape, with its byte count in place of its data:
	 * the log records that the tool returned a picture, not the picture.
	 */
	readonly result?: unknown;
	/** Present when the call threw. A `ToolFailure` keeps the details of its result here. */
	readonly error?: { readonly name: string; readonly message: string; readonly details?: unknown };
}

export interface AuditLogOptions {
	/** The JSONL file this log appends to. The default is `/workspace/audit.jsonl`. */
	readonly path?: string;
	/** Bytes the file may hold before the next entry rotates it. Default 5 MiB. */
	readonly rotateBytes?: number;
	/**
	 * Told about a directory, write, or rotation failure, and about an entry
	 * that the bash resource refuses, as after `dispose`. The call still returns.
	 */
	readonly onError?: (error: Error) => void;
}

export interface AuditLog {
	readonly path: string;
	readonly rotateBytes: number;
	/** The callback of the options. The workspace tells it about an entry that a refused operation loses. */
	readonly onError?: (error: Error) => void;
	/** Append one entry over `env`. Never throws: a failure goes to `onError` instead. */
	append(env: WorkspaceEnv, entry: AuditEntry, signal?: AbortSignal): Promise<void>;
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
 * past `rotateBytes` once whichever line landed. The fallback retries the write
 * alone: a directory failure goes to `onError`, and it never reads as an
 * entry that is too large.
 */
async function recordEntry(
	env: WorkspaceEnv,
	path: string,
	rotateBytes: number,
	entry: AuditEntry,
	signal?: AbortSignal,
): Promise<void> {
	await ensureDir(env, path, signal);
	try {
		await appendOnly(env, path, line(entry), signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await appendOnly(env, path, notice(entry, 'RecordTooLarge', message), signal);
	}
	await rotateIfDue(env, path, rotateBytes, signal);
}

/**
 * Open one rotating JSONL audit log. `append` runs inside one `use`
 * operation of the bash resource. It needs no queue of its own, because the
 * bash resource runs one operation at a time.
 */
export function openAuditLog(options: AuditLogOptions = {}): AuditLog {
	const path = checkedLogPath(options.path ?? DEFAULT_AUDIT_LOG, 'An audit log path');
	const rotateBytes = checkedByteThreshold(
		options.rotateBytes ?? DEFAULT_AUDIT_ROTATE_BYTES,
		'rotateBytes',
	);
	const append = (env: WorkspaceEnv, entry: AuditEntry, signal?: AbortSignal): Promise<void> =>
		bestEffort(() => recordEntry(env, path, rotateBytes, entry, signal), options.onError);
	return Object.freeze({
		path,
		rotateBytes,
		...(options.onError === undefined ? {} : { onError: options.onError }),
		append,
	});
}

/** Guidance telling an agent the log exists, where it lives, and what it holds. */
export function auditGuidance(log: AuditLog): string {
	return [
		`Every tool call on this workspace is recorded at ${log.path}, one JSON line per`,
		`call: the room, the agent, the tool, the activation and the exchange it ran in,`,
		`its full arguments, and its full result or error. Read it to see what happened`,
		`here. Filter it with jq: select on room, tool, agent, or activation to find one`,
		`call among many.`,
	].join('\n');
}
