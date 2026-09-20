/**
 * The cases every `JournalStorage` must pass. A case is a name and a `run`
 * that throws when the storage breaks the contract. The suite needs no test
 * framework: a runner names each case and awaits it.
 *
 * ```ts
 * describe.each(backends)('$name', (backend) => {
 * 	for (const c of storageConformance(backend)) it(c.name, c.run);
 * });
 * ```
 */
import { Journal, type Vocabulary } from './journal.ts';
import { type JournalOpener, namespaced, type StoredEntry } from './storage.ts';

/** One case a test runner names and awaits. It throws on failure. */
export interface ConformanceCase {
	readonly name: string;
	run(): Promise<void>;
}

/** The storage a case writes to, and how the case releases it. */
export interface OpenedBackend {
	readonly opener: JournalOpener;
	dispose?(): void | Promise<void>;
}

/** A storage under test. `open` runs inside every case, so a workerd harness may bind it to the object's state. */
export interface StorageBackend {
	/**
	 * The storage a case writes to. The same storage may come back every
	 * time: a case mints its own journal names and reads back only what it
	 * wrote.
	 */
	open(): Promise<OpenedBackend> | OpenedBackend;
}

type Kind = 'note' | 'run';
type Bodies = { note: { text: string }; run: { owner: string } };

const words: Vocabulary<Kind> = {
	run: 'run',
	accepts: (kind): kind is Kind => kind === 'note' || kind === 'run',
};

const note = (text: string) => ({ text });

function check(condition: boolean, what: string): void {
	if (!condition) throw new Error(what);
}

function sorted(item: unknown): unknown {
	if (item === null || typeof item !== 'object') return item;
	if (Array.isArray(item)) return item.map(sorted);
	return Object.fromEntries(
		Object.entries(item as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, value]) => [key, sorted(value)]),
	);
}

const canonical = (value: unknown): string => JSON.stringify(sorted(value));

function same(actual: unknown, expected: unknown, what: string): void {
	const left = canonical(actual);
	const right = canonical(expected);
	if (left !== right) throw new Error(`${what}: expected ${right}, got ${left}`);
}

async function journalOver(
	opener: JournalOpener,
	name: string,
	run?: string,
	lost?: () => void,
): Promise<Journal<Kind, Bodies>> {
	const opened = new Journal<Kind, Bodies>(opener.open(name), words, undefined, run, lost);
	await opened.ready;
	return opened;
}

const texts = (journal: Journal<Kind, Bodies>): (string | undefined)[] =>
	journal.entries.map((entry) => (entry.kind === 'note' ? entry.body.text : undefined));

const landed = (stored: StoredEntry | undefined): StoredEntry => {
	if (stored === undefined) throw new Error('the append lands');
	return stored;
};

async function failure(action: () => Promise<unknown>): Promise<string> {
	try {
		await action();
		return '';
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

const JSON_VALUES: readonly unknown[] = [
	{ nested: { list: [1, [2, { deep: null }]], empty: {}, none: [] } },
	{ blank: '', zero: 0, negative: -1.5, big: Number.MAX_SAFE_INTEGER, flag: false, nothing: null },
	{ big: 'x'.repeat(64 * 1024) },
	{ text: 'a \u{1F600} b \u{10FFFF} é 中' },
	{},
	[],
];

type Body = (opener: JournalOpener, fresh: () => string) => Promise<void>;

const cases: readonly (readonly [string, Body])[] = [
	[
		'reads an empty journal as no entries at the position it read after',
		async (opener, fresh) => {
			const storage = await opener.open(fresh());
			same(await storage.read(0), { entries: [], position: 0 }, 'read(0)');
			same(await storage.read(7), { entries: [], position: 7 }, 'read(7)');
		},
	],
	[
		'appends at the expected position only, and a mismatch writes nothing',
		async (opener, fresh) => {
			const storage = await opener.open(fresh());
			same(await storage.append({ n: 1 }, 0), { position: 1, entry: { n: 1 } }, 'first append');
			check((await storage.append({ n: 2 }, 0)) === undefined, 'a stale position lands');
			check((await storage.append({ n: 3 }, 5)) === undefined, 'a future position lands');
			same(
				await storage.read(0),
				{ entries: [{ position: 1, entry: { n: 1 } }], position: 1 },
				'the journal after mismatches',
			);
		},
	],
	[
		'lands exactly one of eight appends racing at one position',
		async (opener, fresh) => {
			const name = fresh();
			const handles = await Promise.all(Array.from({ length: 8 }, () => opener.open(name)));
			const results = await Promise.all(
				handles.map((handle, index) => handle.append({ writer: index }, 0)),
			);
			const won = results.filter((result) => result !== undefined);
			check(won.length === 1, `${won.length} appends landed at one position`);
			check(won[0]?.position === 1, 'the winner is not at position 1');
			for (const handle of handles) {
				same(await handle.read(0), { entries: won, position: 1 }, 'a handle after the race');
			}
		},
	],
	[
		'orders one journal across independently opened handles',
		async (opener, fresh) => {
			const name = fresh();
			const first = await opener.open(name);
			const second = await opener.open(name);
			const [left, right] = await Promise.all([
				first.append({ writer: 'first' }, 0),
				second.append({ writer: 'second' }, 0),
			]);
			const one = landed(left ?? right);
			check([left, right].filter((entry) => entry !== undefined).length === 1, 'one lands');
			const seen = await second.read(0);
			same(seen, { entries: [one], position: 1 }, 'the second handle');
			const two = await second.append({ writer: 'second' }, seen.position);
			same(two, { position: 2, entry: { writer: 'second' } }, 'the next append');
			same(await first.read(0), { entries: [one, two], position: 2 }, 'the first handle');
		},
	],
	[
		'reports a read past the head at the position it read after',
		async (opener, fresh) => {
			const storage = await opener.open(fresh());
			await storage.append({ n: 1 }, 0);
			await storage.append({ n: 2 }, 1);
			same(await storage.read(5), { entries: [], position: 5 }, 'read(5)');
			same(
				await storage.read(1),
				{ entries: [{ position: 2, entry: { n: 2 } }], position: 2 },
				'read(1)',
			);
		},
	],
	[
		'owns append and read snapshots',
		async (opener, fresh) => {
			const storage = await opener.open(fresh());
			const entry = { nested: { value: 'before' } };
			const stored = landed(await storage.append(entry, 0));
			entry.nested.value = 'caller changed it';
			(stored.entry as { nested: { value: string } }).nested.value = 'returned value changed';
			const first = landed((await storage.read(0)).entries[0]);
			(first.entry as { nested: { value: string } }).nested.value = 'reader changed it';
			same(
				await storage.read(0),
				{ entries: [{ position: 1, entry: { nested: { value: 'before' } } }], position: 1 },
				'the journal after caller changes',
			);
		},
	],
	[
		'keeps JSON as it was written',
		async (opener, fresh) => {
			const storage = await opener.open(fresh());
			let position = 0;
			for (const value of JSON_VALUES) {
				position = landed(await storage.append(value, position)).position;
			}
			const read = await storage.read(0);
			check(read.entries.length === JSON_VALUES.length, 'an entry is missing');
			read.entries.forEach((stored, index) => {
				same(stored.entry, JSON_VALUES[index], `entry ${index + 1}`);
			});
		},
	],
	[
		'separates journals by name, including the names namespaced() builds',
		async (opener, fresh) => {
			const name = fresh();
			const plain = await opener.open(name);
			const other = await opener.open(fresh());
			const spaced = await namespaced(opener, 'ns').open(name);
			const empty = { entries: [], position: 0 };
			same(await plain.read(0), empty, 'a new journal');
			same(await other.read(0), empty, 'another new journal');
			same(await spaced.read(0), empty, 'a new namespaced journal');
			await plain.append({ in: 'name' }, 0);
			await spaced.append({ in: 'namespaced' }, 0);
			same(await other.read(0), empty, 'the other journal');
			same(
				(await plain.read(0)).entries.map((stored) => stored.entry),
				[{ in: 'name' }],
				'the journal by name',
			);
			same(
				(await spaced.read(0)).entries.map((stored) => stored.entry),
				[{ in: 'namespaced' }],
				'the namespaced journal',
			);
		},
	],
	[
		'keeps one keyed entry after an append confirmation is lost',
		async (opener, fresh) => {
			const storage = await opener.open(fresh());
			let lost = true;
			const uncertain = {
				read: storage.read.bind(storage),
				async append(entry: unknown, expected: number) {
					const stored = await storage.append(entry, expected);
					if (lost) {
						lost = false;
						throw new Error('confirmation lost');
					}
					return stored;
				},
			};
			const writer = new Journal<Kind, Bodies>(Promise.resolve(uncertain), words);
			await writer.ready;
			const message = await failure(() =>
				writer.append('note', { key: 'once', decide: () => ({ body: note('landed') }) }),
			);
			check(/confirmation lost/.test(message), 'the lost confirmation did not surface');
			await writer.settled();
			const retry = await writer.append('note', {
				key: 'once',
				decide: () => ({ body: note('duplicate') }),
			});
			check('entry' in retry && retry.entry.seq === 1, 'the retry did not return the first entry');
			same((await storage.read(0)).entries.length, 1, 'stored entries');
			same(texts(writer), ['landed'], 'the journal text');
		},
	],
	[
		'supersedes a run after another run takes its fence',
		async (opener, fresh) => {
			const name = fresh();
			let lost = 0;
			const first = await journalOver(opener, name, 'first', () => {
				lost += 1;
			});
			await first.append('run', { decide: () => ({ body: { owner: 'first' } }) });
			await first.append('note', { decide: () => ({ body: note('before') }) });
			const second = await journalOver(opener, name, 'second');
			await second.append('run', { decide: () => ({ body: { owner: 'second' } }) });
			const message = await failure(() =>
				first.append('note', { decide: () => ({ body: note('after') }) }),
			);
			check(/superseded/.test(message), 'the first run was not superseded');
			same(lost, 1, 'lost callbacks');
			same(
				texts(second).filter((text) => text !== undefined),
				['before'],
				'notes',
			);
		},
	],
	[
		'keeps keyed entries through a replay and reopen',
		async (opener, fresh) => {
			const name = fresh();
			const first = await journalOver(opener, name);
			await first.append('note', { key: 'once', decide: () => ({ body: note('before') }) });
			const resumed = await journalOver(opener, name);
			const retry = await resumed.append('note', {
				key: 'once',
				decide: () => ({ body: note('duplicate') }),
			});
			check('entry' in retry && retry.entry.seq === 1, 'the retry did not return the first entry');
			same(texts(resumed), ['before'], 'the reopened journal');
		},
	],
];

/** The cases every `JournalStorage` must pass. The order is stable and the names are the contract. */
export function storageConformance(backend: StorageBackend): readonly ConformanceCase[] {
	const suite = Math.random().toString(36).slice(2);
	let count = 0;
	const fresh = () => {
		count += 1;
		return `${suite}-${count}`;
	};
	return cases.map(([name, body]) => ({
		name,
		async run() {
			const opened = await backend.open();
			try {
				await body(opened.opener, fresh);
			} finally {
				await opened.dispose?.();
			}
		},
	}));
}
