/**
 * The journal appends one entry at a time. A key lands once, and nothing
 * observes an entry before its write is confirmed.
 */

import { describe, expect, it } from 'vitest';
import type { SpokenMessage } from '../src/index.ts';
import { roomJournal } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { deferred, roomName } from './support/room.ts';
import { faultyJournals, gatedJournals, memory } from './support/storage.ts';

const options = { backoff: () => 0 };

const say = (text: string): Omit<SpokenMessage, 'seq' | 'key'> => ({
	kind: 'said',
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

type OpenedStorage = Awaited<ReturnType<typeof memory.open>>;

const open = async (opened?: OpenedStorage, name = roomName('journal')) => {
	const storage = opened ?? (await memory.open());
	return roomJournal(storage.journals.open(name));
};

type OpenJournal = Awaited<ReturnType<typeof open>>;

const message = (journal: OpenJournal, key: string | undefined, text: string) =>
	journal.append('message', {
		...(key === undefined ? {} : { key }),
		decide: () => ({ body: say(text) }),
	});

const messages = (journal: OpenJournal) => foldRoom(journal.entries, options).messages;

describe('roomJournal', () => {
	it('lands a repeated key once, bypasses its decision, and recovers it after a restart', async () => {
		const opened = await memory.open();
		const name = roomName('journal-restart');
		const first = await open(opened, name);
		const landed = await message(first, 'k1', 'one');
		let decided = false;
		const again = await first.append('message', {
			key: 'k1',
			decide: () => {
				decided = true;
				return { body: say('one, again') };
			},
		});
		if (!('entry' in landed) || !('entry' in again)) throw new Error('Expected entries.');
		expect(again).toEqual({ entry: landed.entry });
		expect(decided).toBe(false);
		expect(first.lastSeq).toBe(1);
		expect(messages(first)).toHaveLength(1);
		// The body the storage holds carries no place of its own: the entry does.
		expect(messages(first)[0]).toEqual({ ...say('one'), seq: 1, key: 'k1' });

		const restarted = await open(opened, name);
		let restartedDecision = false;
		const recovered = await restarted.append('message', {
			key: 'k1',
			decide: () => {
				restartedDecision = true;
				return { body: say('one, after restart') };
			},
		});
		expect(recovered).toEqual({ entry: landed.entry });
		expect(restartedDecision).toBe(false);
		expect(restarted.lastSeq).toBe(1);

		const next = await message(first, 'k2', 'two');
		expect('entry' in next && next.entry.seq).toBe(2);
	});

	it('decides against the current room projection inside the queue', async () => {
		const journal = await open();
		await message(journal, 'q', 'the question');
		await journal.append('lease', {
			decide: () => ({
				body: {
					id: 'message:1:product:1',
					phase: 'running',
					expiresAt: Date.parse('2026-01-01T09:01:00.000Z'),
					at: '2026-01-01T09:00:00.000Z',
					readThrough: 1,
				},
			}),
		});
		const decideAnswer = (key: string, from: string) =>
			journal.append('message', {
				key,
				decide: () => {
					const state = foldRoom(journal.entries, options);
					if (state.lastSeq > 1) {
						return { result: { missed: state.messages.filter((entry) => entry.seq > 1) } };
					}
					return { body: { ...say(`${from} answer`), from } };
				},
			});
		const [first, second] = await Promise.all([
			decideAnswer('a', 'alpha'),
			decideAnswer('b', 'beta'),
		]);
		expect('entry' in first && first.entry.seq).toBe(3);
		expect(second).toEqual({ result: { missed: [messages(journal)[1]] } });
		expect(journal.lastSeq).toBe(3);
	});

	it('shows a message only once its write resolves, and hears it there', async () => {
		const opened = await memory.open();
		const slow = deferred();
		const journals = gatedJournals(opened.journals, () => slow.promise);
		const heard: number[] = [];
		const journal = roomJournal(journals.open(roomName('slow')), (entry) => {
			if (entry.kind === 'message') heard.push(entry.seq);
		});
		const commit = journal.append('message', { key: 'k', decide: () => ({ body: say('slow') }) });
		await new Promise((resolve) => setImmediate(resolve));
		expect(messages(journal)).toHaveLength(0);
		expect(journal.lastSeq).toBe(0);
		expect(heard).toEqual([]);
		slow.resolve();
		await commit;
		expect(messages(journal)).toHaveLength(1);
		// The journal hears what it appended, the way it hears what a read finds.
		expect(heard).toEqual([1]);
	});

	it('drops a write whose append fails, and the next one takes its seq', async () => {
		const faulty = faultyJournals((await memory.open()).journals);
		const journal = roomJournal(faulty.journals.open(roomName('faulty')));
		await message(journal, 'a', 'kept');
		faulty.fail(true);
		await expect(message(journal, 'b', 'lost')).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		const next = await message(journal, 'c', 'kept too');
		expect('entry' in next && next.entry.seq).toBe(2);
		expect(messages(journal).map((m) => m.kind === 'said' && m.text)).toEqual(['kept', 'kept too']);
		// The same key lands now: the first attempt left nothing behind.
		const retried = await message(journal, 'b', 'lost, retried');
		expect('entry' in retried && retried.entry.seq).toBe(3);
	});
});

describe('roomJournal in doubt', () => {
	it('finds a write whose confirmation was lost before the next write lands', async () => {
		const faulty = faultyJournals((await memory.open()).journals);
		const journal = roomJournal(faulty.journals.open(roomName('doubt')));
		await message(journal, 'a', 'one');
		// The append lands, and the caller hears a failure.
		faulty.fail('after');
		await expect(message(journal, 'b', 'two')).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		// The journal reads storage at once: `two` is on the record before anything else lands.
		await journal.settled();
		expect(messages(journal).map((m) => m.seq)).toEqual([1, 2]);
		const next = await message(journal, 'c', 'three');
		expect('entry' in next && next.entry.seq).toBe(3);
		expect(messages(journal).map((m) => [m.seq, m.key])).toEqual([
			[1, 'a'],
			[2, 'b'],
			[3, 'c'],
		]);
		// The key of the write in doubt lands once: a retry hands back what landed.
		const retried = await message(journal, 'b', 'two, again');
		expect(retried).toMatchObject({ entry: { seq: 2, body: { text: 'two' } } });
	});

	it('updates the projection before the next decision after recovery', async () => {
		const faulty = faultyJournals((await memory.open()).journals);
		const journal = roomJournal(faulty.journals.open(roomName('recovered-projection')));
		faulty.fail('after');
		const lost = message(journal, 'a', 'recovered');
		await expect(lost).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		const next = await journal.append('message', {
			key: 'b',
			decide: () => {
				const state = foldRoom(journal.entries, options);
				expect(
					state.messages
						.filter((entry): entry is SpokenMessage => entry.kind === 'said')
						.map((entry) => entry.text),
				).toEqual(['recovered']);
				return { body: say('next') };
			},
		});
		expect('entry' in next && next.entry.seq).toBe(2);
		expect(
			messages(journal)
				.filter((entry): entry is SpokenMessage => entry.kind === 'said')
				.map((entry) => entry.text),
		).toEqual(['recovered', 'next']);
	});

	it('reads past the last entry it saw, so every read costs the entries since the one before', async () => {
		const reads: number[] = [];
		const faulty = faultyJournals((await memory.open()).journals);
		const journals = {
			async open(name: string) {
				const storage = await faulty.journals.open(name);
				return {
					async read(after: number) {
						const found = await storage.read(after);
						reads.push(found.entries.length);
						return found;
					},
					append: storage.append.bind(storage),
				};
			},
		};
		const journal = roomJournal(journals.open(roomName('cursor')));
		for (const text of ['one', 'two', 'three', 'four']) await message(journal, undefined, text);
		faulty.fail('after');
		await expect(message(journal, undefined, 'five')).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await journal.settled();
		await message(journal, undefined, 'six');
		faulty.fail('after');
		await expect(message(journal, undefined, 'seven')).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await journal.settled();
		expect(messages(journal).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		// The journal reads the replay, each appended entry, and each lost write.
		expect(reads).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0, 1]);
	});
});
