/**
 * A checkpoint bounds what a fold costs. It carries the composition, the
 * closes and the leases a later fold still reads, behind a floor below
 * which every wake was answered. The journal drops the entries it replaced, the
 * messages stay, and a room that folds the rest behaves the same.
 */
import { describe, expect, it } from 'vitest';
import type { Seq } from '../src/index.ts';
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
import type { Composition } from '../src/transport.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { collect, crash, roomName, storedOf, tick } from './support/room.ts';
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

/** The room's own journal, for a test that reads what the cache holds. */
const journalOf = (session: Session): RoomJournal =>
	(session as unknown as { journal: RoomJournal }).journal;
const fold = (journal: RoomJournal): RoomState => foldRoom(journal.entries, retry);
const beside = (journal: RoomJournal) =>
	journal.entries.filter((entry) => entry.kind !== 'message');

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
	checkpoint?: { entries: number },
): Promise<Room> {
	const opened = await storage.open();
	const clock = fakeClock();
	const runtime = createRuntime({
		sessions: opened.sessions,
		clock,
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
	it('keeps one failed close owed when a later close stood down', () => {
		const at = '2026-01-01T09:00:00.000Z';
		const composition: Composition = {
			assistant: 'assistant',
			agents: [
				{
					name: 'assistant',
					identity: 'Writes the result.',
					attention: 'none',
				},
			],
			available: [],
			seq: 1,
			at,
		};
		const entries = [
			{ kind: 'composition' as const, body: composition, seq: 1 },
			{
				kind: 'message' as const,
				body: { kind: 'said' as const, at, from: 'priya', text: 'First?' },
				seq: 2,
			},
			{
				kind: 'close' as const,
				body: { owner: 'priya', from: 2, through: 2, at, wakes: ['assistant'] },
				seq: 3,
			},
			{
				kind: 'lease' as const,
				body: {
					id: 'closed:2:assistant:1',
					phase: 'ended' as const,
					reason: 'failed' as const,
					at,
					readThrough: 0,
				},
				seq: 4,
			},
			{
				kind: 'message' as const,
				body: { kind: 'said' as const, at, from: 'priya', text: 'Second?' },
				seq: 5,
			},
			{
				kind: 'close' as const,
				body: { owner: 'priya', from: 5, through: 5, at, wakes: ['assistant'] },
				seq: 6,
			},
			{
				kind: 'lease' as const,
				body: {
					id: 'closed:5:assistant:1',
					phase: 'ended' as const,
					reason: 'released' as const,
					at,
					readThrough: 0,
				},
				seq: 7,
			},
		];
		const before = foldRoom(entries, retry);
		expect(before.owed.map((owed) => [owed.from, owed.through, owed.unsuccessfulAttempts])).toEqual(
			[[2, 2, 1]],
		);
		const checkpoint = checkpointOf(before, Date.parse(at));
		if (checkpoint === undefined) throw new Error('Expected a checkpoint.');
		expect(checkpoint.leases.map((lease) => lease.id)).toContain('closed:2:assistant:1');
		const after = foldRoom(
			[
				{ kind: 'checkpoint' as const, body: checkpoint, seq: 8 },
				...entries.filter((entry) => entry.kind === 'message'),
			],
			retry,
		);
		expect(after.owed).toEqual(before.owed);
		expect(after.owed.map((owed) => [owed.from, owed.through, owed.unsuccessfulAttempts])).toEqual([
			[2, 2, 1],
		]);
		const broad = foldRoom(
			[
				...entries.filter((entry) => entry.kind !== 'lease'),
				{
					kind: 'message' as const,
					body: {
						kind: 'summary' as const,
						at,
						from: 'assistant',
						to: 'priya',
						text: 'Both.',
						covers: { from: 2, through: 5 },
					},
					seq: 8,
				},
			],
			retry,
		);
		expect(broad.owed).toEqual([]);
	});
	/**
	 * A wake's cause is derived, so a fold over a checkpoint must derive the
	 * same one. `causeOf` reads the questions that opened an exchange, and a
	 * checkpoint trims the closes that carry them. A fold that lost one would
	 * derive `message:2:assistant:1` where the last one wrote
	 * `opened:2:assistant:1`, and the room would wake the seat again for a
	 * wake a lease already answered.
	 */
	it('leaves every wake the same id, whatever it trimmed', () => {
		const at = '2026-01-01T09:00:00.000Z';
		const composition: Composition = {
			assistant: 'assistant',
			agents: [
				{ name: 'solo', identity: 'Answers.', attention: 'broadcast' },
				{
					name: 'assistant',
					identity: 'Writes the one message.',
					attention: 'none',
				},
			],
			available: [{ name: 'surveyor', identity: 'Holds the tonnage.', attention: 'broadcast' }],
			seq: 0,
			at,
		};
		const wakes = ['solo', 'assistant'];
		const entries = [
			{ kind: 'composition' as const, body: composition, seq: 0 },
			{
				kind: 'message' as const,
				body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'A.' },
				seq: 1,
			},
			// the first exchange: opened at 2, answered at 3, closed at 6
			{
				kind: 'message' as const,
				body: { kind: 'said', at, from: 'priya', text: 'q1', wakes },
				seq: 2,
			},
			{ kind: 'message' as const, body: { kind: 'said', at, from: 'solo', text: 'a1' }, seq: 3 },
			{ kind: 'close' as const, body: { owner: 'priya', from: 2, through: 3, at }, seq: 6 },
			// the second exchange, still open
			{
				kind: 'message' as const,
				body: { kind: 'said', at, from: 'priya', text: 'q2', wakes },
				seq: 8,
			},
		] as Parameters<typeof foldRoom>[0];

		const before = foldRoom(entries, retry);
		expect(before.pending.map((wake) => wake.id)).toEqual([
			'message:2:solo:1',
			'opened:2:assistant:1',
			'message:8:solo:1',
			'opened:8:assistant:1',
		]);

		const checkpoint = checkpointOf(before, Date.parse(at));
		const after = foldRoom(
			[
				{ kind: 'checkpoint' as const, body: checkpoint, seq: 9 },
				...entries.filter((entry) => entry.kind === 'message'),
			] as Parameters<typeof foldRoom>[0],
			retry,
		);
		expect(after.pending.map((wake) => wake.id)).toEqual(before.pending.map((wake) => wake.id));
	});

	it('stands for the entries it replaces, and the journal drops them', async () => {
		const { session, clock, opened } = await open('The one message.');
		try {
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anything?' });
			await session.quiet();

			const journal = journalOf(session);
			const before = facts(fold(journal));
			expect(beside(journal).length).toBeGreaterThan(3);

			const checkpoint = checkpointOf(fold(journal), clock.now());
			expect(checkpoint).toBeDefined();
			if (checkpoint === undefined) return;
			await journal.write('checkpoint', checkpoint);
			// one entry where there were many, every message still there, and the
			// room folds to exactly what it folded to before
			expect(beside(journal)).toHaveLength(1);
			expect(journal.sinceCheckpoint).toBe(0);
			expect(facts(fold(journal))).toEqual(before);
			expect(journal.messages()).toHaveLength(before.messages.length);
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
			const journal = journalOf(session);
			expect((await session.messages()).filter(isSummary)).toHaveLength(0);
			const owed = fold(journal).owed;
			expect(owed).toEqual([]);

			const checkpoint = checkpointOf(fold(journal), clock.now());
			if (checkpoint === undefined) throw new Error('the room wrote no checkpoint');
			await journal.write('checkpoint', checkpoint);
			// the draft is on the checkpoint, and the close is owed no longer
			const lastClose = fold(journal).closes.at(-1);
			expect(lastClose).toBeDefined();
			expect(checkpoint.leases.map((lease) => lease.id)).toContain(
				`closed:${lastClose?.through}:assistant:1`,
			);
			expect(fold(journal).owed).toEqual([]);
			await stopSession(session);
		} finally {
			await opened.dispose();
		}
	});
});

describe('a checkpoint the room folds', () => {
	it('refreshes the host projection when compaction keeps the same entry count', async () => {
		const opened = await memory.open();
		const clock = fakeClock();
		const runtime = createRuntime({ sessions: opened.sessions, clock });
		const session = startSession({ name: roomName('checkpoint-cache'), agents: [], runtime });
		try {
			await session.messages();
			const journal = journalOf(session);
			const host = session as Session & { state(): RoomState };
			const checkpoint = checkpointOf(fold(journal), clock.now());
			if (checkpoint === undefined) throw new Error('The room has no composition.');
			await journal.write('checkpoint', checkpoint);
			const before = host.state();
			const length = journal.entries.length;

			// Administrative entries can arrive without a caller reading the projection.
			await journal.write('composition', { ...checkpoint.composition, goal: 'A new goal.' });
			const replacement = checkpointOf(fold(journal), clock.now());
			if (replacement === undefined) throw new Error('The replacement has no composition.');
			await journal.write('checkpoint', replacement);

			expect(journal.entries).toHaveLength(length);
			expect(host.state()).toEqual(fold(journal));
			expect(host.state().composition?.goal).toBe('A new goal.');
			expect(before.composition?.goal).toBeUndefined();
		} finally {
			await stopSession(session);
			await opened.dispose();
		}
	});

	it('holds a lease it carries, so a later end starts no second activation', async () => {
		const opened = await memory.open();
		try {
			const at = '2026-01-01T09:00:00.000Z';
			const heard: { id: string; opens: boolean }[] = [];
			const journal = new RoomJournal(
				opened.sessions.open(roomName('checkpoint-first')),
				(entry) => {
					if (entry.kind === 'lease')
						heard.push({ id: entry.body.id, opens: opensOf(journal, entry) });
				},
			);
			await journal.ready;
			await journal.write('composition', {
				assistant: 'assistant',
				agents: [
					{ name: 'solo', identity: 'Answers.', attention: 'broadcast' },
					{
						name: 'assistant',
						identity: 'Writes the one message.',
						attention: 'none',
					},
				],
				available: [],
				at,
			});
			await journal.write('lease', {
				id: 'message:2:solo:1',
				phase: 'running',
				expiresAt: 60_000,
				at,
				readThrough: 0,
			});
			// the checkpoint carries the live lease, and the journal drops the entry it replaced
			const checkpoint = checkpointOf(fold(journal), 0);
			if (checkpoint === undefined) throw new Error('the room wrote no checkpoint');
			expect(checkpoint.leases.map((lease) => lease.id)).toEqual(['message:2:solo:1']);
			await journal.write('checkpoint', checkpoint);
			await journal.write('lease', {
				id: 'message:2:solo:1',
				phase: 'ended',
				reason: 'released',
				at,
				readThrough: 0,
			});
			// the end ends a lease the fold holds: the room reports the
			// activation ending and never a second one starting
			expect(heard).toEqual([
				{ id: 'message:2:solo:1', opens: true },
				{ id: 'message:2:solo:1', opens: false },
			]);
		} finally {
			await opened.dispose();
		}
	});
});

/**
 * What the room asks of a lease change: whether it starts an activation. The
 * room keeps the answer in a set the replay seeds from the fold
 * (`session.ts`), and a checkpoint puts every lease it carries in that fold.
 * Read here off the fold as it stood before the change landed.
 */
function opensOf(journal: RoomJournal, entry: { body: { id: string } }): boolean {
	const before = journal.entries.slice(0, -1);
	return !foldRoom(before, retry).leases.has(entry.body.id);
}

describe('a checkpoint past the fence', () => {
	it('is void, and the journal folds the one that stood', async () => {
		const opened = await memory.open();
		try {
			const name = roomName('checkpoint-fence');
			const piSession = await opened.sessions.open(name);
			const at = '2026-01-01T09:00:00.000Z';
			const composition: Composition = {
				assistant: 'assistant',
				agents: [
					{ name: 'solo', identity: 'Answers.', attention: 'broadcast' },
					{
						name: 'assistant',
						identity: 'Writes the one message.',
						attention: 'none',
					},
				],
				available: [],
				seq: 2,
				at,
			};
			const checkpoint = (floor: Seq) => ({ v: 2, floor, composition, closes: [], leases: [], at });
			// The storage holds the journal's own three beside the body.
			const stored = (type: string, seq: Seq, run: string, body: object) =>
				piSession.appendCustomEntry(type, { ...body, seq, run });
			// run 'a' wrote a checkpoint, run 'b' took the name, and 'a' wrote one more
			await stored('ambion/run', 1, 'a', { at });
			await stored('ambion/composition', 2, 'a', composition);
			await stored('ambion/checkpoint', 3, 'a', checkpoint(7));
			await stored('ambion/run', 4, 'b', { at });
			await stored('ambion/checkpoint', 5, 'a', checkpoint(99));

			const journal = new RoomJournal(opened.sessions.open(name));
			await journal.ready;
			// the reader folds the checkpoint that stood, and never the one past the fence
			expect(fold(journal).floor).toBe(7);
			expect(beside(journal).filter((entry) => entry.kind === 'checkpoint')).toHaveLength(1);
		} finally {
			await opened.dispose();
		}
	});
});

describe.each(storages)('a room over a checkpoint on $name', (storage) => {
	it('writes one every few entries, and a resumed run folds what it carries', async () => {
		const { session, opened, runtime } = await open('The one message.', storage, { entries: 3 });
		try {
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anything?' });
			await session.quiet();
			await tick();
			const name = session.name;
			const before = { seats: session.seats(), exchange: session.exchange() };
			const messages = await session.messages();
			// the room wrote at least one checkpoint on its own
			const stored = await storedOf(opened.sessions, name);
			expect(stored.filter((entry) => entry.type === 'ambion/checkpoint').length).toBeGreaterThan(
				0,
			);

			crash(runtime, session);
			const second = createRuntime({
				sessions: opened.sessions,
				clock: fakeClock(),
				checkpoint: { entries: 3 },
			});
			const resumed = await resumeSession(name, {
				runtime: second,
				agents,
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
