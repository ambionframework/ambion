/**
 * An append-only journal over ordered conditional storage.
 *
 * One serial queue, fenced by run, checkpointed, and honest about a write
 * it is in doubt about. The *journal* is the structure; the *record* is
 * what it holds, and the room that writes to one keeps that word for its
 * own content.
 *
 * A journal takes two kinds of entry, and reads neither. A *record* entry
 * makes up the record a reader reads; every other kind sits beside it. One
 * counter gives out every place, so a seq names one entry of any kind. What
 * each one means belongs to the caller, which names its kinds in a
 * `Vocabulary`.
 *
 * The journal holds three fields beside every body: the place the entry
 * took, the key its commit carried, and the run that wrote it. A caller
 * drafts the body alone, and reads those three off the entry.
 *
 * ```ts
 * const journal = new Journal(open, words, (entry) => react(entry), runId, () => lost());
 * await journal.commit({ key, readThrough, draft: () => ({ text: 'hello' }) });
 * ```
 *
 * What it promises under failure, and how the tiers prove it, is
 * `docs/durability.md`.
 */

export type {
	Bodies,
	CommitIntent,
	Committed,
	Entries,
	Entry as JournalEntry,
	Seq,
	Vocabulary,
} from './journal.ts';
export { Journal } from './journal.ts';
export { memoryJournals } from './memory.ts';
export type { Sql, SqlValue } from './sqlite.ts';
export { sqliteJournals } from './sqlite.ts';
export type {
	JournalOpener,
	JournalRead,
	JournalStorage,
	StoragePosition,
	StoredEntry,
} from './storage.ts';
export { namespaced } from './storage.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/journal';
