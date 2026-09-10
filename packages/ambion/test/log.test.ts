/**
 * The log commits one entry at a time. A key lands once, a commit the record
 * moved past is refused, and nothing observes a message before its write
 * is confirmed.
 */

import { describe, expect, it } from 'vitest';
import { sessionsOver } from '../src/host/runtime.ts';
import { InMemorySessionRepo, type SpokenMessage } from '../src/index.ts';
import { RoomLog } from '../src/log/log.ts';
import { deferred, roomName } from './support/room.ts';
import { faultyOpener, memory } from './support/storage.ts';

const say = (text: string): Omit<SpokenMessage, 'seq' | 'key'> => ({
	kind: 'said',
	at: '2026-01-01T09:00:00.000Z',
	from: 'andrei',
	text,
});

const open = async () => new RoomLog((await memory.open()).sessions.open(roomName('log')));

describe('RoomLog', () => {
	it('lands a repeated key once, and hands back the first message', async () => {
		const log = await open();
		const first = await log.commit({ key: 'k1', draft: say('one') });
		const again = await log.commit({ key: 'k1', draft: say('one, again') });
		expect(first).toEqual({ message: { ...say('one'), seq: 1, key: 'k1' } });
		expect(again).toEqual({ message: { ...say('one'), seq: 1, key: 'k1' }, repeated: true });
		expect(log.lastSeq).toBe(1);
		expect(log.messages).toHaveLength(1);
		// the next key takes the next seq
		const next = await log.commit({ key: 'k2', draft: say('two') });
		expect('message' in next && next.message.seq).toBe(2);
	});

	it('lets one of two commits under one readThrough land, and refuses the other with what it missed', async () => {
		const log = await open();
		await log.commit({ key: 'q', draft: say('the question') });
		const [first, second] = await Promise.all([
			log.commit({ key: 'a', readThrough: 1, draft: { ...say('first answer'), from: 'alpha' } }),
			log.commit({ key: 'b', readThrough: 1, draft: { ...say('second answer'), from: 'beta' } }),
		]);
		expect('message' in first && first.message.seq).toBe(2);
		expect('missed' in second && second.missed.map((m) => m.seq)).toEqual([2]);
		// the refused commit consumed no seq
		expect(log.lastSeq).toBe(2);
		const third = await log.commit({ key: 'c', readThrough: 2, draft: say('third') });
		expect('message' in third && third.message.seq).toBe(3);
	});

	it('shows a message only once its write resolves', async () => {
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
		const log = new RoomLog(sessions.open(roomName('slow')));
		const landed: number[] = [];
		const commit = log.commit({ key: 'k', draft: say('slow') }, (m) => landed.push(m.seq));
		await new Promise((resolve) => setImmediate(resolve));
		expect(log.messages).toHaveLength(0);
		expect(log.lastSeq).toBe(0);
		expect(landed).toEqual([]);
		slow.resolve();
		await commit;
		expect(log.messages).toHaveLength(1);
		expect(landed).toEqual([1]);
	});

	it('drops a commit whose write fails, and the next one takes its seq', async () => {
		const faulty = faultyOpener(sessionsOver(new InMemorySessionRepo()));
		const log = new RoomLog(faulty.sessions.open(roomName('faulty')));
		await log.commit({ key: 'a', draft: say('kept') });
		faulty.fail(true);
		await expect(log.commit({ key: 'b', draft: say('lost') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		const next = await log.commit({ key: 'c', draft: say('kept too') });
		expect('message' in next && next.message.seq).toBe(2);
		expect(log.messages.map((m) => m.kind === 'said' && m.text)).toEqual(['kept', 'kept too']);
		// the same key lands now: the first attempt left nothing behind
		const retried = await log.commit({ key: 'b', draft: say('lost, retried') });
		expect('message' in retried && retried.message.seq).toBe(3);
	});
});

describe('RoomLog in doubt', () => {
	it('finds a write whose confirmation was lost before the next write lands', async () => {
		const faulty = faultyOpener(sessionsOver(new InMemorySessionRepo()));
		const log = new RoomLog(faulty.sessions.open(roomName('doubt')));
		await log.commit({ key: 'a', draft: say('one') });
		// the append lands, and the caller hears a failure
		faulty.fail('after');
		await expect(log.commit({ key: 'b', draft: say('two') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		// the log reads the storage at once: `two` is on the record before anything else lands
		await log.settled();
		expect(log.messages.map((m) => m.seq)).toEqual([1, 2]);
		const next = await log.commit({ key: 'c', draft: say('three') });
		expect('message' in next && next.message.seq).toBe(3);
		expect(log.messages.map((m) => [m.seq, m.key])).toEqual([
			[1, 'a'],
			[2, 'b'],
			[3, 'c'],
		]);
		// and the key of the write in doubt lands once: a retry hands back what landed
		const retried = await log.commit({ key: 'b', draft: say('two, again') });
		expect(retried).toMatchObject({ message: { seq: 2, text: 'two' }, repeated: true });
	});

	it('reads past the last entry it saw, so a second doubt costs the entries since the first', async () => {
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
		const log = new RoomLog(sessions.open(roomName('cursor')));
		for (const text of ['one', 'two', 'three', 'four']) await log.commit({ draft: say(text) });
		faulty.fail('after');
		await expect(log.commit({ draft: say('five') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await log.settled();
		await log.commit({ draft: say('six') });
		faulty.fail('after');
		await expect(log.commit({ draft: say('seven') })).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await log.settled();
		expect(log.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		// the replay read nothing; the first doubt read what four commits and the lost one appended;
		// the second read only what landed since: the lost one, and the two after it
		expect(reads).toEqual([0, 5, 2]);
	});
});
