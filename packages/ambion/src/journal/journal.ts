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
 * body under each. A message takes a position; every other kind sits beside
 * the messages, and carries `after`, the last seq when it landed.
 */
import { type Entries, Journal, type Vocabulary } from '@ambionframework/journal';
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

/** The body each kind carries. The journal reads none of them. */
export interface Bodies {
	message: Message;
	lease: LeaseChange;
	close: Close;
	composition: Composition;
	run: Fence;
	checkpoint: Checkpoint;
}

/**
 * What each kind writes, before the journal stamps it. A message takes its
 * seq at commit; every other kind takes `after`, the last seq when it landed.
 */
export type Drafts = {
	lease: Without<LeaseChange, 'seq'>;
	close: Without<Close, 'seq'>;
	composition: Without<Composition, 'seq'>;
	run: Without<Fence, 'seq'>;
	checkpoint: Without<Checkpoint, 'seq'>;
};

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

/**
 * The room's journal: the record's machinery, in the room's vocabulary.
 * Every member the room reaches is the journal's, except the one the room
 * names in its own words: `messages`, the bodies that took a position.
 */
export class RoomJournal extends Journal<Kind, Bodies, 'message', Drafts> {
	constructor(
		open: Promise<PiSession>,
		hear?: (entry: Entry) => void,
		run?: string,
		lost?: () => void,
	) {
		super(open, WORDS, hear, run, lost);
	}

	/** The replayed record, then every message as its write is confirmed. */
	get messages(): Message[] {
		return this.record;
	}
}
