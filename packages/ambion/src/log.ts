/**
 * The log: every message a room committed, in the order it took a seq.
 *
 * It is the one thing a live room and a read of a stopped one share, so it
 * knows nothing about either: it replays a Pi session into memory and
 * commits one entry at a time on a serial queue. A message exists when its
 * write is confirmed, and nothing observes it before: the cache updates
 * after the append resolves, and a caller that awaits `commit` holds a
 * message that is on the record.
 *
 * Every commit carries a key. A repeated key returns the message the first
 * commit landed and writes nothing, which is what lets a caller retry a
 * commit whose outcome it never learned. A commit may also name
 * `readThrough`: the seq its author has read. The queue refuses it when the
 * record moved past that, and hands back what the author missed — rule 5,
 * enforced where the write happens.
 */
import type { Agent, Session as PiSession } from '@earendil-works/pi-agent-core';
import type { Message, Seq } from './types.ts';
import type { CloseRow, CompositionRow, LeaseRow, Without } from './wire.ts';

/** The four kinds of custom entry the room writes to its Pi session. */
const ENTRY_TYPES = {
	message: 'ambion/message',
	lease: 'ambion/lease',
	close: 'ambion/close',
	composition: 'ambion/composition',
} as const;

/** One entry on the log: a message with a seq, or a row about the room around the messages. */
export type LogEntry =
	| { type: 'message'; message: Message }
	| { type: 'lease'; lease: LeaseRow }
	| { type: 'close'; close: CloseRow }
	| { type: 'composition'; composition: CompositionRow };

/** A row that is not a message: it takes no seq, and carries `after`, the last seq when it was written. */
export type Row = Exclude<LogEntry, { type: 'message' }>;

/** What a caller passes to `write`: the row without `after`, which the log stamps. */
export type RowData<K extends Row['type']> = {
	lease: Without<LeaseRow, 'after'>;
	close: Without<CloseRow, 'after'>;
	composition: Without<CompositionRow, 'after'>;
}[K];

const BY_TYPE: Record<string, LogEntry['type']> = {
	[ENTRY_TYPES.message]: 'message',
	[ENTRY_TYPES.lease]: 'lease',
	[ENTRY_TYPES.close]: 'close',
	[ENTRY_TYPES.composition]: 'composition',
};

function toEntry(customType: string, data: unknown): LogEntry | undefined {
	const type = BY_TYPE[customType];
	if (type === undefined) return undefined;
	return { type, [type]: data } as LogEntry;
}

/** What a caller commits: the message minus its seq, and the two checks the queue runs. */
export interface CommitIntent<T extends Message> {
	/** Names this commit. A repeated key lands once. */
	key?: string;
	/** The seq the author has read. The queue refuses the commit when the record moved past it. */
	readThrough?: Seq;
	/** The message, or a function of the record as it stands when the commit runs. */
	draft: Omit<T, 'seq' | 'key'> | ((lastSeq: Seq) => Omit<T, 'seq' | 'key'>);
}

/** The commit landed, or the key had landed before, or the record had moved. */
export type Committed<T extends Message> = { message: T; repeated?: true } | { missed: Message[] };

export class RoomLog {
	/** Every entry, replayed then appended, in the order the writes were confirmed. */
	readonly entries: LogEntry[] = [];
	/** The replayed record, then every message as its write is confirmed. */
	readonly messages: Message[] = [];
	readonly ready: Promise<PiSession>;
	lastSeq = 0;
	private readonly byKey = new Map<string, Message>();
	/** The serial queue. One commit at a time, in the order they were asked for. */
	private tail: Promise<unknown> = Promise.resolve();

	constructor(open: Promise<PiSession>) {
		this.ready = this.replay(open);
		// A host can hold a session and read nothing from it for hours, so
		// nothing may await `ready` for a long time. Mark the rejection handled
		// here: a storage that cannot open must surface at the call that needs
		// the log, and never as an unhandled rejection that ends the process.
		void this.ready.catch(() => {});
	}

	private async replay(open: Promise<PiSession>): Promise<PiSession> {
		const piSession = await open;
		const found = await piSession.findEntries();
		// findEntries does not promise append order; Pi's seq does.
		found.sort((a, b) => a.seq - b.seq);
		for (const entry of found) {
			if (entry.type !== 'custom') continue;
			const known = toEntry(entry.customType, entry.data);
			if (known) this.cache(known);
		}
		return piSession;
	}

	private cache(entry: LogEntry): void {
		this.entries.push(entry);
		if (entry.type !== 'message') return;
		const message = entry.message;
		this.messages.push(message);
		this.lastSeq = message.seq;
		if (message.key !== undefined) this.byKey.set(message.key, message);
	}

	/**
	 * Put a row beside the messages. It takes no seq and carries `after`, the
	 * last seq when it landed; it joins the same queue, so a row and the
	 * messages around it land in the order they were asked. The row is built
	 * where the write happens, and a builder that returns nothing writes
	 * nothing: the check it ran found the row no longer needed.
	 */
	write<K extends Row['type']>(
		type: K,
		row: RowData<K> | (() => RowData<K> | undefined),
	): Promise<boolean> {
		const link = this.tail.then(async () => {
			const piSession = await this.ready;
			const data = typeof row === 'function' ? row() : row;
			if (data === undefined) return false;
			const stamped = { ...data, after: this.lastSeq };
			await piSession.appendCustomEntry(ENTRY_TYPES[type], stamped);
			this.cache({ type, [type]: stamped } as unknown as LogEntry);
			return true;
		});
		this.tail = link.catch(() => {});
		return link;
	}

	/**
	 * Commit one message. The check, the append and the cache update run
	 * inside one link of the queue, and `landed` runs there too, before the
	 * next commit starts: what a caller does with a fresh message happens
	 * before anything else lands on top of it.
	 */
	commit<T extends Message>(
		intent: CommitIntent<T>,
		landed?: (message: T) => void,
	): Promise<Committed<T>> {
		const link = this.tail.then(() => this.land(intent, landed));
		// One write that fails must not stop the next one. The queue keeps its
		// order; the caller of the failed write sees its failure.
		this.tail = link.catch(() => {});
		return link;
	}

	private async land<T extends Message>(
		intent: CommitIntent<T>,
		landed: ((message: T) => void) | undefined,
	): Promise<Committed<T>> {
		const piSession = await this.ready;
		const seen = intent.key === undefined ? undefined : this.byKey.get(intent.key);
		if (seen !== undefined) return { message: seen as T, repeated: true };
		if (intent.readThrough !== undefined && this.lastSeq > intent.readThrough) {
			return { missed: this.since(intent.readThrough) };
		}
		const draft = typeof intent.draft === 'function' ? intent.draft(this.lastSeq) : intent.draft;
		const stamped = {
			...draft,
			seq: this.lastSeq + 1,
			...(intent.key === undefined ? {} : { key: intent.key }),
		} as T;
		await piSession.appendCustomEntry(ENTRY_TYPES.message, stamped);
		this.cache({ type: 'message', message: stamped });
		landed?.(stamped);
		return { message: stamped };
	}

	since(cursor: Seq | undefined): Message[] {
		if (cursor === undefined) return [...this.messages];
		return this.messages.filter((message) => message.seq > cursor);
	}
}

/** Every turn a model took, in the downstream session that owns it. */
export async function persistTurns(
	open: Promise<PiSession>,
	agent: Agent,
	at: string,
): Promise<void> {
	const piSeat = await open;
	await piSeat.appendCustomEntry('ambion/activation', { at });
	for (const message of agent.state.messages) {
		// Provider messages may carry undefined-valued fields, which Pi's
		// durability check rejects; a JSON round-trip drops them.
		await piSeat.appendMessage(JSON.parse(JSON.stringify(message)));
	}
}
