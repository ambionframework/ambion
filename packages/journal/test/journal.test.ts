/**
 * The journal's own promises, with no room in sight: one entry at a time on
 * a serial queue, a key that lands once, a commit the record moved past
 * refused with what it missed, a checkpoint that replaces what came before,
 * a fence between runs, and an envelope the journal holds every entry to.
 *
 * `docs/durability.md` states these promises for a room. Here they are
 * proved for the machinery the room is built on.
 */
import { InMemorySessionRepo, type Session as PiSession } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { type Entry, Journal, type Vocabulary } from '../src/index.ts';

/** Two kinds: a `note` that takes a position, and a `mark` that sits beside them. */
type Kind = 'note' | 'mark' | 'run' | 'checkpoint';

interface Note {
	seq: number;
	key?: string;
	text: string;
}
interface Mark {
	seq: number;
	label: string;
}
interface Run {
	seq: number;
	run: string;
}
interface Checkpoint {
	seq: number;
	v: 1;
	floor: number;
}

interface Bodies {
	note: Note;
	mark: Mark;
	run: Run;
	checkpoint: Checkpoint;
}

type Drafts = {
	mark: Omit<Mark, 'seq'>;
	run: Omit<Run, 'seq'>;
	checkpoint: Omit<Checkpoint, 'seq'>;
};

const STORED: Record<Kind, string> = {
	note: 'test/note',
	mark: 'test/mark',
	run: 'test/run',
	checkpoint: 'test/checkpoint',
};
const KINDS: Record<string, Kind> = Object.fromEntries(
	Object.entries(STORED).map(([kind, stored]) => [stored, kind as Kind]),
);

const WORDS: Vocabulary<Kind> = {
	stored: (kind) => STORED[kind],
	kindOf: (customType) => KINDS[customType],
	record: 'note',
	run: 'run',
	checkpoint: 'checkpoint',
	// A checkpoint of another shape is one this reader does not fold.
	accepts: (kind, body) =>
		kind !== 'checkpoint' || (typeof body === 'object' && body !== null && 'v' in body),
};

let names = 0;
const repo = new InMemorySessionRepo();

/** One journal over a session of its own, or over one a name already opened. */
async function open(
	id = `journal-${++names}`,
	run?: string,
	hear?: (entry: Entry<Bodies[Kind]>) => void,
	lost?: () => void,
): Promise<Journal<Kind, Bodies, 'note', Drafts>> {
	const journal = new Journal<Kind, Bodies, 'note', Drafts>(session(id), WORDS, hear, run, lost);
	await journal.ready;
	return journal;
}

async function session(id: string): Promise<PiSession> {
	const known = (await repo.list()).find((metadata) => metadata.id === id);
	return known ? repo.open(known) : repo.create({ id });
}

const note = (text: string) => ({ text });

describe('a journal', () => {
	it('gives every entry the next seq, from one counter', async () => {
		const journal = await open();
		const first = await journal.commit({ draft: note('one') });
		expect('body' in first && first.body.seq).toBe(1);
		await journal.write('mark', { label: 'a' });
		const second = await journal.commit({ draft: note('two') });
		// The mark took seq 2, so the next note takes 3: one counter gives
		// them out, and the record a reader reads is no longer contiguous.
		expect('body' in second && second.body.seq).toBe(3);
		const mark = journal.entries.find((entry) => entry.kind === 'mark');
		expect(mark?.seq).toBe(2);
		expect(journal.lastSeq).toBe(3);
		// Rule 5 reads the record alone, so a mark moves neither what an
		// author read nor what they missed.
		expect(journal.lastCommitted).toBe(3);
	});

	it('lands a repeated key once, and hands back what the first commit wrote', async () => {
		const journal = await open();
		const first = await journal.commit({ key: 'k', draft: note('once') });
		const again = await journal.commit({ key: 'k', draft: note('twice') });
		if (!('body' in first) || !('body' in again)) throw new Error('both commits land');
		expect(again.repeated).toBe(true);
		expect(again.body).toEqual(first.body);
		expect(journal.record).toHaveLength(1);
		expect(journal.lastSeq).toBe(1);
	});

	it('refuses a commit the record moved past, and hands back what it missed', async () => {
		const journal = await open();
		await journal.commit({ draft: note('one') });
		await journal.commit({ draft: note('two') });
		const late = await journal.commit({ readThrough: 1, draft: note('late') });
		expect('missed' in late && late.missed.map((body) => body.seq)).toEqual([2]);
		// the refused commit took no seq
		expect(journal.lastSeq).toBe(2);
	});

	it('reads only what followed a cursor', async () => {
		const journal = await open();
		await journal.commit({ draft: note('one') });
		await journal.commit({ draft: note('two') });
		await journal.commit({ draft: note('three') });
		expect(journal.since(1).map((body) => body.text)).toEqual(['two', 'three']);
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
	it('skips a stored entry of a kind this reader does not know', async () => {
		const id = `journal-unknown-${++names}`;
		const piSession = await session(id);
		await piSession.appendCustomEntry('other/thing', { seq: 1, text: 'not ours' });
		const journal = await open(id);
		expect(journal.entries).toEqual([]);
		expect(journal.lastSeq).toBe(0);
	});

	it('skips a body the vocabulary turns down', async () => {
		const id = `journal-refused-${++names}`;
		const piSession = await session(id);
		// a checkpoint of a shape this reader does not fold
		await piSession.appendCustomEntry(STORED.checkpoint, { seq: 1, shape: 'other' });
		await piSession.appendCustomEntry(STORED.checkpoint, { seq: 2, v: 1, floor: 0 });
		const journal = await open(id);
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['checkpoint']);
	});

	it('skips an entry that took no place on the record', async () => {
		const id = `journal-position-${++names}`;
		const piSession = await session(id);
		// neither took a place: a seq that is not one, and none at all
		await piSession.appendCustomEntry(STORED.note, { seq: 'first', text: 'no place' });
		await piSession.appendCustomEntry(STORED.mark, { label: 'nowhere' });
		await piSession.appendCustomEntry(STORED.note, { seq: 1, text: 'placed' });
		const journal = await open(id);
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['note']);
		expect(journal.record.map((body) => body.text)).toEqual(['placed']);
	});
});

describe('a checkpoint', () => {
	it('replaces every entry before it, and keeps every record entry', async () => {
		const journal = await open();
		await journal.commit({ draft: note('one') });
		await journal.write('mark', { label: 'a' });
		await journal.write('mark', { label: 'b' });
		expect(journal.sinceCheckpoint).toBe(2);
		await journal.write('checkpoint', { v: 1, floor: 1 });
		// the marks are gone, the note stays, and the count starts again
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['note', 'checkpoint']);
		expect(journal.record.map((body) => body.text)).toEqual(['one']);
		expect(journal.sinceCheckpoint).toBe(0);
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
		expect(second.record.map((body) => body.text)).toEqual(['mine']);
	});
});

describe('the envelope', () => {
	it('refuses to acknowledge a write its own vocabulary turns down', async () => {
		// A vocabulary that turns down what the caller drafts: the storage would
		// hold the entry and the cache never would, so the next note would take a
		// seq this one already took. The journal says so rather than acknowledging.
		const strict: Vocabulary<Kind> = { ...WORDS, accepts: (kind) => kind !== 'mark' };
		const journal = new Journal<Kind, Bodies, 'note', Drafts>(
			session(`journal-strict-${++names}`),
			strict,
		);
		await journal.ready;
		await expect(journal.write('mark', { label: 'turned down' })).rejects.toThrow(
			/turns down 'test\/mark'/,
		);
		// nothing joined the cache, and the count the checkpoint reads is untouched
		expect(journal.entries).toEqual([]);
		expect(journal.sinceCheckpoint).toBe(0);
	});
});
