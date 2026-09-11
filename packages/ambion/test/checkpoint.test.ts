/**
 * A checkpoint bounds what a fold costs. It carries the composition and the
 * leases a later fold still reads, behind a floor below which every
 * activation was answered. The log drops the rows it replaced, the messages
 * stay, and a room that folds the rest behaves the same.
 */
import { describe, expect, it } from 'vitest';
import type { CompositionRow, Seq } from '../src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSummary,
	type Runtime,
	resumeSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { RoomLog } from '../src/log/log.ts';
import { checkpointOf, foldRoom, type RoomState } from '../src/room/fold.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { collect, crash, roomName, rowsOf, tick } from './support/room.ts';
import { byAgent, quiet, says, scripted, summarise, toolNames } from './support/scripted.ts';
import { memory, type OpenedStorage, storages } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});
const solo = defineAgent({
	name: 'solo',
	identity: 'Answers.',
	instructions: 'speak',
	model: 'scripted/solo',
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const retry = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };
const agents = [assistant, solo];

/** What the room acts on. A checkpoint may drop a lease; it may change none of this. */
const facts = (state: RoomState) => ({
	composition: state.composition,
	roster: state.roster,
	people: [...state.people.entries()],
	exchange: state.exchange,
	closes: state.closes,
	due: state.due,
	messages: state.messages,
	lastSeq: state.lastSeq,
});

/** The room's own log, for a test that reads what the cache holds. */
const logOf = (session: Session): RoomLog => (session as unknown as { log: RoomLog }).log;
const fold = (log: RoomLog): RoomState => foldRoom(log.entries, retry);
const rows = (log: RoomLog) => log.entries.filter((entry) => entry.type !== 'message');

/** The assistant writes the one message once, or judges the room and stays quiet. */
const drafts = (text: string | undefined) => (context: unknown, _name: string, call: number) => {
	if (!toolNames(context as never).includes('summarise')) return quiet();
	return text !== undefined && call === 1 ? summarise(text) : quiet();
};

interface Room {
	session: Session;
	clock: FakeClock;
	opened: OpenedStorage;
	runtime: Runtime;
}

async function open(
	summary: string | undefined,
	storage = memory,
	checkpoint?: { rows: number },
): Promise<Room> {
	const opened = await storage.open();
	const clock = fakeClock();
	const runtime = createRuntime({
		sessions: opened.sessions,
		clock,
		agents,
		...(checkpoint === undefined ? {} : { checkpoint }),
	});
	const session = startSession({
		name: roomName(`checkpoint-${storage.name}`),
		assistant,
		agents: [solo],
		runtime,
		streamFn: scripted(byAgent({ solo: says(['one', 'two']), assistant: drafts(summary) })),
	});
	return { session, clock, opened, runtime };
}

describe('a checkpoint', () => {
	it('stands for the rows it replaces, and the log drops them', async () => {
		const { session, clock, opened } = await open('The one message.');
		try {
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anything?' });
			await session.quiet();

			const log = logOf(session);
			const before = facts(fold(log));
			expect(rows(log).length).toBeGreaterThan(3);

			const row = checkpointOf(fold(log), clock.now());
			expect(row).toBeDefined();
			if (row === undefined) return;
			await log.write('checkpoint', row);
			// one row where there were many, every message still there, and the
			// room folds to exactly what it folded to before
			expect(rows(log)).toHaveLength(1);
			expect(log.rowsSinceCheckpoint).toBe(0);
			expect(facts(fold(log))).toEqual(before);
			expect(log.messages).toHaveLength(before.messages.length);
			await stopSession(session);
		} finally {
			await opened.dispose();
		}
	});

	it('puts the floor past a close the assistant judged, so the room drafts over it once', async () => {
		// the assistant read the room and judged it needed no summary: the close
		// stood down, and the floor is what says the room owes nothing for it
		const { session, clock, opened } = await open(undefined);
		try {
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anything?' });
			await session.quiet();
			const log = logOf(session);
			expect((await session.messages()).filter(isSummary)).toHaveLength(0);
			const before = fold(log);
			expect(before.due).toEqual([]);
			const close = before.closes.at(-1);
			if (close === undefined) throw new Error('the room closed no exchange');

			const row = checkpointOf(before, clock.now());
			if (row === undefined) throw new Error('the room wrote no checkpoint');
			// the floor is past the close, so the draft's lease is dropped with
			// every other row: nothing below the floor is read for an activation
			expect(row.floor).toBeGreaterThan(close.seq);
			expect(row.leases).toEqual([]);
			await log.write('checkpoint', row);
			expect(fold(log).due).toEqual([]);
			// the close is a message, so it stays whatever the checkpoint dropped
			expect(fold(log).closes.at(-1)).toEqual(close);
			await stopSession(session);
		} finally {
			await opened.dispose();
		}
	});
});

describe('a checkpoint the log caches', () => {
	it('holds a row for every lease it carries, so a later end is not a first row', async () => {
		const opened = await memory.open();
		try {
			const at = '2026-01-01T09:00:00.000Z';
			const heard: { id: string; first: boolean }[] = [];
			const log = new RoomLog(
				opened.sessions.open(roomName('checkpoint-first')),
				(entry, first) => {
					if (entry.type === 'lease') heard.push({ id: entry.lease.id, first });
				},
			);
			await log.ready;
			await log.write('composition', {
				assistant: { name: 'assistant', identity: 'Writes the one message.', attention: 'none' },
				agents: [{ name: 'solo', identity: 'Answers.', attention: 'broadcast' }],
				available: [],
				at,
			});
			await log.write('lease', { id: '2:solo', phase: 'running', expiry: 60_000, at });
			// the checkpoint carries the live lease, and the log drops the row it replaced
			const row = checkpointOf(fold(log), 0);
			if (row === undefined) throw new Error('the room wrote no checkpoint');
			expect(row.leases.map((lease) => lease.id)).toEqual(['2:solo']);
			await log.write('checkpoint', row);
			await log.write('lease', { id: '2:solo', phase: 'ended', reason: 'released', at });
			// the end row ends a lease the log holds: it is no first row, so the room
			// reports the activation ending and never a second one starting
			expect(heard).toEqual([
				{ id: '2:solo', first: true },
				{ id: '2:solo', first: false },
			]);
		} finally {
			await opened.dispose();
		}
	});
});

describe('a checkpoint past the fence', () => {
	it('is void, and the log folds the one that stood', async () => {
		const opened = await memory.open();
		try {
			const name = roomName('checkpoint-fence');
			const piSession = await opened.sessions.open(name);
			const at = '2026-01-01T09:00:00.000Z';
			const composition: CompositionRow = {
				assistant: { name: 'assistant', identity: 'Writes the one message.', attention: 'none' },
				agents: [{ name: 'solo', identity: 'Answers.', attention: 'broadcast' }],
				available: [],
				after: 0,
				at,
			};
			const checkpoint = (floor: Seq, written: string) => ({
				v: 1,
				floor,
				composition,
				leases: [],
				after: 0,
				at,
				written,
			});
			// run 'a' wrote a checkpoint, run 'b' took the name, and 'a' wrote one more
			await piSession.appendCustomEntry('ambion/run', { run: 'a', after: 0, at, written: 'a' });
			await piSession.appendCustomEntry('ambion/composition', { ...composition, written: 'a' });
			await piSession.appendCustomEntry('ambion/checkpoint', checkpoint(7, 'a'));
			await piSession.appendCustomEntry('ambion/run', { run: 'b', after: 0, at, written: 'b' });
			await piSession.appendCustomEntry('ambion/checkpoint', checkpoint(99, 'a'));

			const log = new RoomLog(opened.sessions.open(name));
			await log.ready;
			// the reader folds the checkpoint that stood, and never the one past the fence
			expect(fold(log).floor).toBe(7);
			expect(rows(log).filter((entry) => entry.type === 'checkpoint')).toHaveLength(1);
		} finally {
			await opened.dispose();
		}
	});
});

describe.each(storages)('a room over a checkpoint on $name', (storage) => {
	it('writes one every few rows, and a resumed run folds what it carries', async () => {
		const { session, opened, runtime } = await open('The one message.', storage, { rows: 3 });
		try {
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anything?' });
			await session.quiet();
			await tick();
			const name = session.name;
			const before = { seats: session.seats(), exchange: session.exchange() };
			const messages = await session.messages();
			// the room wrote at least one checkpoint on its own
			const stored = await rowsOf(opened.sessions, name);
			expect(stored.filter((row) => row.type === 'ambion/checkpoint').length).toBeGreaterThan(0);

			crash(runtime, session);
			const second = createRuntime({
				sessions: opened.sessions,
				clock: fakeClock(),
				agents,
				checkpoint: { rows: 3 },
			});
			const resumed = await resumeSession(name, {
				runtime: second,
				streamFn: scripted(
					byAgent({ solo: says(['one', 'two']), assistant: drafts('The one message.') }),
				),
			});
			const events = collect(resumed);
			await resumed.quiet();
			// the fold over the checkpoint is the fold the first run held
			expect(resumed.seats()).toEqual(before.seats);
			expect(resumed.exchange()).toEqual(before.exchange);
			expect(await resumed.messages()).toEqual(messages);
			// and nothing is woken again for a wake the checkpoint says was answered
			expect(events.filter((e) => e.type === 'activation_start')).toEqual([]);
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});
});
