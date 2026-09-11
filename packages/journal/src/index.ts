/**
 * An append-only journal over a Pi session.
 *
 * One serial queue, fenced by run, checkpointed, and honest about a write
 * it is in doubt about. The *journal* is the structure; the *record* is
 * what it holds, and the room that writes to one keeps that word for its
 * own content.
 *
 * A journal takes two kinds of entry, and reads neither. A *positioned*
 * entry takes the next seq; every other kind takes no seq and carries
 * `after`, the last seq when it landed. What each one means belongs to the
 * caller, which names its kinds in a `Vocabulary`.
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
	Drafts,
	Entries,
	Entry,
	FencedSession,
	Positioned,
	Seq,
	Vocabulary,
} from './journal.ts';
export { bodyOf, envelope, fenced, Journal } from './journal.ts';
export { nextSeq, refused, supersedes, voided } from './rules.verified.ts';
export type { SessionOpener, Sql, SqlValue } from './sqlite.ts';
export { SqliteSessionStorage, sqliteSessions } from './sqlite.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/journal';
