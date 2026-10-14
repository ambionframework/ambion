/**
 * The refs a message cites and the URIs the kernel defines.
 *
 * A ref is one absolute URI. The room checks its grammar and never reads
 * behind it. The kernel owns the `ambion://room/` forms: a room, and one
 * message of a room. Any other ref passes when it is an absolute URI, and the
 * package that makes the ref checks its form where it reads it.
 */
import { assertRoomName } from './define.ts';
import { isName } from './names.ts';
import type { Seq } from './types.ts';

/** The most refs one message carries, and the most characters one ref has. */
export const REF_LIMITS = { count: 16, length: 2048 } as const;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.+)$/s;
const FORBIDDEN = /[\s\p{Cc}]/u;
const ROOM_URI = /^ambion:\/\/room\/([^/]+)(?:\/message\/([1-9][0-9]*))?$/;
const ROOM_PREFIX = 'ambion://room/';

/** What a room URI names. `message` is the seq of the message it names. */
export interface RoomUri {
	readonly room: string;
	readonly message?: Seq;
}

/** The reason for a refusal, one sentence for every entry point. */
const GRAMMAR = `A ref is one absolute URI with a scheme, at most ${REF_LIMITS.length} characters, at most ${REF_LIMITS.count} per message, no duplicates; an ambion://room/ ref names a room or a message.`;

/** A ref is an absolute URI. An `ambion://room/` ref must be a canonical kernel URI. */
export function isRef(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > REF_LIMITS.length) return false;
	if (FORBIDDEN.test(value)) return false;
	if (!SCHEME.test(value)) return false;
	if (value.toLowerCase().startsWith(ROOM_PREFIX)) return parseRoomUri(value) !== undefined;
	return true;
}

/** The reason a list of refs is refused, or undefined when the room accepts it. */
export function refsRefusal(refs: unknown): string | undefined {
	if (!Array.isArray(refs)) return `refs must be an array. ${GRAMMAR}`;
	if (refs.length > REF_LIMITS.count) return `refs holds ${refs.length} entries. ${GRAMMAR}`;
	const seen = new Set<unknown>();
	for (const [index, ref] of refs.entries()) {
		if (!isRef(ref)) return `refs[${index}] is not a ref. ${GRAMMAR}`;
		if (seen.has(ref)) return `refs[${index}] repeats an earlier ref. ${GRAMMAR}`;
		seen.add(ref);
	}
	return undefined;
}

/** The URI of a room. */
export function roomUri(room: string): string {
	assertRoomName(room);
	return `ambion://room/${room}`;
}

/** The URI of the message at `seq`. */
export function messageUri(room: string, seq: Seq): string {
	if (!Number.isSafeInteger(seq) || seq < 1)
		throw new RangeError('Message reference must be a positive safe integer.');
	return `${roomUri(room)}/message/${seq}`;
}

/** Read a canonical room URI. Any other string returns undefined. */
export function parseRoomUri(uri: string): RoomUri | undefined {
	const match = ROOM_URI.exec(uri);
	const room = match?.[1];
	if (room === undefined || !isName(room)) return undefined;
	const seq = match?.[2];
	if (seq === undefined) return { room };
	const message = Number(seq);
	return Number.isSafeInteger(message) ? { room, message } : undefined;
}
