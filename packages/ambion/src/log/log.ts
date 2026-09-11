/**
 * The log: every entry a room committed, in the order it landed.
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
 * Beside the messages, the log holds rows about the room: what a run
 * started with, and the leases its seats hold. A row takes no seq and
 * carries `after`, the last seq when it landed. It joins the same queue, so
 * a row and the messages around it land in the order they were asked for.
 *
 * The log reads what the storage holds past its cursor before every
 * write, and again on the queue behind a write that failed. A write whose
 * confirmation was lost is on the record before anything lands on top of
 * it, and a read of the record waits for the queue. The cursor moves to
 * the last entry every read saw, so a read costs the entries since the
 * one before it, whatever the log's age.
 *
 * The log is the room's one input. Every entry it takes reaches the room
 * the same way, whether this run appended it or a read found it: `hear`
 * runs inside the link that took the entry, before the next write starts.
 * So the room has one reaction per entry, and never a second path for the
 * entries it wrote itself.
 *
 * A run is fenced by its run row. Every entry a run writes carries its
 * run id. The fence is positional: as a read passes the storage in order,
 * a run row moves the fence to that run, and an entry of another run past
 * it is void, so the log skips it. A log that passes its own row and then
 * a row of another run is superseded: it tells the room, and every write
 * from then on fails. A log with no run of its own writes nothing about
 * runs, and reads the fence like any other reader.
 */
import type { Session as PiSession } from '@earendil-works/pi-agent-core';
import type { Message, Seq } from '../types.ts';
import {
	type CheckpointRow,
	type CompositionRow,
	isCheckpoint,
	type LeaseRow,
	type RunRow,
	type Without,
} from '../wire.ts';
import { nextSeq, refused, supersedes, voided } from './rules.verified.ts';

/** The five kinds of custom entry the room writes to its Pi session. */
const ENTRY_TYPES = {
	message: 'ambion/message',
	lease: 'ambion/lease',
	composition: 'ambion/composition',
	run: 'ambion/run',
	checkpoint: 'ambion/checkpoint',
} as const;

/** One entry on the log: a message with a seq, or a row about the room around the messages. */
export type LogEntry =
	| { type: 'message'; message: Message }
	| { type: 'lease'; lease: LeaseRow }
	| { type: 'composition'; composition: CompositionRow }
	| { type: 'run'; run: RunRow }
	| { type: 'checkpoint'; checkpoint: CheckpointRow };

/** A row that is not a message: it takes no seq, and carries `after`, the last seq when it was written. */
export type Row = Exclude<LogEntry, { type: 'message' }>;

/** What a caller passes to `write`: the row without `after`, which the log stamps. */
export type RowData<K extends Row['type']> = {
	lease: Without<LeaseRow, 'after'>;
	composition: Without<CompositionRow, 'after'>;
	run: Without<RunRow, 'after'>;
	checkpoint: Without<CheckpointRow, 'after'>;
}[K];

const BY_TYPE: Record<string, LogEntry['type']> = {
	[ENTRY_TYPES.message]: 'message',
	[ENTRY_TYPES.lease]: 'lease',
	[ENTRY_TYPES.composition]: 'composition',
	[ENTRY_TYPES.run]: 'run',
	[ENTRY_TYPES.checkpoint]: 'checkpoint',
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
	// A checkpoint of a shape this room does not read is no entry at all.
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
	/** Every lease id the cache holds a row for. It says whether a row is the first of its lease. */
	private readonly leased = new Set<string>();
	/** Pi's seq of the last entry a read saw: the next read starts past it. */
	private cursor = 0;
	/** The replay is over: every entry the log takes from now on is news, and `hear` takes it. */
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
	 * `hear` takes every entry the log takes after the replay: one this run
	 * appended, and one a read found because the writer never heard or
	 * another run wrote it. `first` says the log held no earlier row for
	 * this lease id. `run` names the run this log writes for, or nothing for
	 * a log that only reads. `lost` hears that a later run took the name.
	 */
	constructor(
		open: Promise<PiSession>,
		private readonly hear?: (entry: LogEntry, first: boolean) => void,
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
		return piSession;
	}

	/**
	 * Drop every row the latest checkpoint replaced. The checkpoint stays,
	 * and so does every message: the fold reads the checkpoint's rows in
	 * place of the ones dropped, and the messages as they are. The run rows
	 * go with them, because the fence is read off the storage and never off
	 * the cache.
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

	/** One entry a read found that the cache lacks: cached unless void. */
	private take(entry: { id: string; customType: string; data?: unknown }): void {
		const known = toEntry(entry.customType, entry.data);
		if (known === undefined || this.voided(known, writerOf(entry.data))) return;
		this.cache(known, entry.id);
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

	/**
	 * One entry into the cache, and the room hears it. Nothing during the
	 * replay is news, so nothing is heard until the replay is over.
	 */
	private cache(entry: LogEntry, id: string): void {
		const first = entry.type !== 'lease' || !this.leased.has(entry.lease.id);
		this.known.add(id);
		this.entries.push(entry);
		if (entry.type === 'lease') this.leased.add(entry.lease.id);
		// A checkpoint carries the leases whose rows it replaces: the log holds
		// a row for each of them, so a later row of theirs is not the first.
		if (entry.type === 'checkpoint') {
			for (const lease of entry.checkpoint.leases) this.leased.add(lease.id);
			this.compact();
		} else if (entry.type !== 'message') this.rowsSinceCheckpoint += 1;
		if (entry.type === 'message') {
			this.messages.push(entry.message);
			this.lastSeq = entry.message.seq;
			if (entry.message.key !== undefined) this.byKey.set(entry.message.key, entry.message);
		}
		if (this.replayed) this.hear?.(entry, first);
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
			const entry = toEntry(ENTRY_TYPES[type], stamped);
			if (entry !== undefined) this.cache(entry, id);
			return true;
		});
		this.tail = link.catch(() => {});
		return link;
	}

	/**
	 * Commit one message. The check, the append and the cache update run
	 * inside one link of the queue, and `hear` runs there too, before the
	 * next commit starts: what the room does with a fresh message happens
	 * before anything else lands on top of it.
	 */
	commit<T extends Message>(intent: CommitIntent<T>): Promise<Committed<T>> {
		const link = this.tail.then(() => this.land(intent));
		// One write that fails must not stop the next one. The queue keeps its
		// order; the caller of the failed write sees its failure.
		this.tail = link.catch(() => {});
		return link;
	}

	/**
	 * Closed: every write asked for from here on fails. A room dropped from
	 * memory closes its log, so a write it still had queued fails the way a
	 * process that died would have failed to make it. An append the storage
	 * already took lands and is cached: it is on the record.
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

	private async land<T extends Message>(intent: CommitIntent<T>): Promise<Committed<T>> {
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
		return { message: stamped };
	}

	since(cursor: Seq | undefined): Message[] {
		if (cursor === undefined) return [...this.messages];
		return this.messages.filter((message) => message.seq > cursor);
	}
}
