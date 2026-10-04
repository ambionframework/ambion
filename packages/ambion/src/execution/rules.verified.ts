/**
 * The rule the seat side decides by, as a function LemmaScript checks. The
 * room tools in `room-tools.ts` run this body, so the proof is about the code
 * the seat runs. `execution/` cannot import `room/`, so the rule has a file
 * of its own beside its caller. `pnpm rule:check` regenerates and proves it,
 * as it does the rules of the room.
 */

//@ contract A seating, an unseating, or a dismissal is the own act of its activation. With no unread entry before it, the read starts at the read position and covers the entry. Otherwise it starts just before the entry, and the unread lines stay unread.
export function ownEntryAfter(readThrough: number, seq: number, unread: number): number {
	//@ requires seq >= 1
	//@ requires unread >= 0
	//@ ensures unread == 0 ==> \result == readThrough
	//@ ensures unread > 0 ==> \result == seq - 1
	//@ ensures unread > 0 ==> \result < seq
	return unread === 0 ? readThrough : seq - 1;
}
