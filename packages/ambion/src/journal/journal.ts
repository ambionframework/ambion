/**
 * The room's record, as the vocabulary its journal is written in.
 *
 * `@ambionframework/journal` holds the machinery and the envelope: one
 * serial queue, the fence between runs, the idempotency key, the refusal of a commit the record
 * moved past, and the read that settles a write in doubt. It reads no body.
 *
 * What lives here is the part that is the room's: the five kinds of entry it
 * writes, what the storage holds each one under, and what it accepts as a
 * body under each. A message makes up the record a person reads; every other
 * kind sits beside the messages, and takes its place from the same counter.
 */
import {
	type Entries,
	type JournalEntry as Envelope,
	Journal,
	type Seq,
	type Vocabulary,
} from '@ambionframework/journal';
import type { Message } from '../types.ts';
import type { Close, Composition, Fence, LeaseChange, Without } from '../wire.ts';

/** The five kinds of entry the room writes to its journal. */
export type Kind = 'message' | 'lease' | 'close' | 'composition' | 'run';

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
}

/**
 * The room's kinds, as the journal needs them. `accepts` is the room's own
 * check on a body: every kind is whatever the room wrote.
 */
const WORDS: Vocabulary<Kind> = {
	record: 'message',
	run: 'run',
	accepts: (kind, _body): kind is Kind =>
		kind === 'message' ||
		kind === 'lease' ||
		kind === 'close' ||
		kind === 'composition' ||
		kind === 'run',
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
		open: Promise<import('@ambionframework/journal').JournalStorage>,
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
