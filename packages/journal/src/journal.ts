/**
 * The journal: every entry a writer committed, in the order it landed.
 *
 * The *record* is what the journal holds, and the *journal* is the
 * append-only structure that holds it. `Entry` and `Journal` are the two
 * words; `Record` is TypeScript's own name for a map type, so the class
 * does not take it.
 *
 * It is the one thing a live writer and a read of a stopped one share, so
 * it knows nothing about either: it replays journal storage into memory and
 * commits one entry at a time on a serial queue. An entry exists when its
 * write is confirmed, and nothing observes it before: the cache updates
 * after the append resolves, and a caller that awaits `commit` holds an
 * entry that is on the record.
 *
 * **The record holds two kinds of entry, and it reads neither.** A
 * *record* entry makes up the record a reader reads; every other kind sits
 * beside it. Both join the same queue, so they land in the order they were
 * asked for. What each one means belongs to the caller, which names its
 * kinds in a `Vocabulary`.
 *
 * **The envelope is the journal's, and the body is the caller's.** Storage
 * holds one nested envelope with kind, body, seq, key, and run. One counter
 * gives out every seq. The body stays nested, so its fields do not collide.
 *
 * **A key is an idempotency token, and a `readThrough` is a conditional
 * write.** The two checks the queue runs answer different questions. A
 * repeated key returns the entry the first commit landed and writes
 * nothing, which is what lets a caller retry a commit whose outcome it
 * never learned. A `readThrough` names the seq the author has read: the
 * queue refuses the commit when the record moved past that, and hands back
 * what the author missed — optimistic concurrency, enforced where the write
 * happens. A commit may name both, and either check alone can stop it.
 *
 * The key index is the record itself. Every record entry the journal takes
 * carries its key into the index, on the replay as well as on the append,
 * so a caller that retries after a crash meets the token the storage holds
 * and not a memory the crash took. A checkpoint keeps every record entry,
 * so the token never expires and the journal holds no dedup window.
 *
 * The journal reads what the storage holds past its cursor before every
 * write, and again on the queue behind a write that failed. A write whose
 * confirmation was lost is on the record before anything lands on top of
 * it, and a read of the record waits for the queue. The cursor moves to
 * the final storage position every read saw, so a read costs the entries since the
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
import { nextSeq, refused, supersedes, voided } from './rules.verified.ts';
import type { JournalStorage, StoredEntry } from './storage.ts';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = number;

/**
 * One entry on a journal: the one envelope every user shares.
 *
 * `kind` is what the writer called it, and `body` is what the writer wrote.
 * The other three fields are the journal's own, and the storage holds them
 * beside the body: `seq` is the place the entry took, from the one counter
 * the journal keeps, `key` is what named the commit, and `run` is who wrote
 * it. An entry that took no place is not one this journal takes.
 *
 * The journal reads a body for one thing, and never for what it means: it
 * asks the caller's `accepts` whether the body is one that caller reads.
 */
export interface Entry<TBody = unknown> {
	/** What the writer called it. */
	readonly kind: string;
	/** What the writer wrote. The journal never reads it. */
	readonly body: TBody;
	/** The place it took on the record. Every entry takes one. */
	readonly seq: Seq;
	/** The idempotency token the commit carried. A repeated token lands once. */
	readonly key?: string;
	/** The run that wrote it, or nothing from before runs were fenced. */
	readonly run?: string;
}

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
 * The caller's entry kinds, as the journal needs them. `accepts` validates a
 * kind and body before the journal takes it.
 */
export interface Vocabulary<TKind extends string = string> {
	/** The kind that makes up the record a reader reads. Every other kind is about it. */
	readonly record: TKind;
	/** The kind that fences a run. */
	readonly run: TKind;
	/** The kind that replaces every entry before it. */
	readonly checkpoint: TKind;
	/** Whether this kind and body are values the caller reads. */
	accepts(kind: string, body: unknown): kind is TKind;
}

/** The native envelope that journal storage holds. The body stays nested. */

interface Stored {
	kind?: unknown;
	body?: unknown;
	seq?: unknown;
	key?: unknown;
	run?: unknown;
	[field: string]: unknown;
}

/** The run that wrote a stored entry: the fence reads it before any envelope. */
const writerOf = (entry: unknown): string | undefined => {
	const run = (entry as Stored).run;
	return typeof run === 'string' ? run : undefined;
};

/**
 * The body a draft yields. A body may be any shape the caller chose, so the
 * branch reads the draft's own form rather than narrowing on it.
 */
function drafted<T>(draft: T | (() => T)): T {
	return typeof draft === 'function' ? (draft as () => T)() : draft;
}

/**
 * One body, with the journal's own fields beside it, as the storage holds it.
 * The envelope nests the body, so body fields never collide with journal
 * fields.
 */
const beside = (kind: string, body: unknown, seq: Seq, key?: string, run?: string): Stored => ({
	kind,
	body,
	seq,
	...(key === undefined ? {} : { key }),
	...(run === undefined ? {} : { run }),
});

/**
 * The envelope a stored entry folds to, or nothing when it is not one this
 * journal takes. Strict on purpose: a kind this reader does not know, a body
 * the caller turns down, or no place on the record is no entry at all, and
 * the journal skips it rather than caching something it cannot hold to its
 * contract.
 */
function envelope<TKind extends string>(
	words: Vocabulary<TKind>,
	data: unknown,
): Entry | undefined {
	if (data === null || typeof data !== 'object') return undefined;
	const stored = data as Stored;
	const kind = stored.kind;
	if (typeof kind !== 'string') return undefined;
	const body = stored.body;
	if (!words.accepts(kind, body)) return undefined;
	const seq = positionOf(stored.seq);
	// Every entry takes a place on the record; one without is not an entry.
	if (seq === undefined) return undefined;
	return {
		kind,
		body,
		seq,
		...(typeof stored.key === 'string' ? { key: stored.key } : {}),
		...(typeof stored.run === 'string' ? { run: stored.run } : {}),
	};
}

/** A place off a stored field, or nothing when the field holds no place. */
function positionOf(value: unknown): Seq | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** What a caller commits: the body, and the two checks the queue runs. */
export interface CommitIntent<TBody> {
	/**
	 * The idempotency token for this commit. The caller chooses it, and the
	 * journal reads it for one question: did this commit land before? A
	 * repeated token appends nothing and answers with the entry that landed.
	 * A caller with nothing to retry under names a token of its own that
	 * matches nothing.
	 */
	key?: string;
	/** The seq the author has read. The queue refuses the commit when the record moved past it. */
	readThrough?: Seq;
	/**
	 * The body, or a function that builds it where the write happens. The
	 * journal keeps the place of its own, so a draft never names one.
	 */
	draft: TBody | (() => TBody);
}

/**
 * The entry the commit stands for, or the record moved under it. A commit
 * whose key had landed before answers with the entry that first landed, so
 * a caller reads one shape whether its own write appended or a retry
 * deduplicated.
 */
export type Committed<TBody, TAll = TBody> =
	| { entry: Entry<TBody> }
	/** Every record entry the journal took past what the author read. */
	| { missed: readonly Entry<TAll>[] };

export class Journal<TKind extends string, TBodies extends Bodies<TKind>, TRecord extends TKind> {
	/** Every entry, replayed then appended, in the order the writes were confirmed. */
	readonly entries: Entries<TKind, TBodies>[] = [];
	/** The entries that make up the record, in order. */
	readonly record: Entry<TBodies[TRecord]>[] = [];
	readonly ready: Promise<JournalStorage>;
	/** The place the last entry took. The next entry of any kind takes the one after it. */
	lastSeq = 0;
	/**
	 * The place the last record entry took. Rule 5 reads this: what an author
	 * read is a place on the record, and an entry beside the record moves
	 * neither what they read nor what they missed.
	 */
	lastCommitted = 0;
	private readonly byKey = new Map<string, Entry<TBodies[TRecord]>>();
	/** The serial queue. One commit at a time, in the order they were asked for. */
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	/** The storage position the last read scanned. */
	private cursor = 0;
	/** The replay is over: every entry the journal takes from now on is news, and `hear` takes it. */
	private replayed = false;
	/** The run whose entry landed last: entries of any other run after it are void. */
	private fence: string | undefined;
	/** This run's entry is on the journal: one of another run found from now on is a later run's. */
	private fenced = false;
	/** A later run's entry was found: this run's writes are over. */
	private superseded = false;
	/** How many entries beside the record the cache holds past the last checkpoint. */
	sinceCheckpoint = 0;

	/**
	 * `hear` takes every entry the journal takes after the replay: one this run
	 * appended, and one a read found because the writer never heard or
	 * another run wrote it. `run` names the run this journal writes for, or
	 * nothing for a journal that only reads. `lost` hears that a later run took
	 * the name. `words` names the caller's entry kinds.
	 */
	constructor(
		open: Promise<JournalStorage>,
		private readonly words: Vocabulary<TKind>,
		private readonly hear?: (entry: Entries<TKind, TBodies>) => void,
		private readonly run?: string,
		private readonly lost?: () => void,
	) {
		this.ready = this.replay(open);
		// A host can hold storage and read nothing from it for hours, so
		// nothing may await `ready` for a long time. Mark the rejection handled
		// here: a storage that cannot open must surface at the call that needs
		// the journal, and never as an unhandled rejection that ends the process.
		void this.ready.catch(() => {});
	}

	private async replay(open: Promise<JournalStorage>): Promise<JournalStorage> {
		const storage = await open;
		await this.read(storage);
		this.replayed = true;
		return storage;
	}

	/**
	 * Drop everything the latest checkpoint replaced. The checkpoint stays,
	 * and so does every record entry: a caller reads what the checkpoint
	 * carries in place of what was dropped. The run entries go with them,
	 * because the fence is read off the storage and never off the cache.
	 */
	private compact(): void {
		const at = this.entries.findLastIndex((entry) => entry.kind === this.words.checkpoint);
		if (at < 0) return;
		const kept = this.entries.slice(0, at).filter((entry) => entry.kind === this.words.record);
		this.entries.splice(0, at, ...kept);
		this.sinceCheckpoint = this.entries
			.slice(kept.length + 1)
			.filter((entry) => entry.kind !== this.words.record).length;
	}

	/**
	 * Cache every entry the storage holds past the cursor that the cache
	 * lacks, tell `found` about each one after the replay, and move the
	 * cursor to the last entry seen. Nothing at or before the cursor is
	 * read again. The cursor distinguishes a found entry from one already
	 * cached.
	 */
	private async read(storage: JournalStorage): Promise<void> {
		const after = this.cursor;
		const found = await storage.read(after);
		const entries = found.entries.filter((entry) => entry.position > after);
		entries.sort((a, b) => a.position - b.position);
		for (const entry of entries) {
			this.cursor = entry.position;
			const known = envelope(this.words, entry.entry) as Entries<TKind, TBodies> | undefined;
			if (known !== undefined) this.take(known, writerOf(entry.entry));
		}
		this.cursor = Math.max(this.cursor, found.position);
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
	private take(entry: Entries<TKind, TBodies>, written: string | undefined): void {
		if (entry.kind === this.words.run) this.pass(written);
		if (this.voided(entry, written)) return;
		this.cache(entry);
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
	private cache(entry: Entries<TKind, TBodies>): void {
		this.entries.push(entry);
		if (entry.kind === this.words.checkpoint) this.compact();
		else if (entry.kind !== this.words.record) this.sinceCheckpoint += 1;
		this.lastSeq = Math.max(this.lastSeq, entry.seq);
		if (this.recorded(entry)) {
			this.record.push(entry);
			this.lastCommitted = entry.seq;
			if (entry.key !== undefined) this.byKey.set(entry.key, entry);
		}
		if (this.replayed) this.hear?.(entry);
	}

	/**
	 * Whether this entry makes up the record. The kind says so, and this
	 * states the narrowing that follows: the type-checker cannot read it off
	 * a mapped union on its own.
	 */
	private recorded(
		entry: Entries<TKind, TBodies>,
	): entry is Entries<TKind, TBodies> & Entry<TBodies[TRecord]> {
		return entry.kind === this.words.record;
	}

	/**
	 * Write one entry of a kind beside the record. It takes the next place
	 * like any other entry; it joins the same queue, so it and the entries
	 * around it land in the order they were asked. The draft is built
	 * where the write happens, and a builder that returns nothing writes
	 * nothing: the check it ran found the entry no longer needed.
	 *
	 * A record entry is `commit`'s alone. This takes every other kind, so a
	 * caller cannot put an entry on the record without the two checks the
	 * commit queue runs for it.
	 */
	write<K extends Exclude<TKind, TRecord>>(
		kind: K,
		draft: TBodies[K] | (() => TBodies[K] | undefined),
	): Promise<boolean> {
		const link = this.tail.then(async () => {
			const storage = await this.open();
			const body = drafted(draft);
			if (body === undefined) return false;
			const stored = beside(kind, body, nextSeq(this.lastSeq), undefined, this.run);
			const appended = await this.append(storage, stored);
			this.cursor = appended.position;
			this.took(appended);
			return true;
		});
		this.tail = link.catch(() => {});
		return link;
	}

	/**
	 * Commit one record entry. The check, the append and the cache update
	 * run inside one link of the queue, and `hear` runs there too, before the
	 * next commit starts: what a caller does with a fresh entry happens
	 * before anything else lands on top of it.
	 */
	commit<T extends TBodies[TRecord]>(
		intent: CommitIntent<T>,
	): Promise<Committed<T, TBodies[TRecord]>> {
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
	 * The storage to write to, or the failure a closed or superseded journal
	 * answers every write with. The journal reads the storage first: what
	 * another run wrote, and what a write in doubt left.
	 */
	private async open(): Promise<JournalStorage> {
		this.refuse();
		const storage = await this.ready;
		await this.read(storage);
		// A journal closed or superseded while the read ran writes nothing more.
		this.refuse();
		return storage;
	}

	private refuse(): void {
		if (this.superseded) throw new Error('The run is superseded: another run holds the name.');
		if (this.closed) throw new Error('The journal is closed.');
	}

	/**
	 * One append of what the storage holds: the body, and the journal's own
	 * three beside it. A failure puts the journal in doubt, whatever the
	 * storage did with the entry, and queues the read that settles it.
	 */
	private async append(storage: JournalStorage, entry: unknown): Promise<StoredEntry> {
		try {
			return await this.landed(storage, entry);
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
	private async landed(storage: JournalStorage, entry: unknown): Promise<StoredEntry> {
		const stored = await storage.append(entry, this.cursor);
		if (stored === undefined) throw new Error('The record moved under the write.');
		return stored;
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

	private async land<T extends TBodies[TRecord]>(
		intent: CommitIntent<T>,
	): Promise<Committed<T, TBodies[TRecord]>> {
		const storage = await this.open();
		const seen = intent.key === undefined ? undefined : this.byKey.get(intent.key);
		if (seen !== undefined) return { entry: seen as Entry<T> };
		if (intent.readThrough !== undefined && refused(this.lastCommitted, intent.readThrough)) {
			return { missed: this.since(intent.readThrough) };
		}
		const body = drafted(intent.draft);
		const stored = beside(this.words.record, body, nextSeq(this.lastSeq), intent.key, this.run);
		const appended = await this.append(storage, stored);
		this.cursor = appended.position;
		return { entry: this.took(appended) as Entry<T> };
	}

	/**
	 * One entry this journal appended, into the cache. The envelope folds
	 * from the bytes the append took, so the cache holds what the storage
	 * holds. A vocabulary that turns down what the journal wrote breaks the
	 * journal's contract: the storage holds the entry, the cache never will,
	 * and the next record entry takes a seq this one already took. Say so
	 * where it happens.
	 */
	private took(stored: StoredEntry): Entries<TKind, TBodies> {
		const entry = envelope(this.words, stored.entry) as Entries<TKind, TBodies> | undefined;
		if (entry === undefined) {
			throw new Error(
				`The vocabulary turns down '${String((stored.entry as Stored).kind)}', which this journal wrote. ` +
					"'accepts' must take every body the caller drafts.",
			);
		}
		this.take(entry, writerOf(stored.entry));
		return entry;
	}

	/** Every record entry past a place. */
	since(cursor: Seq | undefined): Entry<TBodies[TRecord]>[] {
		if (cursor === undefined) return [...this.record];
		return this.record.filter((entry) => entry.seq > cursor);
	}
}
