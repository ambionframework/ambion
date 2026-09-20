/**
 * A rotating, append-only JSONL audit log for workspace tool calls.
 *
 * The log lives outside the backend's filesystem: a shell or file tool an
 * agent calls cannot read, edit, or remove its own record. Every write
 * serializes through one queue, so two calls that finish out of order still
 * land as separate, complete lines.
 */

import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

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
	/** The JSONL file this log appends to. A rotated file sits beside it. */
	readonly path: string;
	/** Bytes the file may hold before the next entry rotates it. Default 5 MiB. */
	readonly maxBytes?: number;
	/** Told about a write or rotation failure. The call that triggered it still returns. */
	readonly onError?: (error: Error) => void;
}

export interface AuditLog {
	/** Append one entry. Never rejects: a failure goes to `onError` instead. */
	record(entry: AuditEntry): Promise<void>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

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
 * Move the current file aside so the next append starts a fresh one. The
 * random suffix keeps two rotations in the same millisecond from naming the
 * same file, which would otherwise drop the earlier one.
 */
async function rotate(path: string): Promise<void> {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const suffix = randomBytes(3).toString('hex');
	await rename(path, `${path}.${stamp}-${suffix}`);
}

/**
 * Open one rotating JSONL audit log at `options.path`. Every `record` call
 * queues behind the one before it, so the file, and its rotation, stay
 * correct under concurrent calls.
 */
export function openAuditLog(options: AuditLogOptions): AuditLog {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	let tail = Promise.resolve();

	const append = async (entry: AuditEntry): Promise<void> => {
		await mkdir(dirname(options.path), { recursive: true });
		await appendFile(options.path, line(entry), 'utf8');
		const info = await stat(options.path);
		if (info.size >= maxBytes) await rotate(options.path);
	};

	const record = (entry: AuditEntry): Promise<void> => {
		const task = tail.then(
			() => append(entry),
			() => append(entry),
		);
		tail = task.then(
			() => undefined,
			() => undefined,
		);
		return task.catch((error: unknown) => {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
		});
	};

	return Object.freeze({ record });
}
