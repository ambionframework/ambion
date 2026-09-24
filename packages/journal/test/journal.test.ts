/** The journal's queue, recovery, idempotency and writer fence. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type CloneableJournal, type Entry, Journal, type Vocabulary } from '../src/journal.ts';
import { memoryJournals } from '../src/memory.ts';

type Kind = 'note' | 'mark' | 'run';
interface Note {
	text: string;
	nested?: { values: string[] };
}
interface Mark {
	label: string;
}
interface Run {
	owner: string;
}
interface Bodies {
	note: Note;
	mark: Mark;
	run: Run;
}

const known = (kind: string): kind is Kind => kind === 'note' || kind === 'mark' || kind === 'run';

const WORDS: Vocabulary<Kind> = {
	run: 'run',
	accepts: (kind, body): kind is Kind => known(kind) && body !== undefined,
};

let names = 0;
const journals = memoryJournals();

async function open(
	id = `journal-${++names}`,
	run?: string,
	hear?: (entry: Entry<Bodies[Kind]>) => void,
	lost?: () => void,
): Promise<Journal<Kind, Bodies>> {
	const journal = new Journal<Kind, Bodies>(journals.open(id), WORDS, hear, run, lost);
	await journal.ready;
	return journal;
}

const note = (text: string): Note => ({ text });
const body = <T>(value: T) => ({ body: value });

async function store(id: string, entry: unknown): Promise<void> {
	const storage = await journals.open(id);
	const read = await storage.read(0);
	const appended = await storage.append(entry, read.position);
	if (appended === undefined) throw new Error('the raw entry lands');
}

describe('a journal', () => {
	it('gives every kind the next journal seq', async () => {
		const journal = await open();
		expect(await journal.append('note', { decide: () => body(note('one')) })).toMatchObject({
			entry: { seq: 1 },
		});
		await journal.append('mark', { decide: () => body({ label: 'a' }) });
		expect(await journal.append('note', { decide: () => body(note('two')) })).toMatchObject({
			entry: { seq: 3 },
		});
		expect(journal.entries.map((entry) => [entry.kind, entry.seq])).toEqual([
			['note', 1],
			['mark', 2],
			['note', 3],
		]);
		expect(journal.lastSeq).toBe(3);
	});

	it('owns append results, public history, callbacks, and captured drafts', async () => {
		const id = `journal-ownership-${++names}`;
		const storage = await journals.open(id);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const storageEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const delayed = {
			read: storage.read.bind(storage),
			async append(entry: unknown, expected: number) {
				entered();
				await gate;
				return storage.append(entry, expected);
			},
		};
		let heard: Entry<Note> | undefined;
		const journal = new Journal<Kind, Bodies>(Promise.resolve(delayed), WORDS, (entry) => {
			if (entry.kind === 'note') {
				heard = entry;
				entry.body.text = 'callback changed';
				entry.body.nested?.values.push('callback changed');
			}
		});
		await journal.ready;

		const draft = { text: 'before', nested: { values: ['original'] } };
		const intent = {
			key: 'owned',
			decide: () => ({ body: draft }),
		};
		const pending = journal.append('note', intent);
		intent.key = 'changed after append';
		intent.decide = () => ({
			body: { text: 'changed after append', nested: { values: [] } },
		});
		await storageEntered;
		// The draft is changed while storage is awaiting confirmation. The
		// journal must retain the value captured at the decision boundary.
		draft.text = 'caller changed';
		draft.nested.values.push('caller changed');
		release();
		const first = await pending;
		if (!('entry' in first) || first.entry.kind !== 'note') throw new Error('the note lands');
		first.entry.body.text = 'append result changed';
		first.entry.body.nested?.values.push('append result changed');

		const exposed = journal.entries;
		if (exposed[0]?.kind !== 'note') throw new Error('the note is exposed');
		exposed[0].body.text = 'history changed';
		exposed[0].body.nested?.values.push('history changed');
		(exposed as Entry<Bodies[Kind]>[]).push({ kind: 'note', body: note('fake'), seq: 99 });

		const retry = await journal.append('note', {
			key: 'owned',
			decide: () => ({ body: note('decide must not run') }),
		});
		if (!('entry' in retry) || retry.entry.kind !== 'note') throw new Error('the retry lands');
		expect(retry.entry.body).toEqual({ text: 'before', nested: { values: ['original'] } });
		expect(heard?.body.text).toBe('callback changed');
		expect(journal.entries).toHaveLength(1);
		expect(journal.entries[0]?.body).toEqual({ text: 'before', nested: { values: ['original'] } });
		expect(journal.entriesFrom(1)).toEqual([]);
		expect(() => journal.entriesFrom(-1)).toThrow(/non-negative/);
		expect(() => journal.entriesFrom(1.5)).toThrow(/safe integer/);
		expect(journal.lastSeq).toBe(1);
		expect(Reflect.set(journal, 'lastSeq', 99)).toBe(false);
		const beforeNext = journal.entries;
		await journal.append('note', { decide: () => ({ body: note('next') }) });
		expect(beforeNext).toHaveLength(1);
		expect(journal.entriesFrom(1)).toMatchObject([{ seq: 2, body: { text: 'next' } }]);
	});

	it('refuses a body that cannot be cloned, and takes nothing', async () => {
		// The journal copies every body at an ownership boundary, so a body holds
		// data. A body that carries a function cannot be cloned. The append fails
		// at the copy, before storage, so the journal consumes no position.
		const journal = await open();
		const withFunction = { text: 'holds a function', act: () => undefined } as unknown as Note;
		await expect(journal.append('note', { decide: () => body(withFunction) })).rejects.toThrow();
		expect(journal.entries).toHaveLength(0);
		expect(journal.lastSeq).toBe(0);
		expect(await journal.append('note', { decide: () => body(note('after')) })).toMatchObject({
			entry: { seq: 1 },
		});
	});

	it('isolates accepted bodies from a vocabulary that retains and mutates them', async () => {
		const id = `journal-vocabulary-ownership-${++names}`;
		let candidate: Note | undefined;
		const mutatingWords: Vocabulary<Kind> = {
			run: 'run',
			accepts: (kind: string, value: unknown): kind is Kind => {
				if (kind !== 'note') return known(kind);
				if (typeof value !== 'object' || value === null || !('text' in value)) return false;
				candidate = value as Note;
				candidate.text = 'changed by accepts';
				return true;
			},
		};
		const journal = new Journal<Kind, Bodies>(journals.open(id), mutatingWords);
		await journal.ready;
		const result = await journal.append('note', {
			key: 'once',
			decide: () => ({ body: note('before') }),
		});
		if (!('entry' in result) || result.entry.kind !== 'note') throw new Error('the note lands');
		if (candidate === undefined) throw new Error('The vocabulary received no body.');
		candidate.text = 'changed after accepts';
		expect(result.entry.body.text).toBe('before');

		const resumed = new Journal<Kind, Bodies>(journals.open(id), mutatingWords);
		await resumed.ready;
		expect(resumed.entries[0]?.body).toEqual({ text: 'before' });
		const retry = await resumed.append('note', {
			key: 'once',
			decide: () => ({ body: note('must not decide') }),
		});
		if (!('entry' in retry) || retry.entry.kind !== 'note') throw new Error('the retry lands');
		expect(retry.entry.body.text).toBe('before');
	});

	it('returns the original entry for a same-kind key retry, and rejects a key reused by another kind before deciding', async () => {
		const journal = await open();
		const first = await journal.append('note', { key: 'k', decide: () => body(note('once')) });
		expect(await journal.append('note', { key: 'k', decide: () => body(note('twice')) })).toEqual(
			first,
		);
		let decided = false;
		await expect(
			journal.append('mark', {
				key: 'k',
				decide: () => {
					decided = true;
					return body({ label: 'two' });
				},
			}),
		).rejects.toThrow(/key 'k'.*note.*seq 1/);
		expect(decided).toBe(false);
		expect(journal.entries).toHaveLength(1);
	});

	it('returns a caller result without writing', async () => {
		const journal = await open();
		const result = await journal.append<'note', string>('note', {
			key: 'unused',
			decide: () => ({ result: 'stale' }),
		});
		expect(result).toEqual({ result: 'stale' });
		expect(journal.entries).toEqual([]);
		const landed = await journal.append('note', { key: 'unused', decide: () => body(note('now')) });
		expect('entry' in landed && landed.entry.seq).toBe(1);
	});

	it('proves at compile time that every body survives cloning, that a decision is synchronous, and that kind and body stay correlated', async () => {
		// `CloneableJournal` is a journal only when every body is data. A body map
		// that holds a function is not a journal; the type resolves to `never`.
		expectTypeOf<CloneableJournal<Kind, Bodies>>().toEqualTypeOf<Journal<Kind, Bodies>>();
		interface WithFunction {
			note: { act: () => void };
			mark: Mark;
			run: Run;
		}
		expectTypeOf<CloneableJournal<Kind, WithFunction>>().toBeNever();
		const wrongIntent: import('../src/journal.ts').AppendIntent<Mark, never> = {
			// @ts-expect-error a mark cannot carry a note body
			decide: () => body(note('wrong')),
		};
		expect(wrongIntent.decide).toBeTypeOf('function');
		const asyncIntent: import('../src/journal.ts').AppendIntent<Note, never> = {
			// @ts-expect-error a decision cannot be asynchronous
			decide: async () => body(note('later')),
		};
		expect(asyncIntent.decide).toBeTypeOf('function');
		const journal = await open();
		for (const kind of ['note', 'mark'] as const) {
			const result = await journal.append(kind, {
				decide: () => (kind === 'note' ? body(note('one')) : body({ label: 'one' })),
			});
			if ('entry' in result && result.entry.kind === 'note')
				expectTypeOf(result.entry.body).toEqualTypeOf<Note>();
		}
	});

	it('allows an explicitly undefined body when that kind accepts it', async () => {
		type EmptyKind = 'empty' | 'run';
		type EmptyBodies = { empty: undefined; run: Run };
		const words: Vocabulary<EmptyKind> = {
			run: 'run',
			accepts: (kind): kind is EmptyKind => kind === 'empty' || kind === 'run',
		};
		const journal = new Journal<EmptyKind, EmptyBodies>(
			journals.open(`journal-empty-${++names}`),
			words,
		);
		await journal.ready;
		await expect(
			journal.append('empty', {
				// @ts-expect-error JavaScript callers must also return a synchronous decision.
				decide: async () => body(undefined),
			}),
		).rejects.toThrow(/decision must return/);
		await expect(
			journal.append('empty', {
				// @ts-expect-error A missing decision is distinct from an explicit undefined body.
				decide: () => ({}),
			}),
		).rejects.toThrow(/decision must return/);
		expect(journal.entries).toEqual([]);
		const result = await journal.append('empty', { decide: () => body(undefined) });
		expect(result).toEqual({ entry: { kind: 'empty', body: undefined, seq: 1 } });
	});

	it('evaluates the decision after recovery and in queue order', async () => {
		const journal = await open();
		const seen: number[] = [];
		const first = journal.append('note', {
			decide: () => {
				seen.push(journal.lastSeq);
				return body(note('one'));
			},
		});
		const second = journal.append('mark', {
			decide: () => {
				seen.push(journal.lastSeq);
				return body({ label: 'two' });
			},
		});
		await Promise.all([first, second]);
		expect(seen).toEqual([0, 1]);
	});

	it('hears entries after replay, including entries from another run', async () => {
		const id = `journal-heard-${++names}`;
		const first = await open(id);
		await first.append('note', { decide: () => body(note('before')) });
		const heard: string[] = [];
		const second = await open(id, undefined, (entry) => heard.push(entry.kind));
		expect(heard).toEqual([]);
		await second.append('note', { decide: () => body(note('after')) });
		await second.append('mark', { decide: () => body({ label: 'a' }) });
		expect(heard).toEqual(['note', 'mark']);
	});
});

describe('the envelope and storage cursor', () => {
	it('keeps storage positions distinct from accepted journal seqs', async () => {
		const id = `journal-position-${++names}`;
		await store(id, null);
		await store(id, { kind: 'other', body: { ignored: true }, seq: 400 });
		await store(id, { kind: 'note', body: note('placed'), seq: 7 });
		const journal = await open(id);
		expect(journal.entries.map((entry) => [entry.seq, entry.body])).toEqual([[7, note('placed')]]);
		const next = await journal.append('note', { decide: () => body(note('next')) });
		expect('entry' in next && next.entry.seq).toBe(8);
	});

	it('keeps envelope fields separate from body fields', async () => {
		const id = `journal-envelope-${++names}`;
		const journal = await open(id, 'run-1');
		const own = { text: 'mine', seq: 99, key: 'stolen', run: 'ghost' };
		expect(await journal.append('note', { decide: () => body(own) })).toEqual({
			entry: { kind: 'note', body: own, seq: 1, run: 'run-1' },
		});
		const other = await journal.append('note', {
			key: 'stolen',
			decide: () => body(note('other')),
		});
		expect('entry' in other && other.entry.seq).toBe(2);
	});

	const strict: Vocabulary<Kind> = {
		run: 'run',
		accepts: (kind, value): kind is Kind => {
			if (!known(kind)) return false;
			if (kind === 'note' && typeof value === 'object' && value !== null && 'text' in value)
				return true;
			throw new Error(`malformed ${kind}`);
		},
	};

	it.each([
		{
			what: 'body',
			words: strict,
			stored: { kind: 'note', body: { wrong: true }, seq: 1 },
			error: /malformed note/,
		},
		{
			what: 'seq',
			words: WORDS,
			stored: { kind: 'note', body: note('x'), seq: 'one' },
			error: /no valid seq/,
		},
		{
			what: 'missing seq',
			words: WORDS,
			stored: { kind: 'note', body: note('x') },
			error: /no valid seq/,
		},
		{
			what: 'seq past the last place',
			words: WORDS,
			stored: { kind: 'note', body: note('x'), seq: Number.MAX_SAFE_INTEGER },
			error: /no valid seq/,
		},
	])(
		'fails repeatedly at a known entry with a malformed $what, without advancing the cursor',
		async ({ words, stored, error }) => {
			const id = `journal-malformed-${++names}`;
			await store(id, stored);
			const journal = new Journal<Kind, Bodies>(journals.open(id), words);
			await expect(journal.ready).rejects.toThrow(error);
			await expect(journal.append('note', { decide: () => body(note('later')) })).rejects.toThrow(
				error,
			);
		},
	);

	it('keeps every seq below the largest safe integer, so its successor is exact', async () => {
		const full = `journal-full-${++names}`;
		await store(full, {
			kind: 'note',
			body: note('the last place'),
			seq: Number.MAX_SAFE_INTEGER - 1,
		});
		const last = await open(full);
		expect(last.lastSeq).toBe(Number.MAX_SAFE_INTEGER - 1);
		await expect(last.append('note', { decide: () => body(note('one more')) })).rejects.toThrow(
			/is full/,
		);
	});

	it('does not append a proposal the vocabulary rejects', async () => {
		const strict: Vocabulary<Kind> = {
			run: 'run',
			accepts: (kind, value): kind is Kind => known(kind) && kind !== 'mark' && value !== undefined,
		};
		const journal = new Journal<Kind, Bodies>(journals.open(`journal-strict-${++names}`), strict);
		await journal.ready;
		await expect(journal.append('mark', { decide: () => body({ label: 'bad' }) })).rejects.toThrow(
			/rejects the proposed/,
		);
		expect(journal.entries).toEqual([]);
	});

	it('does not replay an entry when its reaction throws after the cursor advances', async () => {
		const id = `journal-hear-failure-${++names}`;
		const storage = await journals.open(id);
		let throws = true;
		const heard: string[] = [];
		const journal = new Journal<Kind, Bodies>(Promise.resolve(storage), WORDS, (entry) => {
			heard.push(entry.kind);
			if (throws) {
				throws = false;
				throw new Error('reaction failed');
			}
		});
		await journal.ready;
		await store(id, { kind: 'note', body: note('outside'), seq: 1 });
		await expect(journal.append('note', { decide: () => body(note('blocked')) })).rejects.toThrow(
			/reaction failed/,
		);
		await journal.append('note', { decide: () => body(note('after')) });
		expect(heard).toEqual(['note', 'note']);
		expect(journal.entries.map((entry) => entry.body)).toEqual([note('outside'), note('after')]);
	});
});

describe('the writer fence and uncertain append', () => {
	it('supersedes an earlier run after a later run writes its fence', async () => {
		const id = `journal-fence-${++names}`;
		let lost = 0;
		const first = await open(id, 'run-1', undefined, () => {
			lost += 1;
		});
		await first.append('run', { key: 'fence', decide: () => body({ owner: 'run-1' }) });
		await first.append('note', { decide: () => body(note('mine')) });
		const second = await open(id, 'run-2');
		await expect(
			second.append('run', { key: 'fence', decide: () => body({ owner: 'run-2' }) }),
		).rejects.toThrow(/key 'fence'/);
		await second.append('run', { decide: () => body({ owner: 'run-2' }) });
		await expect(first.append('note', { decide: () => body(note('late')) })).rejects.toThrow(
			/superseded/,
		);
		expect(lost).toBe(1);
	});

	it('refuses a stamped write before the run has its own fence, so nothing it acknowledges is void', async () => {
		const id = `journal-early-${++names}`;
		const first = await open(id, 'run-1');
		await first.append('run', { decide: () => body({ owner: 'run-1' }) });
		const second = await open(id, 'run-2');
		await expect(second.append('note', { decide: () => body(note('early')) })).rejects.toThrow(
			/run entry first/,
		);
		await second.append('run', { decide: () => body({ owner: 'run-2' }) });
		const landed = await second.append('note', { decide: () => body(note('after')) });
		expect(landed).toMatchObject({ entry: { seq: 3 } });
		// Every stored entry is one a fresh reader takes: the storage holds nothing void.
		const reader = await open(id);
		expect(reader.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
	});

	it('never fences a journal that writes for no run, whatever run entries it reads', async () => {
		const id = `journal-reader-${++names}`;
		let lost = 0;
		const writerless = await open(id, undefined, undefined, () => {
			lost += 1;
		});
		await writerless.append('run', { decide: () => body({ owner: 'nobody' }) });
		const first = await open(id, 'run-1');
		await first.append('run', { decide: () => body({ owner: 'run-1' }) });
		const reader = await open(id, undefined, undefined, () => {
			lost += 1;
		});
		expect(reader.entries.map((entry) => entry.seq)).toEqual([1, 2]);
		expect(await reader.append('note', { decide: () => body(note('still writes')) })).toMatchObject(
			{ entry: { seq: 3 } },
		);
		expect(lost).toBe(0);
	});

	it('recovers a successful append whose confirmation was lost', async () => {
		const id = `journal-doubt-${++names}`;
		const storage = await journals.open(id);
		let lose = true;
		const uncertain = {
			read: storage.read.bind(storage),
			async append(entry: unknown, expected: number) {
				const landed = await storage.append(entry, expected);
				if (lose) {
					lose = false;
					throw new Error('confirmation lost');
				}
				return landed;
			},
		};
		const journal = new Journal<Kind, Bodies>(Promise.resolve(uncertain), WORDS);
		await journal.ready;
		await expect(
			journal.append('note', { key: 'once', decide: () => body(note('landed')) }),
		).rejects.toThrow(/confirmation lost/);
		await journal.settled();
		const retry = await journal.append('note', {
			key: 'once',
			decide: () => body(note('duplicate')),
		});
		expect(retry).toMatchObject({ entry: { seq: 1, body: { text: 'landed' } } });
	});
});
