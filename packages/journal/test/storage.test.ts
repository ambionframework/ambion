/** The storage contract is independent of any journal vocabulary or Pi session. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Journal, type Vocabulary } from '../src/journal.ts';
import { memoryJournals } from '../src/memory.ts';
import { type Sql, type SqlValue, sqliteJournals } from '../src/sqlite.ts';
import type { JournalOpener } from '../src/storage.ts';

type Kind = 'note' | 'run';
type Bodies = {
	note: { text: string; nested?: { values: string[] } };
	run: { owner: string };
};

const words: Vocabulary<Kind> = {
	run: 'run',
	accepts: (kind): kind is Kind => kind === 'note' || kind === 'run',
};

const note = (text: string) => ({ text });

async function journal(
	opener: JournalOpener,
	name: string,
	run?: string,
	lost?: () => void,
	hear?: (entry: import('../src/journal.ts').Entries<Kind, Bodies>) => void,
): Promise<Journal<Kind, Bodies>> {
	const opened = new Journal<Kind, Bodies>(opener.open(name), words, hear, run, lost);
	await opened.ready;
	return opened;
}

const sqlOver = (database: DatabaseSync): Sql => ({
	run: (query, ...params) => {
		database.prepare(query).run(...params);
	},
	all: (query, ...params) => database.prepare(query).all(...params) as Record<string, SqlValue>[],
});

interface Opened {
	readonly opener: JournalOpener;
	dispose(): void;
}

const backends: readonly { name: string; open(): Opened }[] = [
	{ name: 'memory', open: () => ({ opener: memoryJournals(), dispose: () => {} }) },
	{
		name: 'native SQLite',
		open: () => {
			const database = new DatabaseSync(':memory:');
			return { opener: sqliteJournals(sqlOver(database)), dispose: () => database.close() };
		},
	},
];

describe.each(backends)('$name JournalStorage', ({ open }) => {
	it('orders one journal across independently opened handles and conditionally appends once', async () => {
		const backend = open();
		try {
			const first = await backend.opener.open('shared');
			const second = await backend.opener.open('shared');
			const [left, right] = await Promise.all([
				first.append({ writer: 'first' }, 0),
				second.append({ writer: 'second' }, 0),
			]);
			const one = left ?? right;
			expect(one).toEqual(expect.objectContaining({ position: 1 }));
			expect([left, right].filter((entry) => entry !== undefined)).toHaveLength(1);
			const seen = await second.read(0);
			expect(seen).toEqual({ entries: [one], position: 1 });
			const two = await second.append({ writer: 'second' }, seen.position);
			expect(two).toEqual({ position: 2, entry: { writer: 'second' } });
			expect(await first.read(0)).toEqual({ entries: [one, two], position: 2 });
		} finally {
			backend.dispose();
		}
	});

	it('owns append and read snapshots', async () => {
		const backend = open();
		try {
			const storage = await backend.opener.open('snapshots');
			const entry = { nested: { value: 'before' } };
			const landed = await storage.append(entry, 0);
			if (landed === undefined) throw new Error('the entry lands');
			entry.nested.value = 'caller changed it';
			(landed.entry as { nested: { value: string } }).nested.value = 'returned value changed';

			const first = await storage.read(0);
			const firstEntry = first.entries[0];
			if (firstEntry === undefined) throw new Error('the entry reads');
			(firstEntry.entry as { nested: { value: string } }).nested.value = 'reader changed it';
			const again = await storage.read(0);
			expect(again).toEqual({
				entries: [{ position: 1, entry: { nested: { value: 'before' } } }],
				position: 1,
			});
		} finally {
			backend.dispose();
		}
	});
});

describe.each(backends)('$name Journal contract', ({ open }) => {
	it('detaches append, history, callback, duplicate, and replay values', async () => {
		const backend = open();
		try {
			let heard: import('../src/journal.ts').Entries<Kind, Bodies> | undefined;
			const first = await journal(backend.opener, 'ownership', undefined, undefined, (entry) => {
				heard = entry;
				if (entry.kind === 'note') entry.body.nested?.values.push('callback mutation');
			});
			const draft = { text: 'before', nested: { values: ['original'] } };
			const written = await first.append('note', {
				key: 'once',
				decide: () => ({ body: draft }),
			});
			if (!('entry' in written) || written.entry.kind !== 'note') throw new Error('the note lands');
			written.entry.body.text = 'append mutation';
			written.entry.body.nested?.values.push('append mutation');
			const exposed = first.entries;
			if (exposed[0]?.kind !== 'note') throw new Error('the note reads');
			exposed[0].body.text = 'history mutation';
			exposed[0].body.nested?.values.push('history mutation');
			(exposed as import('../src/journal.ts').Entries<Kind, Bodies>[]).pop();
			if (heard?.kind === 'note') heard.body.text = 'retained callback mutation';

			const resumed = await journal(backend.opener, 'ownership');
			const replay = resumed.entries;
			if (replay[0]?.kind === 'note') replay[0].body.nested?.values.push('replay mutation');
			const retry = await resumed.append('note', {
				key: 'once',
				decide: () => ({ body: { text: 'must not decide' } }),
			});
			if (!('entry' in retry) || retry.entry.kind !== 'note') throw new Error('the retry lands');
			expect(retry.entry.body).toEqual({ text: 'before', nested: { values: ['original'] } });
			retry.entry.body.nested?.values.push('duplicate result mutation');
			expect(resumed.entries).toEqual([
				{
					kind: 'note',
					body: { text: 'before', nested: { values: ['original'] } },
					seq: 1,
					key: 'once',
				},
			]);
			expect((await (await backend.opener.open('ownership')).read(0)).entries[0]?.entry).toEqual({
				kind: 'note',
				body: { text: 'before', nested: { values: ['original'] } },
				seq: 1,
				key: 'once',
			});
			expect(resumed.lastSeq).toBe(1);
		} finally {
			backend.dispose();
		}
	});

	it('keeps one keyed entry after an append confirmation is lost', async () => {
		const backend = open();
		try {
			const storage = await backend.opener.open('lost-confirmation');
			let lost = true;
			const uncertain = {
				read: storage.read.bind(storage),
				async append(entry: unknown, expected: number) {
					const landed = await storage.append(entry, expected);
					if (lost) {
						lost = false;
						throw new Error('confirmation lost');
					}
					return landed;
				},
			};
			const writer = new Journal<Kind, Bodies>(Promise.resolve(uncertain), words);
			await writer.ready;
			await expect(
				writer.append('note', { key: 'once', decide: () => ({ body: note('landed') }) }),
			).rejects.toThrow(/confirmation lost/);
			await writer.settled();
			const retry = await writer.append('note', {
				key: 'once',
				decide: () => ({ body: note('duplicate') }),
			});
			expect(retry).toMatchObject({ entry: { seq: 1, body: { text: 'landed' } } });
			expect((await storage.read(0)).entries).toHaveLength(1);
		} finally {
			backend.dispose();
		}
	});

	it('supersedes a run after another run takes its fence', async () => {
		const backend = open();
		try {
			let lost = 0;
			const first = await journal(backend.opener, 'fence', 'first', () => {
				lost += 1;
			});
			await first.append('run', { decide: () => ({ body: { owner: 'first' } }) });
			await first.append('note', { decide: () => ({ body: note('before') }) });
			const second = await journal(backend.opener, 'fence', 'second');
			await second.append('run', { decide: () => ({ body: { owner: 'second' } }) });
			await expect(
				first.append('note', { decide: () => ({ body: note('after') }) }),
			).rejects.toThrow(/superseded/);
			expect(lost).toBe(1);
			expect(
				second.entries
					.filter((entry) => entry.kind === 'note')
					.map((entry) => (entry.kind === 'note' ? entry.body.text : undefined)),
			).toEqual(['before']);
		} finally {
			backend.dispose();
		}
	});

	it('keeps keyed entries through a replay and reopen', async () => {
		const backend = open();
		try {
			const first = await journal(backend.opener, 'reopen');
			await first.append('note', { key: 'once', decide: () => ({ body: note('before') }) });
			const resumed = await journal(backend.opener, 'reopen');
			const retry = await resumed.append('note', {
				key: 'once',
				decide: () => ({ body: note('duplicate') }),
			});
			expect(retry).toMatchObject({ entry: { seq: 1, body: { text: 'before' } } });
			expect(
				resumed.entries.map((entry) => (entry.kind === 'note' ? entry.body.text : undefined)),
			).toEqual(['before']);
		} finally {
			backend.dispose();
		}
	});
});
