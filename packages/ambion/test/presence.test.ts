import type { JournalOpener } from '@ambionframework/journal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	type Room,
	readRoom,
	startRoom,
} from '../src/index.ts';
import {
	andrei,
	assistant,
	collect,
	currentExchange,
	deferred,
	roomName as name,
	waitForRoom,
} from './support/room.ts';
import { contextText, quiet, scripted } from './support/scripted.ts';
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

const watcher = defineAgent({
	name: 'watcher',
	identity: 'Watches the room.',
	instructions: 'stay quiet',
	model: 'scripted/watcher',
});

const mara = defineHuman({ name: 'mara', identity: 'Design lead.' });

const roomName = () => name('presence');

const open = (overrides: Partial<Parameters<typeof startRoom>[0]> = {}) =>
	startRoom({
		name: roomName(),
		assistant,
		agents: [watcher],
		streamFn: recording,
		...overrides,
	});

const kinds = async (session: { messages(): Promise<Message[]> }) =>
	(await session.messages()).map((m) => m.kind);

const presenceOf = (session: Room, name: string) => {
	const seat = session.participants().find((s) => s.name === name);
	return seat?.kind === 'human' ? seat.presence : undefined;
};

const started: Room[] = [];
const track = (session: Room) => {
	started.push(session);
	return session;
};

afterEach(async () => {
	vi.useRealTimers();
	for (const session of started.splice(0)) await session.stop();
	contexts.length = 0;
	prompts.length = 0;
});

const lastSystemPrompt = () => prompts.at(-1) ?? '';

// -- the milestone tests -----------------------------------------------------

describe('presence', () => {
	it('runs a room of agents with nobody present, and settles', async () => {
		const session = track(await open());
		await waitForRoom(session);
		expect(await session.messages()).toHaveLength(0);
		expect(session.participants().filter((s) => s.kind === 'human')).toHaveLength(0);
	});

	it('commits an arrival and wakes nobody, because no seat watches for one by default', async () => {
		const session = track(await open());
		const seen = collect(session);
		await session.visit(andrei);
		await waitForRoom(session);

		expect(await kinds(session)).toEqual(['arrived']);
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);
		expect(contexts).toHaveLength(0); // no seat was handed a context at all
	});

	it('wakes a seat that watches arrivals, and only that seat', async () => {
		const greeter = defineAgent({
			name: 'greeter',
			identity: 'Meets people.',
			instructions: 'greet',
			model: 'scripted/greeter',
		});
		const quiet2 = defineAgent({
			name: 'aside',
			identity: 'Named only.',
			instructions: 'wait',
			model: 'scripted/aside',
		});
		const session = track(
			await open({
				agents: [watcher, greeter, quiet2],
				seats: { [watcher.name]: 'broadcast', [greeter.name]: 'presence', [quiet2.name]: 'named' },
			}),
		);
		const seen = collect(session);
		await session.visit(andrei);
		await waitForRoom(session);

		const woke = seen.filter((e) => e.type === 'activation_start').map((e) => e.agent);
		expect(woke).toEqual(['greeter']); // not watcher, not the passive seat
		// the roster tells every seat which of them watches for this
		expect(contexts.at(-1)).toContain('- greeter (active, watches arrivals)');
		expect(contexts.at(-1)).toContain('- aside (idle, named only)');
	});

	it('steers a seat already at work, which is the whole of what presence routing does', async () => {
		const held = deferred();
		const seen: string[] = [];
		const holding = scripted(async (context) => {
			seen.push(contextText(context));
			await held.promise;
			return quiet();
		});
		const session = track(await open({ streamFn: holding }));
		const visit = await session.visit(andrei);
		await visit.send({ text: 'start something long' }); // watcher is now mid-activation
		await session.visit(mara); // arrives while it works
		held.resolve();
		await waitForRoom(session);

		// the arrival never woke a second activation; it landed inside the running one
		expect(await kinds(session)).toEqual(['arrived', 'said', 'arrived']);
		expect(seen.some((c) => c.includes('[new] · mara arrived'))).toBe(true);
	});

	it('carries no text on a presence message, and stamps from the visit', async () => {
		const session = track(await open());
		await session.visit(andrei);
		await waitForRoom(session);

		const arrival = (await session.messages())[0];
		expect(arrival).toMatchObject({ kind: 'arrived', from: 'andrei', subject: 'andrei' });
		expect(arrival && isSpoken(arrival)).toBe(false);
		expect(arrival && 'text' in arrival).toBe(false);
	});

	it('stamps two people from their own visits', async () => {
		const session = track(await open());
		const one = await session.visit(andrei);
		const two = await session.visit(mara);
		await one.send({ text: 'from andrei' });
		await two.send({ text: 'from mara' });
		await waitForRoom(session);

		const said = (await session.messages()).filter(isSpoken);
		expect(said.map((m) => [m.from, m.text])).toEqual([
			['andrei', 'from andrei'],
			['mara', 'from mara'],
		]);
	});

	it('holds one visit per person: a second visit is the same visit', async () => {
		const session = track(await open());
		const seen = collect(session);
		const terminal = await session.visit(andrei);
		const browser = await session.visit(andrei);
		await waitForRoom(session);
		expect(browser.human).toBe(terminal.human); // one person is in the room once, or not at all
		expect(await kinds(session)).toEqual(['arrived']); // the second visit committed nothing
		expect(presenceOf(session, 'andrei')).toBe('present');

		await terminal.leave();
		await waitForRoom(session);
		expect(presenceOf(session, 'andrei')).toBe('absent');
		expect(await kinds(session)).toEqual(['arrived', 'left']);
		// leaving is a message like any other, and the stream carries it
		const left = seen.filter((e) => e.type === 'message' && e.message.kind === 'left');
		expect(left).toHaveLength(1);
	});

	it('still addresses somebody who left, and remembers them across a run', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage });
		const name = roomName();
		const first = await startRoom({
			name,
			assistant,
			agents: [watcher],
			streamFn: recording,
			runtime,
		});
		const visit = await first.visit(andrei);
		await visit.send({ text: 'noting that I was here' });
		await waitForRoom(first);
		await visit.leave();
		await waitForRoom(first);
		expect(presenceOf(first, 'andrei')).toBe('absent');
		// absent, and still on the roster the agents read
		expect(contexts.at(-1)).toContain('andrei');
		await first.stop();

		const again = track(
			await startRoom({ name, assistant, agents: [watcher], streamFn: recording, runtime }),
		);
		await waitForRoom(again); // startRoom is synchronous; the replay is awaited here
		expect(presenceOf(again, 'andrei')).toBe('absent');
		expect(again.participants().find((s) => s.name === 'andrei')?.identity).toBe(andrei.identity);
	});

	it('refuses a stale visit, and takes leave() twice', async () => {
		const session = track(await open());
		const visit = await session.visit(andrei);
		await visit.leave();
		await expect(visit.leave()).resolves.toBeUndefined();
		await expect(visit.send({ text: 'hello?' })).rejects.toThrow(/has ended/);
	});

	it('anchors since at where a person stopped reading, and holds it while they read', async () => {
		const session = track(await open());
		const first = await session.visit(andrei);
		expect(first.since).toBeUndefined(); // never been here

		await first.send({ text: 'before' });
		await first.leave();
		await waitForRoom(session);
		const left = (await session.messages()).find((m) => m.kind === 'left');

		const again = await session.visit(andrei);
		expect(again.since).toBe(left?.seq);
		await again.send({ text: 'after' });
		expect(again.since).toBe(left?.seq); // it does not move while they read

		await again.leave();
		await waitForRoom(session);
		const second = (await session.messages()).filter((m) => m.kind === 'left').at(-1);
		const back = await session.visit(andrei);
		expect(back.since).toBe(second?.seq); // it moves when they leave again
	});

	it('reads only what followed a cursor, both kinds in order', async () => {
		const session = track(await open());
		const visit = await session.visit(andrei);
		await visit.send({ text: 'one' });
		await visit.leave();
		const left = (await session.messages()).find((m) => m.kind === 'left');
		const again = await session.visit(andrei);
		await again.send({ text: 'two' });
		await waitForRoom(session);

		const missed = await session.messages({ since: again.since });
		expect(missed.map((m) => m.kind)).toEqual(['arrived', 'said']);
		expect(missed.every((m) => m.seq > (left?.seq ?? 0))).toBe(true);
		expect(await session.messages()).toHaveLength(5);
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

	it('reads a name that is not running, and starts nothing', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage });
		const name = roomName();
		const session = await startRoom({
			name,
			assistant,
			agents: [watcher],
			streamFn: recording,
			runtime,
		});
		const visit = await session.visit(andrei);
		await visit.send({ text: 'for later' });
		await waitForRoom(session);
		await session.stop();

		const view = await readRoom(name, { runtime });
		expect(view.messages.filter(isSpoken).map((m) => m.text)).toEqual(['for later']);
		// the roster folds from the record, nothing stands up, and everybody the record knows is absent
		expect(
			view.participants.map((s) => [s.name, s.kind === 'agent' ? s.status : s.presence]),
		).toEqual([
			['watcher', 'idle'],
			['assistant', 'idle'],
			['andrei', 'absent'],
		]);
	});

	it('shows an agent the goal, the clock, and what each person has not seen', async () => {
		const session = track(await open({ goal: 'Ship payments v2 this quarter.' }));
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
		expect(back.since).toBeDefined();

		const view = contexts.at(-1) ?? '';
		expect(view).toContain('The time is');
		expect(view).toContain('- watcher (active): Watches the room.');
		expect(view).toContain('andrei (present');
		expect(view).toContain('has not seen the last');
		expect(view).toContain('── andrei has not seen anything below this line ──');
		expect(view).toContain('while andrei is away');
	});

	it('renders the goal only when set, and always tells a seat what a presence line is for', async () => {
		const withGoal = track(await open({ goal: 'Ship payments v2.' }));
		const gv = await withGoal.visit(andrei);
		await gv.send({ text: 'anything' }); // arrivals wake nobody, so ask
		await waitForRoom(withGoal);
		const prompted = lastSystemPrompt();
		expect(prompted).toContain('This room exists to: Ship payments v2.');
		expect(prompted).toContain('Who is reading can change while you work');

		prompts.length = 0;
		const without = track(await open());
		const wv = await without.visit(andrei);
		await wv.send({ text: 'anything' });
		await waitForRoom(without);
		const bare = lastSystemPrompt();
		expect(bare).not.toContain('This room exists to:');
		// the audience paragraph is about routing, not purpose, so it needs no goal
		expect(bare).toContain('Who is reading can change while you work');
		expect(await kinds(without)).toEqual(['arrived', 'said']);
	});
});

// -- a storage that fails ----------------------------------------------------

/** A room over a storage the test can break and mend. */
async function brittle(): Promise<{ session: Room; fail: FaultyJournals['fail'] }> {
	const faulty = faultyJournals((await memory.open()).storage);
	const runtime = createRuntime({ storage: faulty.journals });
	const session = await startRoom({
		name: roomName(),
		assistant,
		agents: [watcher],
		streamFn: recording,
		runtime,
	});
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
		expect(await session.messages()).toHaveLength(1);
		expect(seen.filter((e) => e.type === 'message')).toHaveLength(1);
		expect(seen.some((e) => e.type === 'activation_start')).toBe(false);

		// the queue carries on: a mended storage writes the next message, at the next
		// place. One counter gives out every place, so the fence and the composition
		// took the first two and the record starts at 3.
		fail(false);
		const kept = await visit.send({ text: 'kept' });
		expect(kept).toMatchObject({ owner: 'andrei', from: 4 });
		const record = await session.messages();
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
		await expect(session.messages()).resolves.toEqual(expect.any(Array));
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
		const record = await session.messages();
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
		const again = track(
			await startRoom({
				name: session.name,
				assistant,
				agents: [watcher],
				streamFn: recording,
				runtime: createRuntime(),
			}),
		);
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
			startRoom({
				name: roomName(),
				assistant,
				agents: [watcher],
				streamFn: recording,
				runtime: createRuntime({ storage: unreachable }),
			}),
		).rejects.toThrow(/unreachable/);

		await new Promise((resolve) => setImmediate(resolve));
		process.off('unhandledRejection', note);
		expect(loose).toHaveLength(0);
	});
});
