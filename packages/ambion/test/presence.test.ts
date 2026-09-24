import type { JournalOpener } from '@ambionframework/journal';
import { beforeEach, describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineHuman,
	isSpoken,
	type Room,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { refusal } from './support/errors.ts';
import {
	andrei,
	assistant,
	collect,
	currentExchange,
	deferred,
	messagesOf,
	roomName as name,
	participantsOf,
	scriptedAgent,
	waitForRoom,
} from './support/room.ts';
import { contextText, quiet, scripted } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { type FaultyJournals, faultyJournals, memory } from './support/storage.ts';

// -- a room that never speaks ------------------------------------------------

const contexts: string[] = [];
const prompts: string[] = [];

/** Every seat reads and stays quiet, and the test reads what each seat was shown. */
const recording = scripted((context) => {
	prompts.push(context.systemPrompt ?? '');
	contexts.push(contextText(context));
	return quiet();
});

const watcher = scriptedAgent('watcher', 'Watches the room.');
const mara = defineHuman({ name: 'mara', identity: 'Design lead.' });

const roomName = () => name('presence');

type Options = Partial<Parameters<typeof startRoom>[0]>;

/** The room options every test here starts from: one watcher, and the assistant. */
const base = (overrides: Options = {}) => ({
	name: roomName(),
	seats: { [watcher.name]: 'broadcast', [assistant.name]: 'none' } as const,
	agents: [watcher, assistant],
	execution: piExecution({ sessions: 'memory', stream: recording }),
	...overrides,
});

const open = async (overrides: Options = {}) => stopAtEnd(await startRoom(base(overrides)));

const kinds = async (session: Pick<Room, 'read'>) => (await messagesOf(session)).map((m) => m.kind);

const presenceOf = async (session: Room, name: string) => {
	const seat = (await participantsOf(session)).find((s) => s.name === name);
	return seat?.kind === 'human' ? seat.presence : undefined;
};

beforeEach(() => {
	contexts.length = 0;
	prompts.length = 0;
});

describe('presence', () => {
	it('settles with nobody present, and commits an arrival that wakes nobody and carries no text', async () => {
		const session = await open();
		await waitForRoom(session);
		expect(await messagesOf(session)).toHaveLength(0);
		expect((await participantsOf(session)).filter((s) => s.kind === 'human')).toHaveLength(0);

		const seen = collect(session);
		await session.visit(andrei);
		await waitForRoom(session);
		// no seat watches for an arrival by default, so no seat was handed a context at all
		expect(await kinds(session)).toEqual(['arrived']);
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);
		expect(contexts).toHaveLength(0);
		// the visit stamps the arrival
		const arrival = (await messagesOf(session))[0];
		expect(arrival).toMatchObject({ kind: 'arrived', from: 'andrei', subject: 'andrei' });
		expect(arrival && isSpoken(arrival)).toBe(false);
		expect(arrival && 'text' in arrival).toBe(false);
	});

	it('wakes a seat that watches arrivals, and only that seat', async () => {
		const greeter = scriptedAgent('greeter');
		const aside = scriptedAgent('aside');
		const session = await open({
			agents: [watcher, greeter, aside],
			seats: { [watcher.name]: 'broadcast', [greeter.name]: 'presence', [aside.name]: 'named' },
		});
		const seen = collect(session);
		await session.visit(andrei);
		await waitForRoom(session);

		const woke = seen.filter((e) => e.type === 'activation_start').map((e) => e.agent);
		expect(woke).toEqual(['greeter']);
		// the roster tells every seat which of them watches for this
		expect(contexts.at(-1)).toContain('- greeter (active, watches arrivals)');
		expect(contexts.at(-1)).toContain('- aside (idle, named only)');
	});

	it('steers a seat already at work, which is the whole of what presence routing does', async () => {
		const held = deferred();
		const providerStarted = deferred();
		const seen: string[] = [];
		const holding = scripted(async (context) => {
			seen.push(contextText(context));
			providerStarted.resolve();
			await held.promise;
			return quiet();
		});
		const session = await open({ execution: piExecution({ sessions: 'memory', stream: holding }) });
		const visit = await session.visit(andrei);
		await visit.send({ text: 'start something long' }); // watcher is now mid-activation
		await providerStarted.promise;
		await session.visit(mara); // arrives while it works
		held.resolve();
		await waitForRoom(session);

		// the arrival never woke a second activation; it landed inside the running one
		expect(await kinds(session)).toEqual(['arrived', 'said', 'arrived']);
		expect(seen.some((c) => c.includes('[new] · mara arrived'))).toBe(true);
	});

	it('stamps two people from their own visits, and shows no goal when none is set', async () => {
		const session = await open();
		const one = await session.visit(andrei);
		const two = await session.visit(mara);
		await one.send({ text: 'from andrei' });
		await two.send({ text: 'from mara' });
		await waitForRoom(session);

		const said = (await messagesOf(session)).filter(isSpoken);
		expect(said.map((m) => [m.from, m.text])).toEqual([
			['andrei', 'from andrei'],
			['mara', 'from mara'],
		]);
		expect(contexts.at(-1)).not.toContain('This room exists to:');
		// the audience paragraph is about routing, so it needs no goal
		expect(prompts.at(-1)).toContain('Who is reading can change while you work');
	});

	it('holds one visit per person, takes leave() twice, and refuses a stale visit', async () => {
		const session = await open();
		const seen = collect(session);
		const terminal = await session.visit(andrei);
		const browser = await session.visit(andrei);
		await waitForRoom(session);
		expect(browser.human).toBe(terminal.human); // one person is in the room once, or not at all
		expect(await kinds(session)).toEqual(['arrived']); // the second visit committed nothing
		expect(await presenceOf(session, 'andrei')).toBe('present');

		await terminal.leave();
		await expect(terminal.leave()).resolves.toBeUndefined();
		await waitForRoom(session);
		expect(await presenceOf(session, 'andrei')).toBe('absent');
		expect(await kinds(session)).toEqual(['arrived', 'left']);
		// leaving is a message like any other, and the stream carries it
		expect(seen.filter((e) => e.type === 'message' && e.message.kind === 'left')).toHaveLength(1);
		await expect(terminal.send({ text: 'hello?' })).rejects.toThrow(/has ended/);
		await expect(terminal.send({ text: 'hello?' })).rejects.toEqual(refusal('visit_ended'));
	});

	it('remembers somebody who left across a run, and reads a name that is not running', async () => {
		const runtime = createRuntime({ storage: (await memory.open()).storage });
		const first = await startRoom(base({ runtime }));
		const visit = await first.visit(andrei);
		await visit.send({ text: 'noting that I was here' });
		await waitForRoom(first);
		await visit.leave();
		await waitForRoom(first);
		expect(await presenceOf(first, 'andrei')).toBe('absent');
		// absent, and still on the roster the agents read
		expect(contexts.at(-1)).toContain('andrei');
		await first.stop();

		// the roster folds from the record, nothing stands up, and everybody the record knows is absent
		const view = await readRoom(first.name, { runtime });
		expect(view.messages.filter(isSpoken).map((m) => m.text)).toEqual(['noting that I was here']);
		expect(
			view.participants.map((s) => [s.name, s.kind === 'agent' ? s.status : s.presence]),
		).toEqual([
			['watcher', 'idle'],
			['assistant', 'idle'],
			['andrei', 'absent'],
		]);

		const again = await open({ name: first.name, runtime });
		await waitForRoom(again);
		expect(await presenceOf(again, 'andrei')).toBe('absent');
		expect((await participantsOf(again)).find((s) => s.name === 'andrei')?.identity).toBe(
			andrei.identity,
		);
	});

	it('anchors lastDeparture where a person stopped reading, and reads only what followed it', async () => {
		const session = await open();
		const first = await session.visit(andrei);
		expect(first.lastDeparture).toBeUndefined(); // never been here

		await first.send({ text: 'before' });
		await first.leave();
		await waitForRoom(session);
		const left = (await messagesOf(session)).find((m) => m.kind === 'left');

		const again = await session.visit(andrei);
		expect(again.lastDeparture).toBe(left?.seq);
		await again.send({ text: 'after' });
		await waitForRoom(session);
		expect(again.lastDeparture).toBe(left?.seq); // it does not move while they read
		// a cursor reads both kinds of message, in order
		const missed = await messagesOf(session, { since: again.lastDeparture });
		expect(missed.map((m) => m.kind)).toEqual(['arrived', 'said']);
		expect(missed.every((m) => m.seq > (left?.seq ?? 0))).toBe(true);
		expect(await messagesOf(session)).toHaveLength(5);

		await again.leave();
		await waitForRoom(session);
		const second = (await messagesOf(session)).filter((m) => m.kind === 'left').at(-1);
		const back = await session.visit(andrei);
		expect(back.lastDeparture).toBe(second?.seq); // it moves when they leave again
	});

	it('closes its visits when the run stops, without waking anybody', async () => {
		const session = await open();
		const visit = await session.visit(andrei);
		await waitForRoom(session);
		const seen = collect(session);

		await session.stop();

		const view = await readRoom(session.name);
		expect(view.messages.map((m) => m.kind)).toEqual(['arrived', 'left']);
		// an activation started to hear that the room is closing is an activation nobody reads
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);
		await expect(visit.send({ text: 'still there?' })).rejects.toThrow();
	});

	it('shows an agent the goal, the clock, what each person has not seen, and what presence is for', async () => {
		const session = await open({ goal: 'Ship payments v2 this quarter.' });
		const visit = await session.visit(andrei);
		await visit.send({ text: 'kicking this off' });
		await visit.leave();
		await waitForRoom(session);

		const later = await session.visit(mara);
		await later.send({ text: 'while andrei is away' });
		await waitForRoom(session);

		const back = await session.visit(andrei);
		await back.send({ text: 'what moved?' }); // quiet arrivals wake nobody
		await waitForRoom(session);
		expect(back.lastDeparture).toBeDefined();

		const view = contexts.at(-1) ?? '';
		expect(view).toContain('This room exists to: Ship payments v2 this quarter.');
		expect(view).toContain('The time is');
		expect(view).toContain('- watcher (active): Watches the room.');
		expect(view).toContain('andrei (present');
		expect(view).toContain('has not seen the last');
		expect(view).toContain('── andrei has not seen anything below this line ──');
		expect(view).toContain('while andrei is away');
		expect(prompts.at(-1)).toContain('Who is reading can change while you work');
	});
});

// -- a storage that fails ----------------------------------------------------

/** A room over a storage the test can break and mend. */
async function brittle(): Promise<{ session: Room; fail: FaultyJournals['fail'] }> {
	const faulty = faultyJournals((await memory.open()).storage);
	const runtime = createRuntime({ storage: faulty.journals });
	const session = await startRoom(base({ runtime }));
	return { session, fail: faulty.fail };
}

describe('a storage that fails', () => {
	it('drops the delivery whose write failed, and the next one takes its seq', async () => {
		const { session, fail } = await brittle();
		const seen = collect(session);
		const visit = await session.visit(andrei);

		fail(true);
		await expect(visit.send({ text: 'lost' })).rejects.toThrow(/disk is full/);
		// the failed delivery is nowhere: not on the record, not on the stream, and nobody woke
		expect(await messagesOf(session)).toHaveLength(1);
		expect(seen.filter((e) => e.type === 'message')).toHaveLength(1);
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);

		// the queue carries on: a mended storage writes the next message, at the next
		// place. One counter gives out every place, so the fence and the composition
		// took the first two and the record starts at 3.
		fail(false);
		const kept = await visit.send({ text: 'kept' });
		expect(kept).toMatchObject({ owner: 'andrei', from: 4 });
		const record = await messagesOf(session);
		expect(record.map((m) => m.seq)).toEqual([3, 4]);
		expect(record.map((m) => m.kind)).toEqual(['arrived', 'said']);
		await session.stop();
	});

	it('answers whoever waits when the close itself cannot be written, and closes at the next reconcile', async () => {
		const { session, fail } = await brittle();
		const events = collect(session);
		const visit = await session.visit(andrei);
		await waitForRoom(session);
		// the close is the one write that fails
		fail(true, 'close');
		await visit.send({ text: 'first?' });
		// the seat is woken; the host waits for the room to be quiet
		await expect(messagesOf(session)).resolves.toEqual(expect.any(Array));
		expect(events.map((e) => e.type)).not.toContain('exchange_closed');
		expect(events.map((e) => e.type)).not.toContain('quiet');
		expect(await currentExchange(session)).toMatchObject({ owner: 'andrei' });

		// the storage mends, the seats work and stop again, and the close is written then
		fail(false);
		await visit.send({ text: 'still there?' });
		await waitForRoom(session);
		expect(await currentExchange(session)).toBeUndefined();
		const closed = events.filter((e) => e.type === 'exchange_closed');
		expect(closed).toHaveLength(1);
		const record = await messagesOf(session);
		expect(closed[0]).toMatchObject({
			exchange: { owner: 'andrei', from: record[1]?.seq, through: record.at(-1)?.seq },
		});
		await session.stop();
	});

	it('frees the name when the shutdown itself cannot write', async () => {
		const { session, fail } = await brittle();
		await session.visit(andrei);

		fail(true);
		await expect(session.stop()).rejects.toThrow(/disk is full/);
		// a room that cannot be started again is worse than one that lost a write
		const again = await open({ name: session.name, runtime: createRuntime() });
		expect(again.name).toBe(session.name);
	});

	it('surfaces a storage it cannot open, and never as an unhandled rejection', async () => {
		const unreachable: JournalOpener = {
			open: async () => {
				throw new Error('the storage is unreachable');
			},
		};
		const loose: unknown[] = [];
		const note = (reason: unknown) => loose.push(reason);
		process.on('unhandledRejection', note);

		await expect(
			startRoom(base({ runtime: createRuntime({ storage: unreachable }) })),
		).rejects.toThrow(/unreachable/);

		await new Promise((resolve) => setImmediate(resolve));
		process.off('unhandledRejection', note);
		expect(loose).toHaveLength(0);
	});
});
