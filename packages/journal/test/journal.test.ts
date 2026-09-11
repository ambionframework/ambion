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
	after: number;
	label: string;
}
interface Run {
	after: number;
	run: string;
}
interface Checkpoint {
	after: number;
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
	mark: Omit<Mark, 'after'>;
	run: Omit<Run, 'after'>;
	checkpoint: Omit<Checkpoint, 'after'>;
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
	positioned: 'note',
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
	it('gives each positioned entry the next seq, and leaves a row without one', async () => {
		const journal = await open();
		const first = await journal.commit({ draft: note('one') });
		expect('body' in first && first.body.seq).toBe(1);
		await journal.write('mark', { label: 'a' });
		const second = await journal.commit({ draft: note('two') });
		expect('body' in second && second.body.seq).toBe(2);
		// the mark took no seq, and it carries where it landed
		const mark = journal.entries.find((entry) => entry.kind === 'mark');
		expect(mark?.seq).toBeUndefined();
		expect(mark?.after).toBe(1);
		expect(journal.lastSeq).toBe(2);
	});

	it('lands a repeated key once, and hands back what the first commit wrote', async () => {
		const journal = await open();
		const first = await journal.commit({ key: 'k', draft: note('once') });
		const again = await journal.commit({ key: 'k', draft: note('twice') });
		if (!('body' in first) || !('body' in again)) throw new Error('both commits land');
		expect(again.repeated).toBe(true);
		expect(again.body).toEqual(first.body);
		expect(journal.positioned).toHaveLength(1);
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
		await piSession.appendCustomEntry(STORED.checkpoint, { after: 0, shape: 'other' });
		await piSession.appendCustomEntry(STORED.checkpoint, { after: 0, v: 1, floor: 0 });
		const journal = await open(id);
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['checkpoint']);
	});

	it('skips an entry whose position is of the wrong sort, or missing', async () => {
		const id = `journal-position-${++names}`;
		const piSession = await session(id);
		// a note with no seq, and a mark with no after
		await piSession.appendCustomEntry(STORED.note, { text: 'no place' });
		await piSession.appendCustomEntry(STORED.mark, { label: 'nowhere' });
		await piSession.appendCustomEntry(STORED.note, { seq: 1, text: 'placed' });
		const journal = await open(id);
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['note']);
		expect(journal.positioned.map((body) => body.text)).toEqual(['placed']);
	});
});

describe('a checkpoint', () => {
	it('replaces every row before it, and keeps every positioned entry', async () => {
		const journal = await open();
		await journal.commit({ draft: note('one') });
		await journal.write('mark', { label: 'a' });
		await journal.write('mark', { label: 'b' });
		expect(journal.sinceCheckpoint).toBe(2);
		await journal.write('checkpoint', { v: 1, floor: 1 });
		// the marks are gone, the note stays, and the count starts again
		expect(journal.entries.map((entry) => entry.kind)).toEqual(['note', 'checkpoint']);
		expect(journal.positioned.map((body) => body.text)).toEqual(['one']);
		expect(journal.sinceCheckpoint).toBe(0);
	});
});

describe('the fence', () => {
	it('supersedes a run whose row a later run wrote past', async () => {
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
		expect(second.positioned.map((body) => body.text)).toEqual(['mine']);
	});
});
