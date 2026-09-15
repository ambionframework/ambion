/**
 * The journal's own promises, with no room in sight: one entry at a time on
 * a serial queue, a key that lands once, a commit the record moved past
 * refused with what it missed, a fence between runs, and an envelope the
 * journal holds every entry to.
 *
 * `docs/durability.md` states these promises for a room. Here they are
 * proved for the machinery the room is built on.
 */
import { describe, expect, it } from 'vitest';
import { type Entry, Journal, type Vocabulary } from '../src/journal.ts';
import { memoryJournals } from '../src/memory.ts';

/**
 * Three kinds: a `note` makes up the record, and the other two sit beside
 * it. No body names a place or a key: the journal keeps those of its own,
 * and a caller that wants one reads it off the entry.
 */
type Kind = 'note' | 'mark' | 'run';

interface Note {
	text: string;
}
interface Mark {
	label: string;
}
interface Run {
	run: string;
}
interface Bodies {
	note: Note;
	mark: Mark;
	run: Run;
}

const WORDS: Vocabulary<Kind> = {
	record: 'note',
	run: 'run',
	accepts: (kind, body): kind is Kind =>
		(kind === 'note' || kind === 'mark' || kind === 'run') && body !== undefined,
};

let names = 0;
const journals = memoryJournals();

/** One journal over a session of its own, or over one a name already opened. */
async function open(
	id = `journal-${++names}`,
	run?: string,
	hear?: (entry: Entry<Bodies[Kind]>) => void,
	lost?: () => void,
): Promise<Journal<Kind, Bodies, 'note'>> {
	const journal = new Journal<Kind, Bodies, 'note'>(journals.open(id), WORDS, hear, run, lost);
	await journal.ready;
	return journal;
}

const note = (text: string) => ({ text });

/** Put one arbitrary value beside a journal, as another reader or application can. */
async function store(id: string, entry: unknown): Promise<void> {
	const storage = await journals.open(id);
	const read = await storage.read(0);
	const appended = await storage.append(entry, read.position);
	if (appended === undefined) throw new Error('the raw entry lands');
}

describe('a journal', () => {
	it('gives every entry the next seq, from one counter', async () => {
		const journal = await open();
		const first = await journal.commit({ draft: note('one') });
		expect('entry' in first && first.entry.seq).toBe(1);
		await journal.write('mark', { label: 'a' });
		const second = await journal.commit({ draft: note('two') });
		// The mark took seq 2, so the next note takes 3: one counter gives
		// them out, and the record a reader reads is no longer contiguous.
		expect('entry' in second && second.entry.seq).toBe(3);
		const mark = journal.entries.find((entry) => entry.kind === 'mark');
		expect(mark?.seq).toBe(2);
		// The place is the journal's, and never the body's: a caller that wants
		// one reads it off the entry.
		expect(journal.entries.every((entry) => !('seq' in (entry.body as object)))).toBe(true);
		expect(journal.lastSeq).toBe(3);
		expect(journal.lastCommitted).toBe(3);

		// A mark past the last note moves the counter and leaves the record
		// where it stands. Rule 5 and every caller that asks how far the record
		// reaches read `lastCommitted`: an entry beside the record moves neither
		// what an author read nor what they missed. A caller that reads
		// `lastSeq` for that sees every write of its own as the record moving,
		// and asks again for ever.
		await journal.write('mark', { label: 'b' });
		expect(journal.lastSeq).toBe(4);
		expect(journal.lastCommitted).toBe(3);
	});

	it('lands a repeated key once, and hands back what the first commit wrote', async () => {
		const journal = await open();
		const first = await journal.commit({ key: 'k', draft: note('once') });
		const again = await journal.commit({ key: 'k', draft: note('twice') });
		if (!('entry' in first) || !('entry' in again)) throw new Error('both commits land');
		// The second commit answers with the first entry and drops its own draft.
		expect(again.entry).toEqual(first.entry);
		expect(again.entry.body.text).toBe('once');
		expect(journal.record).toHaveLength(1);
		expect(journal.lastSeq).toBe(1);
	});

	it("takes every kind but the record, so a record entry stays commit's alone", async () => {
		const journal = await open();
		await journal.write('mark', { label: 'beside' });
		// `check:types` holds the line below. Widen `write` back to every kind
		// and the directive goes unused, which fails the gate.
		// @ts-expect-error the record kind is not one `write` takes
		const refused = () => journal.write('note', note('past the checks'));
		expect(refused).toBeTypeOf('function');
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['mark']);
		expect(journal.record).toHaveLength(0);
	});

	it('meets a token the storage holds, so a retry after a restart lands nothing', async () => {
		const id = `journal-token-${++names}`;
		const first = await open(id);
		await first.commit({ key: 'k', draft: note('once') });
		// A second journal over the same storage replays the record, and the
		// replay carries every token into the index: a caller that retries
		// after a crash meets the token the storage holds.
		const second = await open(id);
		const again = await second.commit({ key: 'k', draft: note('twice') });
		expect('entry' in again && again.entry.seq).toBe(1);
		expect(second.record.map((entry) => entry.body.text)).toEqual(['once']);
		expect(second.lastSeq).toBe(1);
	});

	it('refuses a commit the record moved past, and hands back what it missed', async () => {
		const journal = await open();
		await journal.commit({ draft: note('one') });
		await journal.commit({ draft: note('two') });
		const late = await journal.commit({ readThrough: 1, draft: note('late') });
		expect('missed' in late && late.missed.map((entry) => [entry.seq, entry.body.text])).toEqual([
			[2, 'two'],
		]);
		// the refused commit took no seq
		expect(journal.lastSeq).toBe(2);
	});

	it('reads only what followed a cursor', async () => {
		const journal = await open();
		await journal.commit({ draft: note('one') });
		await journal.commit({ draft: note('two') });
		await journal.commit({ draft: note('three') });
		expect(journal.since(1).map((entry) => entry.body.text)).toEqual(['two', 'three']);
		expect(journal.since(undefined)).toHaveLength(3);
		expect(journal.since(3)).toEqual([]);
	});

	it('hears every entry after the replay, and nothing during it', async () => {
		const id = `journal-heard-${++names}`;
		const first = await open(id);
		await first.commit({ draft: note('before') });
		const heard: string[] = [];
		const second = await open(id, undefined, (entry) => heard.push(entry.kind));
		// the replay is not news
		expect(heard).toEqual([]);
		await second.commit({ draft: note('after') });
		await second.write('mark', { label: 'a' });
		expect(heard).toEqual(['note', 'mark']);
	});
});

describe('the envelope', () => {
	it('advances the storage cursor over foreign and malformed values without giving them a journal seq', async () => {
		const id = `journal-storage-position-${++names}`;
		await store(id, null);
		await store(id, { kind: 'other', body: { ignored: true }, seq: 400 });
		await store(id, { kind: 'note', body: note('placed'), seq: 7 });
		const journal = await open(id);
		expect(journal.record.map((entry) => [entry.seq, entry.body.text])).toEqual([[7, 'placed']]);
		// Storage has scanned three positions. The journal sequence belongs only to accepted envelopes.
		expect(journal.lastSeq).toBe(7);
		const next = await journal.commit({ draft: note('next') });
		expect('entry' in next && next.entry.seq).toBe(8);
	});

	it('skips a stored entry of a kind this reader does not know', async () => {
		const id = `journal-unknown-${++names}`;
		await store(id, { kind: 'other', body: { text: 'not ours' }, seq: 1 });
		const journal = await open(id);
		expect(journal.entries).toEqual([]);
		expect(journal.lastSeq).toBe(0);
	});

	it('holds the place, the key and the run beside the body, and a replay reads them back', async () => {
		const id = `journal-envelope-${++names}`;
		const first = await open(id, 'run-1');
		await first.commit({ key: 'k', draft: note('one') });
		await first.write('mark', { label: 'a' });

		// A second journal over the same storage reads only what the storage
		// holds. Every entry carries the three, and no body carries any of them.
		const second = await open(id);
		expect(second.entries.map((entry) => [entry.kind, entry.seq, entry.key, entry.run])).toEqual([
			['note', 1, 'k', 'run-1'],
			['mark', 2, undefined, 'run-1'],
		]);
		expect(second.entries.map((entry) => entry.body)).toEqual([{ text: 'one' }, { label: 'a' }]);
		// and the journal this run appended into holds the same envelopes
		expect(first.entries).toEqual(second.entries);
	});

	it('keeps the envelope beside a body that names its own fields', async () => {
		const journal = await open(`journal-reserved-${++names}`, 'run-1');
		// The envelope is nested, so a body may use the same names without
		// changing its position, idempotency token, or fence.
		const body = { text: 'mine', seq: 99, key: 'stolen', run: 'ghost' };
		const landed = await journal.commit({ draft: body as unknown as { text: string } });
		if (!('entry' in landed)) throw new Error('the commit lands');
		expect(landed.entry).toEqual({ kind: 'note', body, seq: 1, run: 'run-1' });
		// The body's `key` is not an idempotency token: an unrelated commit under it lands.
		const other = await journal.commit({ key: 'stolen', draft: note('other') });
		expect('entry' in other && other.entry.seq).toBe(2);
		expect(journal.record).toHaveLength(2);
	});

	it('skips an entry that took no place on the record', async () => {
		const id = `journal-position-${++names}`;
		// neither took a place: a seq that is not one, and none at all
		await store(id, { kind: 'note', body: { text: 'no place' }, seq: 'first' });
		await store(id, { kind: 'mark', body: { label: 'nowhere' } });
		await store(id, { kind: 'note', body: { text: 'placed' }, seq: 1 });
		const journal = await open(id);
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['note']);
		expect(journal.record.map((entry) => entry.body.text)).toEqual(['placed']);
	});

	it('does not replay an entry twice when a reaction throws after its cursor advanced', async () => {
		const id = `journal-callback-cursor-${++names}`;
		const storage = await journals.open(id);
		let throws = true;
		const heard: string[] = [];
		const journal = new Journal<Kind, Bodies, 'note'>(Promise.resolve(storage), WORDS, () => {
			heard.push('note');
			if (throws) {
				throws = false;
				throw new Error('the room reaction failed');
			}
		});
		await journal.ready;
		await store(id, { kind: 'note', body: note('outside'), seq: 1 });
		await expect(journal.commit({ draft: note('blocked') })).rejects.toThrow(/reaction failed/);
		await journal.commit({ draft: note('after') });
		// The later write starts after the failed callback. Replaying it would duplicate the event.
		expect(heard).toEqual(['note', 'note']);
		expect(journal.record.map((entry) => entry.body.text)).toEqual(['outside', 'after']);
	});
});

describe('the fence', () => {
	it('supersedes a run whose fence a later run wrote past', async () => {
		const id = `journal-fence-${++names}`;
		let lost = 0;
		const first = await open(id, 'run-1', undefined, () => {
			lost += 1;
		});
		await first.write('run', { run: 'run-1' });
		await first.commit({ draft: note('mine') });

		// a second run takes the name
		const second = await open(id, 'run-2');
		await second.write('run', { run: 'run-2' });

		// the first run reads the storage before its next write, and finds the fence
		await expect(first.commit({ draft: note('too late') })).rejects.toThrow(/superseded/);
		expect(lost).toBe(1);
		// what the superseded run wrote before the fence stands
		expect(second.record.map((entry) => entry.body.text)).toEqual(['mine']);
	});
});

describe('a write in doubt', () => {
	it('rereads one successful append whose confirmation was lost, then deduplicates its key', async () => {
		const id = `journal-doubt-${++names}`;
		const storage = await journals.open(id);
		let loseConfirmation = true;
		const uncertain = {
			read: storage.read.bind(storage),
			async append(entry: unknown, expectedPosition: number) {
				const landed = await storage.append(entry, expectedPosition);
				if (loseConfirmation) {
					loseConfirmation = false;
					throw new Error('confirmation lost');
				}
				return landed;
			},
		};
		const journal = new Journal<Kind, Bodies, 'note'>(Promise.resolve(uncertain), WORDS);
		await journal.ready;
		await expect(journal.commit({ key: 'once', draft: note('landed') })).rejects.toThrow(
			/confirmation lost/,
		);
		await journal.settled();
		const retry = await journal.commit({ key: 'once', draft: note('duplicate') });
		expect(retry).toMatchObject({ entry: { seq: 1, body: { text: 'landed' } } });
		expect((await storage.read(0)).entries).toHaveLength(1);
	});
});

describe('the envelope', () => {
	it('refuses to acknowledge a write its own vocabulary turns down', async () => {
		// A vocabulary that turns down what the caller drafts: the storage would
		// hold the entry and the cache never would, so the next note would take a
		// seq this one already took. The journal says so rather than acknowledging.
		const strict: Vocabulary<Kind> = {
			...WORDS,
			accepts: (kind): kind is Kind => kind !== 'mark' && WORDS.accepts(kind, undefined),
		};
		const journal = new Journal<Kind, Bodies, 'note'>(
			journals.open(`journal-strict-${++names}`),
			strict,
		);
		await journal.ready;
		await expect(journal.write('mark', { label: 'turned down' })).rejects.toThrow(
			/turns down 'mark'/,
		);
		// nothing joined the cache after the rejected write
		expect(journal.entries).toEqual([]);
	});
});
