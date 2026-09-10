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
 *
 * The log reads what the storage holds past its cursor before every
 * write, and again on the queue behind a write that failed. A write whose
 * confirmation was lost is on the record before anything lands on top of
 * it, and a read of the record waits for the queue. The cursor moves to
 * the last entry every read saw, so a read costs the entries since the
 * one before it, whatever the log's age.
 *
 * A run is fenced by its run row. Every entry a run writes carries its
 * run id. The fence is positional: as a read passes the storage in order,
 * a run row moves the fence to that run, and an entry of another run past
 * it is void, so the log skips it. A log that passes its own row and then
 * a row of another run is superseded: it tells the room, and every write
 * from then on fails. A log with no run of its own writes nothing about
 * runs, and reads the fence like any other reader.
 *
 * A checkpoint replaces every row before it: the fold reads the rows it
 * carries and nothing older, so the log drops those rows from its cache
 * once a checkpoint covers them. The messages stay. What a fold costs is
 * then bounded by the rows since the last checkpoint, whatever the log's
 * age.
 */
import type { Session as PiSession } from '@earendil-works/pi-agent-core';
import type { Message, Seq } from '../types.ts';
import {
	type CheckpointRow,
	type CloseRow,
	type CompositionRow,
	isCheckpoint,
	type LeaseRow,
	type RunRow,
	type Without,
} from '../wire.ts';
import { nextSeq, refused, supersedes, voided } from './rules.verified.ts';

/** The six kinds of custom entry the room writes to its Pi session. */
const ENTRY_TYPES = {
	message: 'ambion/message',
	lease: 'ambion/lease',
	close: 'ambion/close',
	composition: 'ambion/composition',
	checkpoint: 'ambion/checkpoint',
	run: 'ambion/run',
} as const;

/** One entry on the log: a message with a seq, or a row about the room around the messages. */
export type LogEntry =
	| { type: 'message'; message: Message }
	| { type: 'lease'; lease: LeaseRow }
	| { type: 'close'; close: CloseRow }
	| { type: 'composition'; composition: CompositionRow }
	| { type: 'checkpoint'; checkpoint: CheckpointRow }
	| { type: 'run'; run: RunRow };

/** A row that is not a message: it takes no seq, and carries `after`, the last seq when it was written. */
export type Row = Exclude<LogEntry, { type: 'message' }>;

/** What a caller passes to `write`: the row without `after`, which the log stamps. */
export type RowData<K extends Row['type']> = {
	lease: Without<LeaseRow, 'after'>;
	close: Without<CloseRow, 'after'>;
	composition: Without<CompositionRow, 'after'>;
	checkpoint: Without<CheckpointRow, 'after'>;
	run: Without<RunRow, 'after'>;
}[K];

const BY_TYPE: Record<string, LogEntry['type']> = {
	[ENTRY_TYPES.message]: 'message',
	[ENTRY_TYPES.lease]: 'lease',
	[ENTRY_TYPES.close]: 'close',
	[ENTRY_TYPES.composition]: 'composition',
	[ENTRY_TYPES.checkpoint]: 'checkpoint',
	[ENTRY_TYPES.run]: 'run',
};

/** What the storage holds for one entry: the entry's data, and the run that wrote it. */
interface Stored {
	written?: string;
	[field: string]: unknown;
}

/** The entry a custom row folds as, or nothing for a row the room does not read. */
function toEntry(customType: string, data: unknown): LogEntry | undefined {
	const type = BY_TYPE[customType];
	if (type === undefined) return undefined;
	const { written: _written, ...entry } = data as Stored;
	if (type === 'checkpoint' && !isCheckpoint(entry)) return undefined;
	return { type, [type]: entry } as LogEntry;
}

/** The run that wrote a stored entry, or nothing for an entry written before runs were fenced. */
const writerOf = (data: unknown): string | undefined => (data as Stored).written;

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
	private closed = false;
	/** Pi's id of every entry the cache holds past the cursor: what a read in doubt finds again. */
	private readonly known = new Set<string>();
	/** Pi's seq of the last entry a read saw: the next read starts past it. */
	private cursor = 0;
	/** The replay is over: what a read finds from now on is news, and `found` hears it. */
	private replayed = false;
	/** The run whose row landed last: entries of any other run after it are void. */
	private fence: string | undefined;
	/** This run's row is on the log: a row of another run found from now on is a later run's. */
	private fenced = false;
	/** A later run's row was found: this run's writes are over. */
	private superseded = false;
	/** How many rows the cache holds past the last checkpoint. The room writes the next one from this. */
	rowsSinceCheckpoint = 0;

	/**
	 * `found` hears every entry the log finds on a read: it landed, and the
	 * writer never heard, or another run wrote it. The room acts on it the
	 * way it acts on a write it confirmed. `run` names the run this log
	 * writes for, or nothing for a log that only reads. `lost` hears that a
	 * later run took the name.
	 */
	constructor(
		open: Promise<PiSession>,
		private readonly found?: (entry: LogEntry, fresh: boolean) => void,
		private readonly run?: string,
		private readonly lost?: () => void,
	) {
		this.ready = this.replay(open);
		// A host can hold a session and read nothing from it for hours, so
		// nothing may await `ready` for a long time. Mark the rejection handled
		// here: a storage that cannot open must surface at the call that needs
		// the log, and never as an unhandled rejection that ends the process.
		void this.ready.catch(() => {});
	}

	private async replay(open: Promise<PiSession>): Promise<PiSession> {
		const piSession = await open;
		await this.read(piSession);
		this.replayed = true;
		this.compact();
		return piSession;
	}

	/**
	 * Drop every row the latest checkpoint replaced. The checkpoint stays,
	 * and so does every message: the fold reads the checkpoint's rows in
	 * place of the ones dropped, and the messages as they are.
	 */
	private compact(): void {
		const at = this.entries.findLastIndex((entry) => entry.type === 'checkpoint');
		if (at < 0) return;
		const messages = this.entries.slice(0, at).filter((entry) => entry.type === 'message');
		this.entries.splice(0, at, ...messages);
		this.rowsSinceCheckpoint = this.entries
			.slice(messages.length + 1)
			.filter((entry) => entry.type !== 'message').length;
	}

	/**
	 * Cache every entry the storage holds past the cursor that the cache
	 * lacks, tell `found` about each one after the replay, and move the
	 * cursor to the last entry seen. Nothing at or before the cursor is
	 * read again, so the ids kept to tell a found entry from a cached one
	 * are only those appended since.
	 */
	private async read(piSession: PiSession): Promise<void> {
		const afterSeq = this.cursor;
		// Pi reads a cursor against the order: oldest first, past `afterSeq`.
		const query = afterSeq === 0 ? {} : { order: 'oldestFirst' as const, cursor: { afterSeq } };
		const found = (await piSession.findEntries(query)).filter((entry) => entry.seq > afterSeq);
		// findEntries does not promise append order; Pi's seq does.
		found.sort((a, b) => a.seq - b.seq);
		for (const entry of found) {
			this.cursor = Math.max(this.cursor, entry.seq);
			if (entry.type !== 'custom') continue;
			// The fence is positional: a run row moves it where the row sits, cached or not.
			if (entry.customType === ENTRY_TYPES.run) this.pass(writerOf(entry.data));
			if (!this.known.has(entry.id)) this.take(entry);
		}
		this.known.clear();
	}

	/**
	 * The read passed a run row. The fence moves to that run. This log's
	 * own row marks it fenced: a row of another run past it is a later
	 * run's, and supersedes this log.
	 */
	private pass(run: string | undefined): void {
		this.fence = run;
		if (run === this.run) this.fenced = true;
		else if (supersedes(this.fenced, false) && !this.superseded) {
			this.superseded = true;
			this.lost?.();
		}
	}

	/**
	 * One entry a read found that the cache lacks: cached unless void, and
	 * reported after the replay. A checkpoint a superseded run wrote past
	 * the fence is void like any other entry.
	 */
	private take(entry: { id: string; customType: string; data?: unknown }): void {
		const known = toEntry(entry.customType, entry.data);
		if (known === undefined || this.voided(known, writerOf(entry.data))) return;
		const fresh = known.type !== 'lease' || !this.holds(known.lease.id);
		this.cache(known, entry.id);
		if (this.replayed) this.found?.(known, fresh);
	}

	/**
	 * Whether a stored entry is void: written by a run other than the one
	 * whose row the read passed last. An entry written before runs were
	 * fenced belongs to whatever run stood.
	 */
	private voided(entry: LogEntry, written: string | undefined): boolean {
		if (entry.type === 'run') return false;
		return voided(this.fence !== undefined, written !== undefined, written === this.fence);
	}

	/** Whether the cache holds a row for this lease id already. */
	private holds(id: string): boolean {
		return this.entries.some((entry) => entry.type === 'lease' && entry.lease.id === id);
	}

	private cache(entry: LogEntry, id: string): void {
		this.known.add(id);
		this.entries.push(entry);
		if (entry.type === 'checkpoint') this.compact();
		else if (entry.type !== 'message') this.rowsSinceCheckpoint += 1;
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
			const piSession = await this.open();
			const data = typeof row === 'function' ? row() : row;
			if (data === undefined) return false;
			const stamped = { ...data, after: this.lastSeq };
			const id = await this.append(piSession, ENTRY_TYPES[type], stamped);
			this.cache({ type, [type]: stamped } as unknown as LogEntry, id);
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

	/**
	 * Closed: every write from here on fails, and nothing is cached. A room
	 * dropped from memory closes its log, so a write it still had in flight
	 * fails the way a process that died would have failed to make it.
	 */
	close(): void {
		this.closed = true;
	}

	/**
	 * The session to write to, or the failure a closed or superseded log
	 * answers every write with. The log reads the storage first: what
	 * another run wrote, and what a write in doubt left.
	 */
	private async open(): Promise<PiSession> {
		this.refuse();
		const piSession = await this.ready;
		await this.read(piSession);
		// A log closed or superseded while the read ran writes nothing more.
		this.refuse();
		return piSession;
	}

	private refuse(): void {
		if (this.superseded) throw new Error('The run is superseded: another run holds the name.');
		if (this.closed) throw new Error('The log is closed.');
	}

	/**
	 * One append, stamped with the run that writes it. A failure puts the
	 * log in doubt, whatever the storage did with the entry, and queues the
	 * read that settles it.
	 */
	private async append(piSession: PiSession, type: string, data: unknown): Promise<string> {
		const stored = this.run === undefined ? data : { ...(data as object), written: this.run };
		try {
			return await piSession.appendCustomEntry(type, stored);
		} catch (error) {
			// The storage may hold what the cache does not: the read that settles it is queued.
			this.tail = this.tail.then(() => this.open()).catch(() => {});
			throw error;
		}
	}

	/**
	 * Resolves once every write asked for so far has landed or failed, and
	 * every doubt is settled: a failure queues the read behind itself, so
	 * the wait runs until nothing was queued while it waited. A read that
	 * failed leaves the doubt standing, and the next write reads again.
	 */
	async settled(): Promise<void> {
		let awaited: Promise<unknown>;
		do {
			awaited = this.tail;
			await awaited;
		} while (awaited !== this.tail);
	}

	private async land<T extends Message>(
		intent: CommitIntent<T>,
		landed: ((message: T) => void) | undefined,
	): Promise<Committed<T>> {
		const piSession = await this.open();
		const seen = intent.key === undefined ? undefined : this.byKey.get(intent.key);
		if (seen !== undefined) return { message: seen as T, repeated: true };
		if (intent.readThrough !== undefined && refused(this.lastSeq, intent.readThrough)) {
			return { missed: this.since(intent.readThrough) };
		}
		const draft = typeof intent.draft === 'function' ? intent.draft(this.lastSeq) : intent.draft;
		const stamped = {
			...draft,
			seq: nextSeq(this.lastSeq),
			...(intent.key === undefined ? {} : { key: intent.key }),
		} as T;
		const id = await this.append(piSession, ENTRY_TYPES.message, stamped);
		this.cache({ type: 'message', message: stamped }, id);
		landed?.(stamped);
		return { message: stamped };
	}

	since(cursor: Seq | undefined): Message[] {
		if (cursor === undefined) return [...this.messages];
		return this.messages.filter((message) => message.seq > cursor);
	}
}
