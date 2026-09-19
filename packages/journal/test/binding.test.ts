/**
 * The binding between the verified rules and the code that runs them. A
 * proof is about a rule's body; it reaches the journal only when the
 * journal runs that body on the path the contract describes. Each case
 * replaces one rule with a sentinel answer and checks that the caller
 * follows it. A caller that computed the decision by hand would pass its
 * own tests and fail here.
 */
import { describe, expect, it, vi } from 'vitest';
import { Journal, type Vocabulary } from '../src/journal.ts';
import { memoryJournals } from '../src/memory.ts';
import * as rules from '../src/rules.verified.ts';

vi.mock('../src/rules.verified.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/rules.verified.ts')>();
	return {
		...actual,
		fenceStep: vi.fn(actual.fenceStep),
		keyed: vi.fn(actual.keyed),
		writable: vi.fn(actual.writable),
		advanceSeq: vi.fn(actual.advanceSeq),
		scanned: vi.fn(actual.scanned),
		admit: vi.fn(actual.admit),
		readPosition: vi.fn(actual.readPosition),
		nextPosition: vi.fn(actual.nextPosition),
	};
});

type Kind = 'note' | 'run';
type Bodies = { note: { text: string }; run: { owner: string } };
const words: Vocabulary<Kind> = {
	run: 'run',
	accepts: (kind): kind is Kind => kind === 'note' || kind === 'run',
};
const note = (text: string) => ({ body: { text } });

let names = 0;
const journals = memoryJournals();
async function open(run?: string): Promise<Journal<Kind, Bodies>> {
	const journal = new Journal<Kind, Bodies>(
		journals.open(`binding-${++names}`),
		words,
		undefined,
		run,
	);
	await journal.ready;
	return journal;
}

describe('the journal runs the verified rules', () => {
	it('refuses a write when writable says so', async () => {
		const journal = await open('run-1');
		vi.mocked(rules.writable).mockReturnValueOnce(false);
		await expect(journal.append('note', { decide: () => note('a') })).rejects.toThrow(
			/run entry first/,
		);
		expect(await journal.append('note', { decide: () => note('b') })).toMatchObject({
			entry: { seq: 1 },
		});
	});

	it('answers a key the way keyed decides', async () => {
		const journal = await open();
		await journal.append('note', { key: 'k', decide: () => note('first') });
		vi.mocked(rules.keyed).mockReturnValueOnce('conflict');
		await expect(journal.append('note', { key: 'k', decide: () => note('again') })).rejects.toThrow(
			/already names/,
		);
		vi.mocked(rules.keyed).mockReturnValueOnce('fresh');
		// A fresh answer runs the decision and lands a second entry under the key.
		expect(await journal.append('note', { key: 'k', decide: () => note('fresh') })).toMatchObject({
			entry: { seq: 2, body: { text: 'fresh' } },
		});
		expect(await journal.append('note', { key: 'k', decide: () => note('replay') })).toMatchObject({
			entry: { seq: 2, body: { text: 'fresh' } },
		});
	});

	it('keeps or drops an entry as fenceStep answers', async () => {
		const journal = await open();
		vi.mocked(rules.fenceStep).mockReturnValueOnce({
			state: { fence: undefined, fenced: false, superseded: false },
			keep: false,
			lost: false,
		});
		await journal.append('note', { decide: () => note('dropped') });
		expect(journal.entries).toEqual([]);
		await journal.append('note', { decide: () => note('kept') });
		expect(journal.entries.map((entry) => entry.body)).toEqual([{ text: 'kept' }]);
	});

	it('hears lost when fenceStep says the run is superseded', async () => {
		const lost = vi.fn();
		const journal = new Journal<Kind, Bodies>(
			journals.open(`binding-${++names}`),
			words,
			undefined,
			'run-1',
			lost,
		);
		await journal.ready;
		vi.mocked(rules.fenceStep).mockReturnValueOnce({
			state: { fence: 'run-2', fenced: true, superseded: true },
			keep: true,
			lost: true,
		});
		await journal.append('run', { decide: () => ({ body: { owner: 'run-1' } }) });
		expect(lost).toHaveBeenCalledTimes(1);
		await expect(journal.append('note', { decide: () => note('late') })).rejects.toThrow(
			/superseded/,
		);
	});

	it('moves the counter as advanceSeq answers', async () => {
		const journal = await open();
		vi.mocked(rules.advanceSeq).mockReturnValueOnce(41);
		await journal.append('note', { decide: () => note('a') });
		expect(journal.lastSeq).toBe(41);
		expect(await journal.append('note', { decide: () => note('b') })).toMatchObject({
			entry: { seq: 42 },
		});
	});

	it('moves the cursor as scanned answers', async () => {
		const journal = await open();
		await journal.append('note', { decide: () => note('a') });
		// A cursor held at zero expects the head at zero: the storage refuses the moved append.
		vi.mocked(rules.scanned).mockReturnValue(0);
		await expect(journal.append('note', { decide: () => note('b') })).rejects.toThrow(
			/moved under the write/,
		);
		vi.mocked(rules.scanned).mockReset();
		vi.mocked(rules.scanned).mockImplementation((cursor, position) => Math.max(cursor, position));
		await journal.settled();
		expect(await journal.append('note', { decide: () => note('c') })).toMatchObject({
			entry: { seq: 2 },
		});
	});

	it('admits a storage append and reports a read position as the rules answer', async () => {
		const storage = await journals.open(`binding-storage-${++names}`);
		vi.mocked(rules.admit).mockReturnValueOnce(undefined);
		expect(await storage.append({ n: 1 }, 0)).toBeUndefined();
		expect(await storage.append({ n: 1 }, 0)).toEqual({ position: 1, entry: { n: 1 } });
		vi.mocked(rules.readPosition).mockReturnValueOnce(99);
		expect((await storage.read(0)).position).toBe(99);
	});
});
