/**
 * A room's message record, mirrored to the workspace as one JSONL file per
 * room.
 *
 * The mirror lives at `/rooms/<room name>/messages.jsonl`, one line per
 * message, in the room's own order. It is an ordinary file: an agent reads
 * it with `read` or `bash cat`, the same as any file a peer wrote.
 *
 * This is a secondary, best-effort copy. `packages/journal` remains the
 * source of truth for the room; a write failure here calls `onError` and
 * the room keeps running. Recovery follows the same recipe
 * `docs/durability.md` gives any external reader: subscribe first, then
 * backfill from the highest `seq` already on disk, so a restart neither
 * misses a message nor writes one twice.
 *
 * `Workspace.mirror()`, in `workspace.ts`, is the public entry point: it
 * supplies the workspace's own resource and a write agent it owns, so a
 * caller names only the room.
 */

import { posix } from 'node:path';
import type { Message, Room, RoomRead, Seq } from '@ambionframework/ambion';
import type { Context, ExecutionEnv, JsonValue } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import { openLog } from './log.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

/** The directory every room's message record lives under. */
const ROOMS_ROOT = '/rooms';

/** One line of a room's message record. */
export type RoomMessageEntry = Message & { readonly room: string };

export interface RoomMirrorOptions {
	/** Bytes the file may hold before the next message rotates it. */
	readonly rotateBytes?: number;
	/** Told about a write or rotation failure. The room keeps running either way. */
	readonly onError?: (error: Error) => void;
}

export interface RoomMirror {
	readonly room: string;
	readonly path: string;
	/** Unsubscribe from the room and let the current append settle. Idempotent. */
	stop(): Promise<void>;
}

/**
 * Guidance for the `/rooms` convention. It names no room, so a workspace
 * states it unconditionally, with no option to set.
 */
export const ROOM_MIRROR_GUIDANCE = [
	`This workspace may hold /rooms/<room name>/messages.jsonl for any room`,
	`that mirrors its record here. Read a room's file with read or bash`,
	`cat. It can hold messages your own context has trimmed or folded`,
	`into a summary, and the history of a room you are not seated in.`,
	`Each line carries the message's own seq. A message ref names the`,
	`same seq: ambion://room/<name>/message/<seq>. Filter it with jq:`,
	`jq 'select(.seq == <seq>)' finds the line a ref or the ask line`,
	`names. jq also filters by kind or from.`,
].join('\n');

/**
 * The path one room's message record lives at, or a thrown error naming the
 * room. A room's name is not validated at the kernel today, and this is the
 * first place one turns into a filesystem path: a name holding `..` or an
 * extra `/` must not resolve outside `/rooms`.
 */
export function roomMirrorPath(roomName: string): string {
	const path = `${ROOMS_ROOT}/${roomName}/messages.jsonl`;
	if (posix.normalize(path) !== path) {
		throw new Error(`Room name is not safe to use as a path: '${roomName}'.`);
	}
	return path;
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
 * Start mirroring `room`'s messages to `roomMirrorPath(room.name)` over
 * `drive`, writing as `agent`. Subscribes before it reads, so nothing that
 * lands during recovery is missed, then backfills from the highest `seq`
 * already on disk. A message already accounted for, from either source, is
 * not written twice.
 *
 * A live message can land while the backfill `read` is still in flight, and
 * a room only settles that read once every queued append (this one among
 * them) has landed — so the room can publish it to the new subscriber
 * before `read` resolves with it already included. Appending it early would
 * set the high-water mark past it, and the backfill loop would then skip it
 * as already accounted for: written nowhere. Every event the subscription
 * sees before the backfill loop has run is held, not appended, and drained
 * through the same loop once recovery is over.
 *
 * Not exported from the package root: a caller reaches this through
 * `Workspace.mirror()`, which supplies `drive` and `agent` itself.
 */
export async function mirrorRoom(
	room: Room,
	drive: WorkspaceResource<WorkspaceEnv>,
	agent: WorkspaceAgent,
	options: RoomMirrorOptions = {},
): Promise<RoomMirror> {
	const path = roomMirrorPath(room.name);
	const dir = posix.dirname(path);
	const fileName = posix.basename(path);
	const log = openLog({ path, rotateBytes: options.rotateBytes });

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

	let held: Message[] | undefined = [];
	const unsubscribe = room.subscribe((event) => {
		if (event.type !== 'message') return;
		if (held !== undefined) held.push(event.message);
		else append(event.message);
	});

	let snapshot: RoomRead;
	try {
		snapshot = await room.read({ messages: { since: appendedSeq } });
	} catch (error) {
		unsubscribe();
		throw error;
	}
	for (const message of snapshot.messages) append(message);
	const buffered = held;
	held = undefined;
	for (const message of buffered) append(message);

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
