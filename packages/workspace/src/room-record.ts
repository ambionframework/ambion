/**
 * A room's message record, mirrored to the workspace as one JSONL file per
 * room.
 *
 * The record lives at `/rooms/<room name>/messages.jsonl`, one line per
 * message, in the room's own order. It is an ordinary file: an agent reads
 * it with `read` or `bash cat`, the same as any file a peer wrote.
 *
 * This is a secondary, best-effort copy. `packages/journal` remains the
 * source of truth for the room; a write failure here calls `onError` and
 * the room keeps running. Recovery follows the same recipe
 * `docs/durability.md` gives any external reader: subscribe first, then
 * backfill from the highest `seq` already on disk, so a restart neither
 * misses a message nor writes one twice.
 */

import { posix } from 'node:path';
import type { Message, Room, Seq } from '@ambionframework/ambion';
import type { Context, ExecutionEnv, JsonValue } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { openLog } from './log.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

/** The directory every room's message record lives under. */
const ROOMS_ROOT = '/rooms';

/** One line of a room's message record. */
export type RoomMessageEntry = Message & { readonly room: string };

export interface RoomRecordOptions {
	/** Told about a write or rotation failure. The room keeps running either way. */
	readonly onError?: (error: Error) => void;
}

export interface RoomRecord {
	readonly room: string;
	readonly path: string;
	/** Unsubscribe from the room and let the current append settle. Idempotent. */
	stop(): Promise<void>;
}

/**
 * The path one room's message record lives at, or a thrown error naming the
 * room. A room's name is not validated at the kernel today, and this is the
 * first place one turns into a filesystem path: a name holding `..` or an
 * extra `/` must not resolve outside `/rooms`.
 */
export function roomRecordPath(roomName: string): string {
	const path = `${ROOMS_ROOT}/${roomName}/messages.jsonl`;
	if (posix.normalize(path) !== path) {
		throw new Error(`Room name is not safe to use as a path: '${roomName}'.`);
	}
	return path;
}

/** Guidance telling an agent the record exists, where it lives, and what it holds. */
export function roomRecordGuidance(): string {
	return [
		`Every room using this workspace keeps its message record at`,
		`${ROOMS_ROOT}/<room name>/messages.jsonl, one JSON line per message, in`,
		`the order the room recorded it. Read your own room's file with read or`,
		`bash cat.`,
		``,
		`Every line carries room, kind, and seq. kind is said, arrived, left,`,
		`seated, unseated, or summary.`,
		`- said: from, to (absent for a broadcast), text.`,
		`- arrived, left, seated, unseated: subject, and identity on arrived`,
		`  and seated.`,
		`- summary: from, to, text, and covers: { from, through }, the seq`,
		`  range it stands for.`,
		``,
		`Past 8 MiB the file rotates: it moves beside itself under a`,
		`timestamped name, and a new file starts at the same path.`,
	].join('\n');
}

/** The `seq` field of the last non-empty line in `path`, or undefined. */
async function lastLineSeq(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<Seq | undefined> {
	const read = await env.readTextFile(path, context);
	if (!read.ok) return undefined;
	const lines = read.value.split('\n').filter((line) => line !== '');
	const last = lines.at(-1);
	if (last === undefined) return undefined;
	try {
		const parsed = JSON.parse(last) as { seq?: unknown };
		return typeof parsed.seq === 'number' ? parsed.seq : undefined;
	} catch {
		return undefined;
	}
}

/** Whether `name` is this log's active file or one it has rotated to. */
function isLogFile(name: string, fileName: string): boolean {
	return name === fileName || name.startsWith(`${fileName}.`);
}

/** The higher of two possibly-absent sequences. */
function higher(a: Seq | undefined, b: Seq | undefined): Seq | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a > b ? a : b;
}

/**
 * The highest `seq` already recorded under `dir`, across the active file and
 * every file it has rotated to. A missing directory has recorded nothing.
 */
async function lastRecordedSeq(
	env: ExecutionEnv,
	dir: string,
	fileName: string,
	context: Context,
): Promise<Seq | undefined> {
	const listed = await env.listDir(dir, context);
	if (!listed.ok) {
		if (listed.error.code === 'not_found') return undefined;
		throw listed.error;
	}
	let max: Seq | undefined;
	for (const entry of listed.value) {
		if (entry.kind !== 'file' || !isLogFile(entry.name, fileName)) continue;
		const seq = await lastLineSeq(env, posix.join(dir, entry.name), context);
		max = higher(max, seq);
	}
	return max;
}

/** Tell `onError`, if one was given. A throwing callback must not replace the write it is reporting on. */
function reportError(onError: ((error: Error) => void) | undefined, error: unknown): void {
	try {
		onError?.(error instanceof Error ? error : new Error(String(error)));
	} catch {
		// Best-effort: the write already failed once; a broken onError
		// callback does not get a second chance to break anything else.
	}
}

/**
 * Start mirroring `room`'s messages to `roomRecordPath(room.name)` over
 * `drive`. Subscribes before it reads, so nothing lands during recovery is
 * missed, then backfills from the highest `seq` already on disk. A message
 * already accounted for, from either source, is not written twice.
 */
export async function recordRoomMessages(
	room: Room,
	drive: WorkspaceResource,
	agent: WorkspaceAgent,
	options: RoomRecordOptions = {},
): Promise<RoomRecord> {
	const path = roomRecordPath(room.name);
	const dir = posix.dirname(path);
	const fileName = posix.basename(path);
	const log = openLog({ path });

	let appendedSeq: Seq | undefined = await drive.use(agent, (env) =>
		lastRecordedSeq(env, dir, fileName, BACKGROUND_CONTEXT),
	);
	let pending: Promise<void> = Promise.resolve();
	let stopped = false;

	const append = (message: Message): void => {
		if (stopped) return;
		if (appendedSeq !== undefined && message.seq <= appendedSeq) return;
		appendedSeq = message.seq;
		const entry: RoomMessageEntry = { ...message, room: room.name };
		// Message is already required to survive structuredClone as journal
		// data (docs/durability.md §2); JsonValue's index signature is the
		// one thing a named interface never satisfies structurally.
		pending = drive
			.use(agent, (env) => log.append(env, entry as unknown as JsonValue, BACKGROUND_CONTEXT))
			.catch((error: unknown) => reportError(options.onError, error));
	};

	const unsubscribe = room.subscribe((event) => {
		if (event.type === 'message') append(event.message);
	});

	const snapshot = await room.read({ messages: { since: appendedSeq } });
	for (const message of snapshot.messages) append(message);

	return {
		room: room.name,
		path,
		async stop() {
			if (stopped) return;
			stopped = true;
			unsubscribe();
			await pending;
		},
	};
}
