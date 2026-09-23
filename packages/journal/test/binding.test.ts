/**
 * The binding between the verified rules and the code that runs them. A
 * proof is about a rule's body; it reaches the journal only when the
 * journal runs that body on the path the contract describes. Each case
 * replaces one rule with a sentinel answer and checks that the caller
 * follows it. A caller that computed the decision by hand would pass its
 * own tests and fail here.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { Journal, type Vocabulary } from '../src/journal.ts';
import { memoryJournals } from '../src/memory.ts';
import * as rules from '../src/rules.verified.ts';
import { bindings } from './support/binding.ts';

vi.mock('../src/rules.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/rules.verified.ts')>());
});

const bind = bindings({ rules });
afterAll(() => expect(bind.unbound()).toEqual([]));

type Kind = 'note' | 'run';
type Bodies = { note: { text: string }; run: { owner: string } };
const words: Vocabulary<Kind> = {
	run: 'run',
	accepts: (kind): kind is Kind => kind === 'note' || kind === 'run',
};
const note = (text: string) => ({ body: { text } });

let names = 0;
const journals = memoryJournals();
async function open(run?: string, lost?: () => void): Promise<Journal<Kind, Bodies>> {
	const journal = new Journal<Kind, Bodies>(
		journals.open(`binding-${++names}`),
		words,
		undefined,
		run,
		lost,
	);
	await journal.ready;
	return journal;
}

describe('the journal runs the verified rules', () => {
	it('refuses a write when writable says so', async () => {
		const journal = await open('run-1');
		bind.once(rules.writable, false);
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
		bind.once(rules.keyed, 'conflict');
		await expect(journal.append('note', { key: 'k', decide: () => note('again') })).rejects.toThrow(
			/already names/,
		);
		bind.once(rules.keyed, 'fresh');
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
		bind.once(rules.fenceStep, {
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
		let lost = 0;
		const journal = await open('run-1', () => {
			lost += 1;
		});
		bind.once(rules.fenceStep, {
			state: { fence: 'run-2', fenced: true, superseded: true },
			keep: true,
			lost: true,
		});
		await journal.append('run', { decide: () => ({ body: { owner: 'run-1' } }) });
		expect(lost).toBe(1);
		await expect(journal.append('note', { decide: () => note('late') })).rejects.toThrow(
			/superseded/,
		);
	});

	it('moves the counter as advanceSeq answers', async () => {
		const journal = await open();
		bind.once(rules.advanceSeq, 41);
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
		bind.always(rules.scanned, () => 0);
		await expect(journal.append('note', { decide: () => note('b') })).rejects.toThrow(
			/moved under the write/,
		);
		bind.restore(rules.scanned);
		await journal.settled();
		expect(await journal.append('note', { decide: () => note('c') })).toMatchObject({
			entry: { seq: 2 },
		});
	});

	it('numbers an entry as nextSeq answers', async () => {
		const journal = await open();
		bind.once(rules.nextSeq, 7);
		expect(await journal.append('note', { decide: () => note('a') })).toMatchObject({
			entry: { seq: 7 },
		});
	});
});
