/**
 * The room's record, as the vocabulary its journal is written in.
 *
 * `@ambionframework/journal` holds the machinery and the envelope: one
 * serial queue, the fence between runs, the idempotency key, and the read that settles a write in doubt. It reads no body.
 *
 * What lives here is the part that is the room's: the five kinds of entry it
 * writes, what the storage holds each one under, and what it accepts as a
 * body under each. A message makes up the record a person reads; every other
 * kind sits beside the messages, and takes its place from the same counter.
 */
import {
	type CloneableJournal,
	type Entries,
	type JournalEntry as Envelope,
	Journal,
	type JournalStorage,
	type Vocabulary,
} from '@ambionframework/journal';
import type { Message, Without } from '../types.ts';
import type { Cancellation, Close, Composition, Fence, LeaseChange } from './events.ts';
import { validateRoomBody } from './validate.ts';

/** The entry kinds the room writes to its journal. */
export type Kind = 'message' | 'lease' | 'close' | 'composition' | 'run' | 'cancel';

/**
 * What a body is before the journal gives it a place. Two of the room's
 * kinds name where they sit: a message, which a person reads by number, and
 * a composition, which the roster folds from. A message also names the
 * idempotency token its commit carried, because `docs/durability.md` §2
 * promises a host that a delivery it acknowledged is on the record once,
 * and a host reads the token to hold the room to it. The journal keeps both
 * fields of its own, so the room drafts the body without them and joins the
 * two back together when it reads.
 */
export type Body<T> = Without<T, 'seq' | 'key'>;

/** The body each kind carries. The journal reads none of them. */
export interface Bodies {
	message: Body<Message>;
	lease: LeaseChange;
	close: Close;
	composition: Body<Composition>;
	run: Fence;
	cancel: Cancellation;
}

/** The room validates bodies. The journal orders and fences entries. */
const WORDS: Vocabulary<Kind> = {
	run: 'run',
	accepts: validateRoomBody,
};

/** One entry on the room's journal: its kind, and the body that kind carries. */
export type Entry = Entries<Kind, Bodies>;

/**
 * The space a caller's token lives in. The journal's own idempotency index is
 * one space for the whole room, so a delivery token and a commit token could
 * otherwise collide on the same literal string and be read as one operation
 * repeating as the other. `spaced` tags a token before it reaches that index;
 * `placed` strips the tag back off, so `Message.key` still reads the token
 * exactly as the caller supplied it.
 */
export type KeySpace = 'delivery' | 'commit';
export const spaced = (space: KeySpace, key: string): string => `${space}:${key}`;
const unspaced = (key: string): string => key.replace(/^(?:delivery|commit):/, '');

/** One record entry as the room reads it: the body, joined to its envelope. */
export const placed = (entry: Envelope<Bodies['message']>): Message =>
	({
		...entry.body,
		seq: entry.seq,
		...(entry.key === undefined ? {} : { key: unspaced(entry.key) }),
	}) as Message;

/**
 * The room composes a generic journal with its vocabulary. `CloneableJournal`
 * proves at compile time that every room body survives `structuredClone`: the
 * journal copies each body at its ownership boundaries. A body that gains a
 * function, a symbol, or a class instance makes this type `never`, and
 * `roomJournal` then fails to compile. See `docs/durability.md` §2.
 */
export type RoomJournal = CloneableJournal<Kind, Bodies>;

export const roomJournal = (
	open: Promise<JournalStorage>,
	hear?: (entry: Entry) => void,
	run?: string,
	lost?: () => void,
): RoomJournal => new Journal<Kind, Bodies>(open, WORDS, hear, run, lost);
