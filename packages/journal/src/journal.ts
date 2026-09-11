/**
 * The journal: every entry a writer committed, in the order it landed.
 *
 * The *record* is what the journal holds, and the *journal* is the
 * append-only structure that holds it. `Entry` and `Journal` are the two
 * words; `Record` is TypeScript's own name for a map type, so the class
 * does not take it.
 *
 * It is the one thing a live writer and a read of a stopped one share, so
 * it knows nothing about either: it replays a Pi session into memory and
 * commits one entry at a time on a serial queue. An entry exists when its
 * write is confirmed, and nothing observes it before: the cache updates
 * after the append resolves, and a caller that awaits `commit` holds an
 * entry that is on the record.
 *
 * **The record holds two kinds of entry, and it reads neither.** A
 * *positioned* entry takes the next seq; every other kind takes no seq and
 * carries `after`, the last seq when it landed. Both join the same queue, so
 * they land in the order they were asked for. What each one means belongs to
 * the caller, which names its kinds in a `Vocabulary`.
 *
 * Every commit carries a key. A repeated key returns the entry the first
 * commit landed and writes nothing, which is what lets a caller retry a
 * commit whose outcome it never learned. A commit may also name
 * `readThrough`: the seq its author has read. The queue refuses it when the
 * record moved past that, and hands back what the author missed —
 * optimistic concurrency, enforced where the write happens.
 *
 * The journal reads what the storage holds past its cursor before every
 * write, and again on the queue behind a write that failed. A write whose
 * confirmation was lost is on the record before anything lands on top of
 * it, and a read of the record waits for the queue. The cursor moves to
 * the last entry every read saw, so a read costs the entries since the
 * one before it, whatever the journal's age.
 *
 * Every entry the journal takes reaches the caller the same way, whether
 * this run appended it or a read found it: `hear` runs inside the link
 * that took the entry, before the next write starts. So a caller has one
 * reaction per entry, and never a second path for the entries it wrote
 * itself.
 *
 * A run is fenced by its run entry. Every entry a run writes carries its
 * run id. The fence is positional: as a read passes the storage in order,
 * a run entry moves the fence to that run, and an entry of another run past
 * it is void, so the journal skips it. A journal that passes its own entry and
 * then one of another run is superseded: it tells the caller, and every
 * write from then on fails. A journal with no run of its own writes nothing
 * about runs, and reads the fence like any other reader.
 *
 * The design contract is `docs/durability.md`.
 */
import type { Session as PiSession } from '@earendil-works/pi-agent-core';
import { nextSeq, refused, supersedes, voided } from './rules.verified.ts';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = number;

/** The session as one that refuses a moved append, or nothing when its storage cannot. */
export function fenced(session: PiSession): (PiSession & FencedSession) | undefined {
	const candidate = session as Partial<FencedSession>;
	return typeof candidate.appendAfter === 'function'
		? (session as PiSession & FencedSession)
		: undefined;
}

/**
 * A session that refuses an append when the record moved under the writer.
 *
 * A run reads the storage before every write, and the read tells it where
 * the record stood. `appendAfter` takes that position: the entry lands at
 * the next one, or the storage says the record moved and writes nothing.
 * A run that was fenced while its write waited is refused before it can
 * acknowledge, so the write it held is no loss.
 *
 * A storage that cannot promise it does not offer it, and the record
 * appends the way it always did. The fence still voids what such a storage
 * takes.
 */
export interface FencedSession {
	/** The entry's id, or nothing when the record moved past `expected`. */
	appendAfter(customType: string, data: unknown, expected: number): Promise<string | undefined>;
}

/**
 * One entry on a journal: the one envelope every user shares.
 *
 * `kind` is what the writer called it, and `body` is what the writer wrote.
 * The journal never reads a body. It reads the envelope, and it holds every
 * entry to it: a *positioned* entry carries `seq`, the place it took on the
 * record; every other kind carries `after`, the last seq when it landed. An entry
 * that carries neither, or both, is not one this journal takes.
 *
 * The body keeps its own copy of `seq` and `key` today, because that is how
 * the storage holds them. `planning/simplification.md` §4 is the change that
 * moves the position out of the body for good.
 */
export interface Entry<TBody = unknown> {
	/** What the writer called it. */
	readonly kind: string;
	/** What the writer wrote. The journal never reads it. */
	readonly body: TBody;
	/** The place it took on the record, for an entry that takes one. */
	readonly seq?: Seq;
	/** The key the commit carried. A repeated key lands once. */
	readonly key?: string;
	/** The last seq when an unpositioned entry landed. */
	readonly after?: Seq;
	/** The run that wrote it, or nothing from before runs were fenced. */
	readonly run?: string;
}

/** An entry that took a place on the record: `seq` is there, `after` is not. */
export type Positioned<TBody = unknown> = Entry<TBody> & { readonly seq: Seq };

/** The body each kind carries. A caller names one body shape per kind. */
export type Bodies<TKind extends string> = Record<TKind, unknown>;

/**
 * Every entry a journal over these kinds holds, as one discriminated union.
 * A caller narrows on `kind` and reads the body that kind carries.
 */
export type Entries<TKind extends string, TBodies extends Bodies<TKind>> = {
	[K in TKind]: Entry<TBodies[K]> & { readonly kind: K };
}[TKind];

/**
 * The caller's entry kinds, as the journal needs them. A kind is a name the
 * caller chose; `stored` is what the storage holds it under.
 *
 * The journal reads no body. It needs four facts: what a kind is stored as
 * and back, which kind takes a position, which kind fences a run, and which
 * kind replaces every entry before it. `accepts` is the caller's own check on a
 * body, and the journal refuses an entry it turns down.
 */
export interface Vocabulary<TKind extends string = string> {
	/** What the storage holds this kind under. */
	stored(kind: TKind): string;
	/** The kind a stored custom type names, or nothing for one this reader skips. */
	kindOf(customType: string): TKind | undefined;
	/** The kind that takes the next position. Every other kind sits beside them. */
	readonly positioned: TKind;
	/** The kind that fences a run. */
	readonly run: TKind;
	/** The kind that replaces every entry before it. */
	readonly checkpoint: TKind;
	/** Whether this body is one the caller reads under this kind. */
	accepts(kind: TKind, body: unknown): boolean;
}

/** What each kind writes, by kind. A caller names one draft shape per kind. */
export type Drafts = Record<string, object>;

/** What the storage holds for one entry: the body's own fields, and the run that wrote it. */
interface Stored {
	written?: string;
	[field: string]: unknown;
}

/** The run that wrote a stored entry, or nothing for an entry written before runs were fenced. */
const writerOf = (data: unknown): string | undefined => (data as Stored).written;

/** The body as the caller wrote it: everything stored but the journal's own field. */
export function bodyOf(data: unknown): Record<string, unknown> {
	const { written: _written, ...body } = data as Stored;
	return body;
}

/**
 * The envelope a stored entry folds to, or nothing when it is not one this
 * journal takes. Strict on purpose: a kind this reader does not know, a body
 * the caller turns down, or a position of the wrong sort is no entry at all,
 * and the journal skips it rather than caching something it cannot hold to
 * its contract.
 */
export function envelope<TKind extends string>(
	words: Vocabulary<TKind>,
	customType: string,
	data: unknown,
): Entry | undefined {
	const kind = words.kindOf(customType);
	if (kind === undefined) return undefined;
	const body = bodyOf(data);
	if (!words.accepts(kind, body)) return undefined;
	const seq = positionOf(body.seq);
	const after = positionOf(body.after);
	// One position, of the sort the kind takes.
	if (kind === words.positioned ? seq === undefined : after === undefined) return undefined;
	return {
		kind,
		body,
		...(seq === undefined ? {} : { seq }),
		...(after === undefined ? {} : { after }),
		...(typeof body.key === 'string' ? { key: body.key } : {}),
		...(writerOf(data) === undefined ? {} : { run: writerOf(data) }),
	};
}

/** A position off a stored body, or nothing when it is not one. */
function positionOf(value: unknown): Seq | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** What a caller commits: the body minus its seq, and the two checks the queue runs. */
export interface CommitIntent<TBody> {
	/** Names this commit. A repeated key lands once. */
	key?: string;
	/** The seq the author has read. The queue refuses the commit when the record moved past it. */
	readThrough?: Seq;
	/** The body, or a function of the record as it stands when the commit runs. */
	draft: Omit<TBody, 'seq' | 'key'> | ((lastSeq: Seq) => Omit<TBody, 'seq' | 'key'>);
}

/** The commit landed, or the key had landed before, or the record had moved. */
export type Committed<TBody, TAll = TBody> =
	| { body: TBody; repeated?: true }
	/** Every body the record took past what the author read. */
	| { missed: readonly TAll[] };

export class Journal<
	TKind extends string,
	TBodies extends Bodies<TKind>,
	TPositioned extends TKind,
	TDrafts extends Drafts,
> {
	/** Every entry, replayed then appended, in the order the writes were confirmed. */
	readonly entries: Entries<TKind, TBodies>[] = [];
	/** The bodies of the entries that took a position, in order. */
	readonly positioned: TBodies[TPositioned][] = [];
	readonly ready: Promise<PiSession>;
	lastSeq = 0;
	private readonly byKey = new Map<string, TBodies[TPositioned]>();
	/** The serial queue. One commit at a time, in the order they were asked for. */
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	/** Pi's id of every entry the cache holds past the cursor: what a read in doubt finds again. */
	private readonly known = new Set<string>();
	/** Pi's seq of the last entry a read saw: the next read starts past it. */
	private cursor = 0;
	/** The replay is over: every entry the journal takes from now on is news, and `hear` takes it. */
	private replayed = false;
	/** The run whose entry landed last: entries of any other run after it are void. */
	private fence: string | undefined;
	/** This run's entry is on the journal: one of another run found from now on is a later run's. */
	private fenced = false;
	/** A later run's entry was found: this run's writes are over. */
	private superseded = false;
	/** How many entries beside the positioned ones the cache holds past the last checkpoint. */
	sinceCheckpoint = 0;

	/**
	 * `hear` takes every entry the journal takes after the replay: one this run
	 * appended, and one a read found because the writer never heard or
	 * another run wrote it. `run` names the run this journal writes for, or
	 * nothing for a journal that only reads. `lost` hears that a later run took
	 * the name. `words` names the caller's entry kinds.
	 */
	constructor(
		open: Promise<PiSession>,
		private readonly words: Vocabulary<TKind>,
		private readonly hear?: (entry: Entries<TKind, TBodies>) => void,
		private readonly run?: string,
		private readonly lost?: () => void,
	) {
		this.ready = this.replay(open);
		// A host can hold a session and read nothing from it for hours, so
		// nothing may await `ready` for a long time. Mark the rejection handled
		// here: a storage that cannot open must surface at the call that needs
		// the journal, and never as an unhandled rejection that ends the process.
		void this.ready.catch(() => {});
	}

	private async replay(open: Promise<PiSession>): Promise<PiSession> {
		const piSession = await open;
		await this.read(piSession);
		this.replayed = true;
		return piSession;
	}

	/**
	 * Drop everything the latest checkpoint replaced. The checkpoint stays,
	 * and so does every positioned entry: a caller reads what the checkpoint
	 * carries in place of what was dropped. The run entries go with them,
	 * because the fence is read off the storage and never off the cache.
	 */
	private compact(): void {
		const at = this.entries.findLastIndex((entry) => entry.kind === this.words.checkpoint);
		if (at < 0) return;
		const kept = this.entries.slice(0, at).filter((entry) => entry.kind === this.words.positioned);
		this.entries.splice(0, at, ...kept);
		this.sinceCheckpoint = this.entries
			.slice(kept.length + 1)
			.filter((entry) => entry.kind !== this.words.positioned).length;
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
			// The fence is positional: a run entry moves it where the entry sits, cached or not.
			if (entry.customType === this.words.stored(this.words.run)) this.pass(writerOf(entry.data));
			if (!this.known.has(entry.id)) this.take(entry);
		}
		this.known.clear();
	}

	/**
	 * The read passed a run entry. The fence moves to that run. This
	 * journal's own entry marks it fenced: one of another run past it is a
	 * later run's, and supersedes this journal.
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
		const known = envelope(this.words, entry.customType, entry.data) as
			Entries<TKind, TBodies> | undefined;
		if (known === undefined || this.voided(known, writerOf(entry.data))) return;
		this.cache(known, entry.id);
	}

	/**
	 * Whether a stored entry is void: written by a run other than the one
	 * whose entry the read passed last. An entry written before runs were
	 * fenced belongs to whatever run stood.
	 */
	private voided(entry: Entries<TKind, TBodies>, written: string | undefined): boolean {
		if (entry.kind === this.words.run) return false;
		return voided(this.fence !== undefined, written !== undefined, written === this.fence);
	}

	/**
	 * One entry into the cache, and the room hears it. Nothing during the
	 * replay is news, so nothing is heard until the replay is over.
	 */
	private cache(entry: Entries<TKind, TBodies>, id: string): void {
		this.known.add(id);
		this.entries.push(entry);
		if (entry.kind === this.words.checkpoint) this.compact();
		else if (entry.kind !== this.words.positioned) this.sinceCheckpoint += 1;
		if (entry.kind === this.words.positioned && entry.seq !== undefined) {
			// The kind is the condition, and it is the one narrowing the
			// type-checker cannot follow from a mapped union to its own member.
			const body = entry.body as TBodies[TPositioned];
			this.positioned.push(body);
			this.lastSeq = entry.seq;
			if (entry.key !== undefined) this.byKey.set(entry.key, body);
		}
		if (this.replayed) this.hear?.(entry);
	}

	/**
	 * Write one entry of a kind that takes no position. It carries `after`,
	 * the last seq when it landed; it joins the same queue, so it and the
	 * entries around it land in the order they were asked. The draft is built
	 * where the write happens, and a builder that returns nothing writes
	 * nothing: the check it ran found the entry no longer needed.
	 */
	write<K extends keyof TDrafts & TKind>(
		kind: K,
		draft: TDrafts[K] | (() => TDrafts[K] | undefined),
	): Promise<boolean> {
		const link = this.tail.then(async () => {
			const piSession = await this.open();
			const data = typeof draft === 'function' ? draft() : draft;
			if (data === undefined) return false;
			const stamped = { ...data, after: this.lastSeq };
			const stored = this.words.stored(kind);
			const id = await this.append(piSession, stored, stamped);
			const entry = envelope(this.words, stored, stamped) as Entries<TKind, TBodies> | undefined;
			if (entry !== undefined) this.cache(entry, id);
			return true;
		});
		this.tail = link.catch(() => {});
		return link;
	}

	/**
	 * Commit one positioned entry. The check, the append and the cache update
	 * run inside one link of the queue, and `hear` runs there too, before the
	 * next commit starts: what a caller does with a fresh entry happens
	 * before anything else lands on top of it.
	 */
	commit<T extends TBodies[TPositioned]>(
		intent: CommitIntent<T>,
	): Promise<Committed<T, TBodies[TPositioned]>> {
		const link = this.tail.then(() => this.land(intent));
		// One write that fails must not stop the next one. The queue keeps its
		// order; the caller of the failed write sees its failure.
		this.tail = link.catch(() => {});
		return link;
	}

	/**
	 * Closed: every write asked for from here on fails. A room dropped from
	 * memory closes its journal, so a write it still had queued fails the way a
	 * process that died would have failed to make it. An append the storage
	 * already took lands and is cached: it is on the record.
	 */
	close(): void {
		this.closed = true;
	}

	/**
	 * The session to write to, or the failure a closed or superseded journal
	 * answers every write with. The journal reads the storage first: what
	 * another run wrote, and what a write in doubt left.
	 */
	private async open(): Promise<PiSession> {
		this.refuse();
		const piSession = await this.ready;
		await this.read(piSession);
		// A journal closed or superseded while the read ran writes nothing more.
		this.refuse();
		return piSession;
	}

	private refuse(): void {
		if (this.superseded) throw new Error('The run is superseded: another run holds the name.');
		if (this.closed) throw new Error('The journal is closed.');
	}

	/**
	 * One append, stamped with the run that writes it. A failure puts the
	 * journal in doubt, whatever the storage did with the entry, and queues the
	 * read that settles it.
	 */
	private async append(piSession: PiSession, type: string, data: unknown): Promise<string> {
		const stored = this.run === undefined ? data : { ...(data as object), written: this.run };
		try {
			return await this.landed(piSession, type, stored);
		} catch (error) {
			// The storage may hold what the cache does not: the read that settles it is queued.
			this.tail = this.tail.then(() => this.open()).catch(() => {});
			throw error;
		}
	}

	/**
	 * The append itself. A storage that refuses a moved append takes the
	 * cursor the read left: the entry lands next to what this run read, or
	 * the record moved under the write and nothing lands. A run fenced while
	 * its write waited is refused here, so it acknowledges nothing.
	 */
	private async landed(piSession: PiSession, type: string, stored: unknown): Promise<string> {
		const refuses = fenced(piSession);
		if (refuses === undefined) return piSession.appendCustomEntry(type, stored);
		const id = await refuses.appendAfter(type, stored, this.cursor);
		if (id === undefined) throw new Error('The record moved under the write.');
		return id;
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

	private async land<T extends TBodies[TPositioned]>(
		intent: CommitIntent<T>,
	): Promise<Committed<T, TBodies[TPositioned]>> {
		const piSession = await this.open();
		const seen = intent.key === undefined ? undefined : this.byKey.get(intent.key);
		if (seen !== undefined) return { body: seen as T, repeated: true };
		if (intent.readThrough !== undefined && refused(this.lastSeq, intent.readThrough)) {
			return { missed: this.since(intent.readThrough) };
		}
		const draft = typeof intent.draft === 'function' ? intent.draft(this.lastSeq) : intent.draft;
		const stamped = {
			...draft,
			seq: nextSeq(this.lastSeq),
			...(intent.key === undefined ? {} : { key: intent.key }),
		} as T;
		const stored = this.words.stored(this.words.positioned);
		const id = await this.append(piSession, stored, stamped);
		const entry = envelope(this.words, stored, stamped) as Entries<TKind, TBodies> | undefined;
		if (entry !== undefined) this.cache(entry, id);
		return { body: stamped };
	}

	since(cursor: Seq | undefined): TBodies[TPositioned][] {
		if (cursor === undefined) return [...this.positioned];
		return this.positioned.filter((body) => (positionOf((body as Stored).seq) ?? 0) > cursor);
	}
}
