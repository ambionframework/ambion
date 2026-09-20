/** The storage contract is independent of any journal vocabulary or Pi session. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { storageConformance } from '../src/conformance.ts';
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

describe.each(backends)('$name JournalStorage', (backend) => {
	for (const c of storageConformance(backend)) it(c.name, c.run);
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
});
