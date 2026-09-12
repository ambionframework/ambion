/**
 * The journal commits one entry at a time. A key lands once, a commit the record
 * moved past is refused, and nothing observes a message before its write
 * is confirmed.
 */

import { describe, expect, it } from 'vitest';
import { sessionsOver } from '../src/host/runtime.ts';
import { InMemorySessionRepo, type SpokenMessage } from '../src/index.ts';
import { RoomJournal } from '../src/journal/journal.ts';
import { deferred, roomName } from './support/room.ts';
import { faultyOpener, memory } from './support/storage.ts';

const say = (text: string): Omit<SpokenMessage, 'seq' | 'key'> => ({
	kind: 'said',
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

const open = async () => new RoomJournal((await memory.open()).sessions.open(roomName('journal')));

describe('RoomJournal', () => {
	it('lands a repeated key once, and hands back the first message', async () => {
		const journal = await open();
		const first = await journal.commit({ key: 'k1', draft: say('one') });
		const again = await journal.commit({ key: 'k1', draft: say('one, again') });
		const landed = { kind: 'message', body: say('one'), seq: 1, key: 'k1' };
		expect(first).toEqual({ entry: landed });
		expect(again).toEqual({ entry: landed });
		expect(journal.lastSeq).toBe(1);
		expect(journal.messages()).toHaveLength(1);
		// the body the storage holds carries no place of its own: the entry does
		expect(journal.messages()[0]).toEqual({ ...say('one'), seq: 1, key: 'k1' });
		// the next key takes the next seq
		const next = await journal.commit({ key: 'k2', draft: say('two') });
		expect('entry' in next && next.entry.seq).toBe(2);
	});

	it('lets one of two commits under one readThrough land, and refuses the other with what it missed', async () => {
		const journal = await open();
		await journal.commit({ key: 'q', draft: say('the question') });
		const [first, second] = await Promise.all([
			journal.commit({
				key: 'a',
				readThrough: 1,
				draft: { ...say('first answer'), from: 'alpha' },
			}),
			journal.commit({
				key: 'b',
				readThrough: 1,
				draft: { ...say('second answer'), from: 'beta' },
			}),
		]);
		expect('entry' in first && first.entry.seq).toBe(2);
		expect('missed' in second && second.missed.map((e) => e.seq)).toEqual([2]);
		// the refused commit consumed no seq
		expect(journal.lastSeq).toBe(2);
		const third = await journal.commit({ key: 'c', readThrough: 2, draft: say('third') });
		expect('entry' in third && third.entry.seq).toBe(3);
	});

	it('shows a message only once its write resolves, and hears it there', async () => {
		const opened = await memory.open();
		const slow = deferred();
		const sessions = {
			open: async (id: string) => {
				const piSession = await opened.sessions.open(id);
				const append = piSession.appendCustomEntry.bind(piSession);
				piSession.appendCustomEntry = async (type, data) => {
					await slow.promise;
					return append(type, data);
				};
				return piSession;
			},
		};
		const heard: number[] = [];
		const journal = new RoomJournal(sessions.open(roomName('slow')), (entry) => {
			if (entry.kind === 'message') heard.push(entry.seq);
		});
		const commit = journal.commit({ key: 'k', draft: say('slow') });
		await new Promise((resolve) => setImmediate(resolve));
		expect(journal.messages()).toHaveLength(0);
		expect(journal.lastSeq).toBe(0);
		expect(heard).toEqual([]);
		slow.resolve();
		await commit;
		expect(journal.messages()).toHaveLength(1);
		// the journal hears what it appended, the way it hears what a read finds
		expect(heard).toEqual([1]);
	});

	it('drops a commit whose write fails, and the next one takes its seq', async () => {
		const faulty = faultyOpener(sessionsOver(new InMemorySessionRepo()));
		const journal = new RoomJournal(faulty.sessions.open(roomName('faulty')));
		await journal.commit({ key: 'a', draft: say('kept') });
		faulty.fail(true);
		await expect(journal.commit({ key: 'b', draft: say('lost') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		const next = await journal.commit({ key: 'c', draft: say('kept too') });
		expect('entry' in next && next.entry.seq).toBe(2);
		expect(journal.messages().map((m) => m.kind === 'said' && m.text)).toEqual([
			'kept',
			'kept too',
		]);
		// the same key lands now: the first attempt left nothing behind
		const retried = await journal.commit({ key: 'b', draft: say('lost, retried') });
		expect('entry' in retried && retried.entry.seq).toBe(3);
	});
});

describe('RoomJournal in doubt', () => {
	it('finds a write whose confirmation was lost before the next write lands', async () => {
		const faulty = faultyOpener(sessionsOver(new InMemorySessionRepo()));
		const journal = new RoomJournal(faulty.sessions.open(roomName('doubt')));
		await journal.commit({ key: 'a', draft: say('one') });
		// the append lands, and the caller hears a failure
		faulty.fail('after');
		await expect(journal.commit({ key: 'b', draft: say('two') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		// the journal reads the storage at once: `two` is on the record before anything else lands
		await journal.settled();
		expect(journal.messages().map((m) => m.seq)).toEqual([1, 2]);
		const next = await journal.commit({ key: 'c', draft: say('three') });
		expect('entry' in next && next.entry.seq).toBe(3);
		expect(journal.messages().map((m) => [m.seq, m.key])).toEqual([
			[1, 'a'],
			[2, 'b'],
			[3, 'c'],
		]);
		// and the key of the write in doubt lands once: a retry hands back what landed
		const retried = await journal.commit({ key: 'b', draft: say('two, again') });
		expect(retried).toMatchObject({ entry: { seq: 2, body: { text: 'two' } } });
	});

	it('reads past the last entry it saw, so every read costs the entries since the one before', async () => {
		const reads: number[] = [];
		const faulty = faultyOpener(sessionsOver(new InMemorySessionRepo()));
		const sessions = {
			open: async (id: string, parentId?: string) => {
				const piSession = await faulty.sessions.open(id, parentId);
				const find = piSession.findEntries.bind(piSession);
				piSession.findEntries = async (query) => {
					const found = await find(query);
					reads.push(found.length);
					return found;
				};
				return piSession;
			},
		};
		const journal = new RoomJournal(sessions.open(roomName('cursor')));
		for (const text of ['one', 'two', 'three', 'four']) await journal.commit({ draft: say(text) });
		faulty.fail('after');
		await expect(journal.commit({ draft: say('five') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await journal.settled();
		await journal.commit({ draft: say('six') });
		faulty.fail('after');
		await expect(journal.commit({ draft: say('seven') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await journal.settled();
		expect(journal.messages().map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		// the journal reads before every write, and every read returns only what landed since the
		// one before: the replay, then the entry the last commit appended, then the lost one
		// found by the read in doubt, then nothing before the next commit, and so on
		expect(reads).toEqual([0, 0, 1, 1, 1, 1, 1, 0, 1, 1]);
	});
});
