/**
 * The refs a message cites and the URIs a room gives.
 *
 * A ref is one absolute URI. The room checks its grammar and never reads
 * behind it. The one scheme the room owns is `ambion`: a room URI names a
 * room or one message of a room.
 */
import { assertRoomName, isName } from './define.ts';
import type { Seq } from './types.ts';

/** The most refs one message carries, and the most characters one ref has. */
export const REF_LIMITS = { count: 16, length: 2048 } as const;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.+)$/s;
const FORBIDDEN = /[\s\p{Cc}]/u;
const ROOM_URI = /^ambion:\/\/room\/([^/]+)(?:\/message\/([1-9][0-9]*))?$/;

/** What a room URI names. `message` is the seq of the message it names. */
export interface RoomUri {
	readonly room: string;
	readonly message?: Seq;
}

/** The reason for a refusal, one sentence for every entry point. */
const GRAMMAR = `A ref is one absolute URI with a scheme, at most ${REF_LIMITS.length} characters, at most ${REF_LIMITS.count} per message, no duplicates; an ambion: ref names a room or a message.`;

/** A ref is an absolute URI. An `ambion` ref must be a canonical room URI. */
export function isRef(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > REF_LIMITS.length) return false;
	if (FORBIDDEN.test(value)) return false;
	const match = SCHEME.exec(value);
	if (match === null) return false;
	return match[1]?.toLowerCase() !== 'ambion' || parseRoomUri(value) !== undefined;
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
