/**
 * The room's record, as the vocabulary its journal is written in.
 *
 * `@ambionframework/journal` holds the machinery and the envelope: one
 * serial queue, the fence between runs, the checkpoint that replaces every
 * entry before it, the idempotency key, the refusal of a commit the record
 * moved past, and the read that settles a write in doubt. It reads no body.
 *
 * What lives here is the part that is the room's: the six kinds of entry it
 * writes, what the storage holds each one under, and what it accepts as a
 * body under each. A message makes up the record a person reads; every other
 * kind sits beside the messages, and takes its place from the same counter.
 */
import {
	type Entries,
	type Entry as Envelope,
	Journal,
	type Seq,
	type Vocabulary,
} from '@ambionframework/journal';
import type { Session as PiSession } from '@earendil-works/pi-agent-core';
import type { Message } from '../types.ts';
import {
	type Checkpoint,
	type Close,
	type Composition,
	type Fence,
	isCheckpoint,
	type LeaseChange,
	type Without,
} from '../wire.ts';

/** The six kinds of entry the room writes to its Pi session. */
export type Kind = 'message' | 'lease' | 'close' | 'composition' | 'run' | 'checkpoint';

/** What the storage holds each kind under. */
const STORED: Readonly<Record<Kind, string>> = {
	message: 'ambion/message',
	lease: 'ambion/lease',
	close: 'ambion/close',
	composition: 'ambion/composition',
	run: 'ambion/run',
	checkpoint: 'ambion/checkpoint',
};

const KINDS: Readonly<Record<string, Kind>> = Object.fromEntries(
	Object.entries(STORED).map(([kind, stored]) => [stored, kind as Kind]),
);

/**
 * What a body is before the journal gives it a place. Two of the room's
 * kinds name where they sit: a message, which a person reads by number, and
 * a composition, which the roster folds from. A message also names the key
 * its commit carried, because `docs/durability.md` promises a host that a
 * delivery it acknowledged is on the record once. The journal keeps both
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
	checkpoint: Checkpoint;
}

/**
 * The room's kinds, as the journal needs them. `accepts` is the room's own
 * check on a body: a checkpoint of a shape this room does not read is no
 * entry at all, and every other kind is whatever the room wrote.
 */
const WORDS: Vocabulary<Kind> = {
	stored: (kind) => STORED[kind],
	kindOf: (customType) => KINDS[customType],
	record: 'message',
	run: 'run',
	checkpoint: 'checkpoint',
	accepts: (kind, body) => kind !== 'checkpoint' || isCheckpoint(body),
};

/** One entry on the room's journal: its kind, and the body that kind carries. */
export type Entry = Entries<Kind, Bodies>;

/** One record entry as the room reads it: the body, joined to its envelope. */
export const placed = (entry: Envelope<Bodies['message']>): Message =>
	({
		...entry.body,
		seq: entry.seq,
		...(entry.key === undefined ? {} : { key: entry.key }),
	}) as Message;

/**
 * The room's journal: the record's machinery, in the room's vocabulary.
 * Every member the room reaches is the journal's, except the one the room
 * names in its own words: `messages`, the record as a person reads it.
 */
export class RoomJournal extends Journal<Kind, Bodies, 'message'> {
	/**
	 * Every record entry joined to its envelope, in order. The record only
	 * grows, so the join tops up from where it stopped and never runs twice
	 * over one entry.
	 */
	private readonly joined: Message[] = [];

	constructor(
		open: Promise<PiSession>,
		hear?: (entry: Entry) => void,
		run?: string,
		lost?: () => void,
	) {
		super(open, WORDS, hear, run, lost);
	}

	/** The record as the room reads it: every message, or every message past a place. */
	messages(after?: Seq): Message[] {
		for (const entry of this.record.slice(this.joined.length)) this.joined.push(placed(entry));
		return after === undefined ? [...this.joined] : this.joined.filter((m) => m.seq > after);
	}
}
