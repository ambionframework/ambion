/**
 * The journal: every entry a writer appended, in the order it landed.
 *
 * The journal is the append-only structure that holds every accepted entry.
 *
 * It is the one thing a live writer and a read of a stopped one share, so
 * it knows nothing about either: it replays journal storage into memory and
 * appends one entry at a time on a serial queue. An entry exists when its
 * append is confirmed, and nothing observes it before: the cache updates
 * after the append resolves, and a caller that awaits `append` holds an
 * entry that is in the journal.
 *
 * **The journal reads no entry meaning.** Every kind joins the same queue, so
 * entries land in the order in which callers ask for them. What each one
 * means belongs to the caller, which names its kinds in a `Vocabulary`.
 *
 * **The envelope is the journal's, and the body is the caller's.** Storage
 * holds one nested envelope with kind, body, seq, key, and run. One counter
 * gives out every seq. The body stays nested, so its fields do not collide.
 *
 * **A key is an idempotency token.** A repeated key returns the entry the
 * first append landed and writes nothing, which lets a caller retry an
 * append whose outcome it never learned. A key belongs to every kind. A
 * retry under the same kind returns the original entry; another kind throws
 * a key-collision error.
 *
 * The key index covers every entry. Every keyed entry the journal takes
 * carries its key into the index, on replay and append, so a caller that
 * retries after a crash meets the token storage holds. Every entry stays
 * durable, so the token never expires and the journal holds no dedup window.
 *
 * The journal reads what the storage holds past its cursor before every
 * append, and again on the queue behind an append that failed. An append
 * whose confirmation was lost is in the journal before anything lands on
 * top of it, and a read of the journal waits for the queue. The cursor moves to
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
 * append from then on fails. A journal with no run of its own writes nothing
 * about runs, and reads the fence like any other reader.
 *
 * The design contract is `docs/durability.md`.
 */
import {
	advanceSeq,
	type Fence,
	fenceStep,
	type Keyed,
	keyed,
	nextSeq,
	type Passed,
	type Seen,
	scanned,
	writable,
} from './rules.verified.ts';
import type { JournalStorage, StoredEntry } from './storage.ts';

/** A journal sequence: monotonic, assigned at append, never reused. */
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

/** Clone one value at an ownership boundary. Journal bodies are JSON values. */
function detached<T>(value: T): T {
	return structuredClone(value);
}

/**
 * A value that survives `structuredClone`. The journal copies every body at
 * each ownership boundary, so a body holds data: a JSON value, and the extras
 * `structuredClone` keeps (a `Date`, a `bigint`, an `undefined` field). A
 * function, a symbol, or a class instance does not survive the copy, so
 * `Cloneable` maps it to `never`, and a proof over such a body stops matching.
 */
type Cloneable<T> = T extends string | number | boolean | bigint | null | undefined | Date
	? T
	: T extends (...args: never[]) => unknown
		? never
		: T extends symbol
			? never
			: T extends readonly unknown[]
				? { [K in keyof T]: Cloneable<T[K]> }
				: T extends object
					? { [K in keyof T]: Cloneable<T[K]> }
					: never;

/** True only when `A` and `B` are the same type, and false otherwise. */
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** True only when every body of a journal over these kinds survives cloning. */
type BodiesAreCloneable<TKind extends string, TBodies extends Bodies<TKind>> = {
	[K in TKind]: Equal<TBodies[K], Cloneable<TBodies[K]>>;
}[TKind];

/**
 * A journal whose bodies are proven to survive `structuredClone` at compile
 * time. The journal copies every body at each ownership boundary, so a body
 * holds data. Name a journal type through this alias, and it stops compiling
 * the moment a body gains a function, a symbol, or a class instance. See
 * `docs/durability.md` §2.
 */
export type CloneableJournal<TKind extends string, TBodies extends Bodies<TKind>> =
	BodiesAreCloneable<TKind, TBodies> extends true ? Journal<TKind, TBodies> : never;

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
	/** The kind that fences a run. */
	readonly run: TKind;
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
 * journal takes. An unknown kind is foreign storage and is skipped. A known
 * kind with an invalid body or an invalid seq is malformed storage and
 * throws. This distinction keeps a reader extensible and keeps malformed
 * history visible.
 */
function envelope<TKind extends string>(
	words: Vocabulary<TKind>,
	data: unknown,
): Entry | undefined {
	if (data === null || typeof data !== 'object') return undefined;
	const stored = data as Stored;
	const kind = stored.kind;
	if (typeof kind !== 'string') return undefined;
	// Validate an owned copy. A vocabulary is application code and must not
	// be able to mutate a storage snapshot that the journal later caches.
	const candidate = detached(stored.body);
	if (!words.accepts(kind, candidate)) return undefined;
	const seq = positionOf(stored.seq);
	// Every entry takes a place on the record. A known kind without one is corrupt.
	if (seq === undefined) throw new Error(`The stored '${kind}' entry has no valid seq.`);
	return {
		kind,
		// Storage owns its returned snapshot; take another copy before the
		// value enters the journal cache so an adapter cannot alias it.
		body: detached(stored.body),
		seq,
		...(typeof stored.key === 'string' ? { key: stored.key } : {}),
		...(typeof stored.run === 'string' ? { run: stored.run } : {}),
	};
}

/**
 * The last seq the journal gives out. A seq is a double, so the proof over
 * integers holds only while every successor is exact: a cached seq stays
 * below the largest safe integer, and the journal refuses to fill the place
 * before it.
 */
const LAST_SEQ = Number.MAX_SAFE_INTEGER - 1;

/** A place off a stored field, or nothing when the field holds no place. */
function positionOf(value: unknown): Seq | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= LAST_SEQ
		? value
		: undefined;
}

/** A synchronous proposal made after the queue has recovered storage. */
export type AppendDecision<TBody, TResult> = { body: TBody } | { result: TResult };

/** What one conditional append returns. */
export type AppendResult<TEntry, TResult> = { entry: TEntry } | { result: TResult };

export interface AppendIntent<TBody, TResult> {
	/** The permanent idempotency token for this append, when one is needed. */
	readonly key?: string;
	/** Build a body or a caller result after recovery, inside the write queue. */
	readonly decide: () => AppendDecision<TBody, TResult>;
}

type KindEntry<TKind extends string, TBodies extends Bodies<TKind>, K extends TKind> = Entries<
	K,
	TBodies
>;

export class Journal<TKind extends string, TBodies extends Bodies<TKind>> {
	/** Every entry, replayed then appended, in the order the writes were confirmed. */
	private readonly cache: Entries<TKind, TBodies>[] = [];
	readonly ready: Promise<JournalStorage>;
	/** The place the last entry took. The next entry of any kind takes the one after it. */
	private sequence = 0;
	get lastSeq(): Seq {
		return this.sequence;
	}
	/** A detached snapshot of the complete accepted history. */
	get entries(): readonly Entries<TKind, TBodies>[] {
		return this.entriesFrom(0);
	}
	/** A detached snapshot of accepted entries from the cache index onward. */
	entriesFrom(start: number): readonly Entries<TKind, TBodies>[] {
		if (!Number.isSafeInteger(start) || start < 0)
			throw new RangeError('The journal entry index must be a non-negative safe integer.');
		return this.cache.slice(start).map((entry) => detached(entry));
	}
	private readonly byKey = new Map<string, Entries<TKind, TBodies>>();
	/** The serial queue. One append at a time, in request order. */
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	/** The storage position the last read scanned. */
	private cursor = 0;
	/** The replay is over: every entry the journal takes from now on is news, and `hear` takes it. */
	private replayed = false;
	/**
	 * The fence as the last read left it: the run whose entry landed last,
	 * whether this run's own entry is on the journal, and whether a later
	 * run's entry was found after it. `fenceStep` moves it, one entry at a time.
	 */
	private fence: Fence = { fence: undefined, fenced: false, superseded: false };

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
	 * Cache every entry the storage holds past the cursor that the cache
	 * lacks, tell `found` about each one after the replay, and move the
	 * cursor to the last entry seen. Nothing at or before the cursor is
	 * read again. The cursor distinguishes a found entry from one already
	 * cached.
	 */
	private async read(storage: JournalStorage): Promise<void> {
		const after = this.cursor;
		const found = await storage.read(after);
		const entries = found.entries.filter((stored) => stored.position > after);
		entries.sort((a, b) => a.position - b.position);
		for (const entry of entries) {
			const known = envelope(this.words, entry.entry) as Entries<TKind, TBodies> | undefined;
			// Validation must finish before the cursor moves. A malformed known
			// entry therefore fails every later read at the same position.
			this.cursor = scanned(this.cursor, entry.position);
			if (known !== undefined) this.take(known, writerOf(entry.entry));
		}
		this.cursor = scanned(this.cursor, found.position);
	}

	/**
	 * One entry a read found that the cache lacks, through the fence. A run
	 * entry moves the fence to its run: this journal's own entry marks it
	 * fenced, and one of another run past that supersedes it, once. Any
	 * other entry is cached unless the fence voids it: written by a run other
	 * than the one whose entry the read passed last. An entry written before
	 * runs were fenced belongs to whatever run stood.
	 */
	private take(entry: Entries<TKind, TBodies>, written: string | undefined): void {
		const passed: Passed = fenceStep(this.fence, this.run, entry.kind === this.words.run, written);
		this.fence = passed.state;
		if (passed.lost) this.lost?.();
		if (passed.keep) this.remember(entry);
	}

	/**
	 * One entry into the cache, and the room hears it. Nothing during the
	 * replay is news, so nothing is heard until the replay is over.
	 */
	private remember(entry: Entries<TKind, TBodies>): void {
		this.cache.push(entry);
		this.sequence = advanceSeq(this.sequence, entry.seq);
		if (entry.key !== undefined) this.byKey.set(entry.key, entry);
		if (this.replayed) this.hear?.(detached(entry));
	}

	/**
	 * Append one kind through the queue. Recovery, key lookup and the fence
	 * run before `decide`. A body appends; a result returns without writing.
	 * A repeated key returns the original entry. A key used by another kind
	 * throws before the decision runs, because its body cannot be typed as K.
	 */
	append<K extends TKind, TResult = never>(
		kind: K,
		intent: AppendIntent<TBodies[K], TResult>,
	): Promise<AppendResult<KindEntry<TKind, TBodies, K>, TResult>> {
		// Capture the operation identity before the request waits behind earlier
		// writes. The decision itself still runs in queue order after recovery.
		const captured: AppendIntent<TBodies[K], TResult> = {
			key: intent.key,
			decide: intent.decide,
		};
		const link = this.tail.then(() => this.land(kind, captured));
		// One append that fails must not stop the next one. The queue keeps its
		// order; the caller of the failed append sees its failure.
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
	 * another run wrote, and what a write in doubt left. `isRun` says whether
	 * the write that follows is this run's own run entry.
	 */
	private async open(isRun: boolean): Promise<JournalStorage> {
		this.refuse(isRun);
		const storage = await this.ready;
		await this.read(storage);
		// A journal closed or superseded while the read ran writes nothing more.
		this.refuse(isRun);
		return storage;
	}

	/**
	 * A closed or superseded journal writes nothing. A run whose own entry is
	 * not on the journal while another run's fence stands writes nothing but
	 * that entry: every reader would void what it wrote before its fence.
	 */
	private refuse(isRun: boolean): void {
		if (writable(this.closed, this.fence, this.run, isRun)) return;
		if (this.fence.superseded)
			throw new Error('The run is superseded: another run holds the name.');
		if (this.closed) throw new Error('The journal is closed.');
		throw new Error('Another run holds the fence: this run must land its run entry first.');
	}

	/**
	 * One append of what the storage holds: the body, and the journal's own
	 * three beside it. A failure puts the journal in doubt, whatever the
	 * storage did with the entry, and queues the read that settles it.
	 */
	private async persist(storage: JournalStorage, entry: unknown): Promise<StoredEntry> {
		try {
			return await this.landed(storage, entry);
		} catch (error) {
			// The storage may hold what the cache does not: the read that settles it is queued.
			this.tail = this.tail.then(() => this.open(true)).catch(() => {});
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

	private async land<K extends TKind, TResult>(
		kind: K,
		intent: AppendIntent<TBodies[K], TResult>,
	): Promise<AppendResult<KindEntry<TKind, TBodies, K>, TResult>> {
		const isRun = kind === this.words.run;
		const storage = await this.open(isRun);
		const seen = intent.key === undefined ? undefined : this.byKey.get(intent.key);
		const named: Seen | undefined =
			seen === undefined ? undefined : { kind: seen.kind, run: seen.run };
		const decided: Keyed = keyed(named, kind, this.words.run, this.run);
		if (decided === 'conflict') {
			throw new Error(
				`The key '${intent.key}' already names a '${seen?.kind}' entry at seq ${seen?.seq}.`,
			);
		}
		if (decided === 'replay' && seen !== undefined) {
			return { entry: detached(seen) as KindEntry<TKind, TBodies, K> };
		}
		const proposal = intent.decide();
		if ('result' in proposal) return proposal;
		if (!('body' in proposal)) {
			throw new Error('The append decision must return a body or a result.');
		}
		if (this.sequence >= LAST_SEQ) {
			throw new Error(`The journal is full: no seq follows ${this.sequence}.`);
		}
		// Capture the draft before crossing the asynchronous storage boundary.
		const stored = beside(
			kind,
			detached(proposal.body),
			nextSeq(this.sequence),
			intent.key,
			this.run,
		);
		// Validate before storage sees the envelope. A bad proposal cannot
		// poison the journal and cannot consume a storage position.
		if (envelope(this.words, stored) === undefined) {
			throw new Error(`The vocabulary rejects the proposed '${kind}' entry.`);
		}
		const appended = await this.persist(storage, stored);
		this.cursor = appended.position;
		return { entry: detached(this.took(appended)) as KindEntry<TKind, TBodies, K> };
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
}
