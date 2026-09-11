/**
 * A checkpoint bounds what a fold costs. It carries the composition, the
 * closes and the leases a later fold still reads, behind a floor below
 * which every wake was answered. The log drops the rows it replaced, the
 * messages stay, and a room that folds the rest behaves the same.
 */
import { describe, expect, it } from 'vitest';
import type { Composition, Seq } from '../src/index.ts';
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
import { RoomJournal } from '../src/journal/journal.ts';
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
	pending: state.pending,
	owed: state.owed,
	messages: state.messages,
	lastSeq: state.lastSeq,
});

/** The room's own log, for a test that reads what the cache holds. */
const logOf = (session: Session): RoomJournal => (session as unknown as { log: RoomJournal }).log;
const fold = (log: RoomJournal): RoomState => foldRoom(log.entries, retry);
const rows = (log: RoomJournal) => log.entries.filter((entry) => entry.kind !== 'message');

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
			expect(log.sinceCheckpoint).toBe(0);
			expect(facts(fold(log))).toEqual(before);
			expect(log.messages).toHaveLength(before.messages.length);
			await stopSession(session);
		} finally {
			await opened.dispose();
		}
	});

	it('keeps the draft that judged the last close, so the room drafts over it once', async () => {
		// the assistant read the room and judged it needed no summary: the close
		// stood down, and only its draft's lease says so
		const { session, clock, opened } = await open(undefined);
		try {
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anything?' });
			await session.quiet();
			const log = logOf(session);
			expect((await session.messages()).filter(isSummary)).toHaveLength(0);
			const owed = fold(log).owed;
			expect(owed).toEqual([]);

			const row = checkpointOf(fold(log), clock.now());
			if (row === undefined) throw new Error('the room wrote no checkpoint');
			await log.write('checkpoint', row);
			// the draft is on the checkpoint, and the close is owed no longer
			expect(row.leases.map((lease) => lease.id)).toContain('close:4:1');
			expect(fold(log).owed).toEqual([]);
			await stopSession(session);
		} finally {
			await opened.dispose();
		}
	});
});

describe('a checkpoint the room folds', () => {
	it('holds a lease it carries, so a later end starts no second activation', async () => {
		const opened = await memory.open();
		try {
			const at = '2026-01-01T09:00:00.000Z';
			const heard: { id: string; opens: boolean }[] = [];
			const log = new RoomJournal(opened.sessions.open(roomName('checkpoint-first')), (entry) => {
				if (entry.kind === 'lease') heard.push({ id: entry.body.id, opens: opensOf(log, entry) });
			});
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
			// the end row ends a lease the fold holds: the room reports the
			// activation ending and never a second one starting
			expect(heard).toEqual([
				{ id: '2:solo', opens: true },
				{ id: '2:solo', opens: false },
			]);
		} finally {
			await opened.dispose();
		}
	});
});

/**
 * What the room asks of a lease row: whether it starts an activation. The
 * room keeps the answer in a set the replay seeds from the fold
 * (`session.ts`), and a checkpoint puts every lease it carries in that fold.
 * Read here off the fold as it stood before the row landed.
 */
function opensOf(log: RoomJournal, entry: { body: { id: string } }): boolean {
	const before = log.entries.slice(0, -1);
	return !foldRoom(before, retry).leases.has(entry.body.id);
}

describe('a checkpoint past the fence', () => {
	it('is void, and the log folds the one that stood', async () => {
		const opened = await memory.open();
		try {
			const name = roomName('checkpoint-fence');
			const piSession = await opened.sessions.open(name);
			const at = '2026-01-01T09:00:00.000Z';
			const composition: Composition = {
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
				closes: [],
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

			const log = new RoomJournal(opened.sessions.open(name));
			await log.ready;
			// the reader folds the checkpoint that stood, and never the one past the fence
			expect(fold(log).floor).toBe(7);
			expect(rows(log).filter((entry) => entry.kind === 'checkpoint')).toHaveLength(1);
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
