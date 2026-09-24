/**
 * A room resumed over its journal continues where the last run stopped. What the
 * room held in memory is a fold over the journal, so a crash loses nothing but
 * the run: the exchange, the roster, the leases and the summary still owed all
 * fold back, on every storage.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { hostingOf, inProcessTransport } from '../src/hosting.ts';
import {
	type AgentDefinition,
	type AmbionErrorCode,
	createRuntime,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from '../src/testing.ts';
import {
	assistant,
	assistantEnded,
	collect,
	crash,
	currentExchange,
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	scriptedAgent,
	storedOf,
	tick,
	waitForRoom,
} from './support/room.ts';
import {
	byAgent,
	isClosing,
	quiet,
	type Script,
	says,
	scripted,
	summarise,
} from './support/scripted.ts';
import { memory, type OpenedStorage, storages } from './support/storage.ts';
import { faultyTransport } from './support/transport.ts';

const alpha = scriptedAgent('alpha', 'Alpha.');
const beta = scriptedAgent('beta', 'Beta.');
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const agents = [alpha, beta, assistant];

/** The assistant writes once when it holds `summarise`, or fails when told to. */
const writes =
	(text: string, failures = 0): Script =>
	(context, _name, call) => {
		if (!isClosing(context)) return quiet();
		if (call <= failures) throw new Error('the model failed');
		return call === failures + 1 ? summarise(text) : quiet();
	};

/** A seat that holds its first activation until the promise settles, then stays quiet. */
const holds =
	(until: Promise<unknown>): Script =>
	async (_c, _n, call) => {
		if (call === 1) await until;
		return quiet();
	};

interface World {
	opened: OpenedStorage;
	clock: FakeClock;
	/** A runtime over the storage. Each call is a new host over the same journal. */
	runtime(faults?: Parameters<typeof faultyTransport>[1]): Runtime;
}

/** The storage stays open until the test ends, after every room the test stops. */
async function world(storage: (typeof storages)[number]): Promise<World> {
	const opened = await storage.open();
	onTestFinished(() => opened.dispose());
	const clock = fakeClock();
	return {
		opened,
		clock,
		runtime: (faults = []) =>
			createRuntime({
				storage: opened.storage,
				clock,
				transport: faultyTransport(inProcessTransport(), faults, clock),
			}),
	};
}

/** Start a room over every definition, with the assistant on summaries and each of `seated` on broadcast. */
function open(
	runtime: Runtime,
	name: string,
	script: Script = byAgent({}),
	seated: AgentDefinition[] = [alpha],
): Promise<Room> {
	return startRoom({
		name,
		summary: assistant.name,
		seats: {
			...Object.fromEntries(seated.map((agent) => [agent.name, 'broadcast'] as const)),
			[assistant.name]: 'none',
		},
		agents,
		runtime,
		execution: piExecution({ sessions: 'memory', stream: scripted(script) }),
	});
}

const resume = (name: string, runtime: Runtime, script: Script = byAgent({})) =>
	resumeRoom(name, {
		runtime,
		agents,
		execution: piExecution({ sessions: 'memory', stream: scripted(script) }),
	});

const summaries = async (session: Room) => (await messagesOf(session)).filter(isSummary);
const seat = async (session: Room, name: string) =>
	(await participantsOf(session)).find((s) => s.name === name);
const starts = (events: ReturnType<typeof collect>, agent: string) =>
	events.filter((e) => e.type === 'activation_start' && e.agent === agent);

/** Resolves when this seat's next activation ends. */
const ended = (session: Room, name: string) =>
	new Promise<void>((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'activation_end' || event.agent !== name) return;
			off();
			resolve();
		});
	});

describe.each(storages)('a room resumed on $name', (storage) => {
	it('continues an exchange with a lease live and a wake pending, and expires what never comes back', async () => {
		const { clock, runtime } = await world(storage);
		const held = deferred();
		const script = byAgent({
			alpha: holds(held.promise),
			beta: says(['beta one', 'beta two']),
			assistant: writes('The one message.'),
		});
		// beta's wake is lost on the way: at the crash it is still pending
		const first = runtime([
			{ on: 'wake', kind: 'drop', match: (w) => (w as { seat: string }).seat === 'beta' },
		]);
		const name = roomName(`restart-${storage.name}`);
		const session = await open(first, name, script, [alpha, beta]);
		const visit = await session.visit(priya);
		await visit.send({ text: 'Can I tell the client Thursday?' });
		await new Promise((resolve) => setImmediate(resolve));
		const participants = await participantsOf(session);
		const exchange = await currentExchange(session);
		expect(participants.find((s) => s.name === 'alpha')).toMatchObject({ status: 'active' });
		expect(exchange).toMatchObject({ owner: 'priya' });
		crash(first, session);

		const resumed = await resume(name, runtime(), script);
		const events = collect(resumed);
		// the fold before the crash is the fold after the resume
		expect(await participantsOf(resumed)).toEqual(participants);
		expect(await currentExchange(resumed)).toEqual(exchange);
		// the pending wake is sent again, and beta answers into the same exchange
		await ended(resumed, 'beta');
		expect((await messagesOf(resumed)).filter(isSpoken).map((m) => m.from)).toEqual([
			'priya',
			'beta',
			'beta',
		]);
		expect(await currentExchange(resumed)).toMatchObject({ owner: 'priya' });

		// alpha's lease is held by a run that is gone: it expires, alpha is woken
		// again after the backoff, and the exchange closes once alpha stands down
		held.resolve();
		await clock.advance(60_000);
		expect(events.some((e) => e.type === 'error' && e.agent === 'alpha')).toBe(true);
		expect(await currentExchange(resumed)).toMatchObject({ owner: 'priya' });
		await clock.advance(30_000);
		await waitForRoom(resumed);
		expect(starts(events, 'alpha')).toHaveLength(1);
		expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
		expect(await summaries(resumed)).toHaveLength(1);
		expect(await seat(resumed, 'alpha')).toMatchObject({ status: 'idle' });
		await resumed.stop();
	});

	it('expires a lease that ran out while the room was down, and wakes the seat again', async () => {
		const { opened, clock, runtime } = await world(storage);
		const held = deferred();
		const script = byAgent({ alpha: holds(held.promise) });
		const first = runtime();
		const name = roomName(`restart-${storage.name}`);
		const session = await open(first, name, script);
		const visit = await session.visit(priya);
		await visit.send({ text: 'Anyone?' });
		await new Promise((resolve) => setImmediate(resolve));
		crash(first, session);
		held.resolve();

		await clock.advance(61_000);
		const resumed = await resume(name, runtime(), script);
		const events = collect(resumed);
		// the resume itself expired the lease: the wake it took is pending again,
		// so the exchange stays open until the seat is woken after the backoff
		expect(await currentExchange(resumed)).toMatchObject({ owner: 'priya' });
		expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(0);
		await clock.advance(30_000);
		await waitForRoom(resumed);
		expect(starts(events, 'alpha')).toHaveLength(1);
		expect(await currentExchange(resumed)).toBeUndefined();
		expect(await seat(resumed, 'alpha')).toMatchObject({ status: 'idle' });
		const stored = await storedOf(opened.journals, name);
		expect(stored.map((entry) => entry.kind)).toContain('close');
		await resumed.stop();
	});

	it('reads every identity off the journal in a process with no definition, and the latest roster wins', async () => {
		const { opened, runtime } = await world(storage);
		const name = roomName(`restart-identity-${storage.name}`);
		const one = await open(runtime(), name);
		// before the replay, the seats fold from the composition the run is about to write
		expect((await participantsOf(one)).map((s) => [s.name, s.identity])).toEqual([
			['alpha', 'Alpha.'],
			['assistant', assistant.identity],
		]);
		await waitForRoom(one, 'settled');
		await one.seat(beta.name);
		await waitForRoom(one);
		await one.stop();

		// a fresh runtime knows no definition: the composition and the seating carry them
		const view = await readRoom(name, { runtime: createRuntime({ storage: opened.storage }) });
		view.messages;
		expect(view.participants.map((s) => [s.name, s.identity])).toEqual([
			['alpha', 'Alpha.'],
			['assistant', assistant.identity],
			['beta', 'Beta.'],
		]);

		// each run writes its own composition, and the next run's roster replaces it
		const two = await open(runtime(), name, byAgent({}), [beta]);
		await waitForRoom(two);
		expect((await participantsOf(two)).map((s) => s.name)).toEqual(['beta', 'assistant']);
		await two.stop();
		const latest = await readRoom(name, { runtime: runtime() });
		expect(latest.participants.map((s) => s.name)).toEqual(['beta', 'assistant']);
	});

	it('leaves an open exchange to the next run, which closes it before it answers', async () => {
		const { opened, runtime } = await world(storage);
		const name = roomName(`restart-exchange-${storage.name}`);
		const working = deferred();
		const one = await open(
			runtime(),
			name,
			byAgent({
				alpha: async () => {
					working.resolve();
					await new Promise(() => {});
					return quiet();
				},
			}),
		);
		const heard = collect(one);
		const visit = await one.visit(priya);
		await visit.send({ text: 'Is anybody there?' });
		await working.promise;
		// a stop mid-exchange: the lease is revoked, and the stopped room closes nothing
		await one.stop();
		expect(heard.map((e) => e.type)).not.toContain('exchange_closed');
		const before = await storedOf(opened.journals, name);
		expect(before.map((entry) => entry.kind)).not.toContain('close');

		// the next run closes it as it starts, and quiet() waits for that close
		const two = await open(runtime(), name);
		await waitForRoom(two);
		// Startup may durably close before subscribers attach; the journal assertion below is authoritative.
		expect(await currentExchange(two)).toBeUndefined();
		const question = (await messagesOf(two)).find((m) => m.kind === 'said');
		const closes = (await storedOf(opened.journals, name)).filter(
			(entry) => entry.kind === 'close',
		);
		expect(closes).toHaveLength(1);
		expect(closes[0]?.body).toMatchObject({ owner: 'priya', from: question?.seq });
		await two.stop();
	});

	it('keeps an owed close after a restart', async () => {
		const { clock, runtime } = await world(storage);
		const script = byAgent({
			alpha: says(['alpha one', 'alpha two', 'alpha three']),
			beta: says(['beta one']),
			assistant: writes('Both questions, answered.', 2),
		});
		const name = roomName(`restart-${storage.name}`);
		const first = runtime();
		const session = await open(first, name, script, [alpha, beta]);
		const visit = await session.visit(priya);
		const drafted = assistantEnded(session);
		await visit.send({ text: 'First?' });
		// a room that owes a draft is not quiet, so the failed attempt is the wait
		await drafted;
		// the first draft failed: priya is owed, and the room waits for the backoff
		expect(await summaries(session)).toHaveLength(0);
		await visit.send({ text: 'Second?' });
		await waitForRoom(session, 'settled');
		expect(await summaries(session)).toHaveLength(0);
		const questions = (await messagesOf(session)).filter((m) => isSpoken(m) && m.from === 'priya');
		crash(first, session);

		// the resumed room's assistant writes at the first draft it is given
		const resumed = await resume(
			name,
			runtime(),
			byAgent({ assistant: writes('Both questions, answered.') }),
		);
		// the resumed room takes on the draft the first run left owed, so it is
		// not quiet either: it settled, and the backoff has not passed
		await waitForRoom(resumed, 'settled');
		expect(await summaries(resumed)).toHaveLength(0);
		await clock.advance(30_000);
		await waitForRoom(resumed);
		const written = await summaries(resumed);
		expect(written).toHaveLength(1);
		expect(written[0]?.covers.from).toBe(questions[0]?.seq);
		const second = questions[1];
		if (second === undefined) throw new Error('Expected the later question.');
		expect(written[0]?.covers.through).toBeLessThan(second.seq);
		expect(written[0]?.to).toBe('priya');
		await resumed.stop();
	});

	it('writes off a draft the last run revoked at its stop, and goes quiet with nothing owed', async () => {
		const { clock, runtime } = await world(storage);
		const drafting = deferred();
		const hangs: Script = (context) => {
			if (!isClosing(context)) return quiet();
			drafting.resolve();
			return new Promise<never>(() => {});
		};
		const name = roomName(`restart-${storage.name}`);
		const session = await open(
			runtime(),
			name,
			byAgent({ alpha: says(['alpha one', 'alpha two']), assistant: hangs }),
		);
		const visit = await session.visit(priya);
		await visit.send({ text: 'First?' });
		await drafting.promise;
		// the stop revokes the draft in flight: the host wrote the summary off
		await session.stop();

		const resumed = await resume(name, runtime(), byAgent({ assistant: writes('Never written.') }));
		const events = collect(resumed);
		await waitForRoom(resumed);
		await clock.advance(120_000);
		await waitForRoom(resumed);
		expect(await summaries(resumed)).toHaveLength(0);
		expect(events.filter((e) => e.type === 'activation_start')).toEqual([]);
		expect(await currentExchange(resumed)).toBeUndefined();
		await resumed.stop();
	});

	it('cuts a lease the last run took, over a wire this run has not opened yet', async () => {
		const { opened, clock } = await world(storage);
		// the activation never answers, so the run the crash leaves behind
		// writes nothing after the test ends
		const script = byAgent({ alpha: holds(new Promise<never>(() => {})) });
		const name = roomName(`restart-${storage.name}`);
		const first = createRuntime({ storage: opened.storage, clock });
		const session = await open(first, name, script);
		const visit = await session.visit(priya);
		await visit.send({ text: 'Anyone?' });
		await tick();
		expect(await seat(session, 'alpha')).toMatchObject({ status: 'active' });
		crash(first, session);

		// the resumed run inherits the live lease and never wakes alpha, so it
		// holds no port for that seat when the abort revokes what it inherited
		const cuts: string[] = [];
		const inProcess = inProcessTransport();
		const second = createRuntime({
			storage: opened.storage,
			clock,
			transport: {
				connect: (room, context) => {
					const port = inProcess.connect(room, context);
					return {
						wake: (wake) => port.wake(wake),
						steer: (steer) => port.steer(steer),
						cut: (activation) => {
							cuts.push(activation);
							return port.cut(activation);
						},
					};
				},
			},
		});
		const resumed = await resume(name, second, script);
		expect(await seat(resumed, 'alpha')).toMatchObject({ status: 'active' });
		await resumed.abort();
		await waitForRoom(resumed);
		await tick();
		// the seat side hears the cut over the wire, and the room opened it to say so
		expect(cuts).toEqual(['message:4:alpha:1']);
		await resumed.stop();
	});

	it('refuses to resume a name whose seats the catalog does not hold, and one with no composition', async () => {
		const { opened, runtime } = await world(storage);
		const name = roomName(`restart-${storage.name}`);
		const session = await open(runtime(), name);
		await waitForRoom(session);
		await session.stop();
		const bare = createRuntime({ storage: opened.storage, clock: fakeClock() });
		const refused = (code: AmbionErrorCode, message: RegExp) =>
			expect.objectContaining({
				name: 'AmbionError',
				code,
				message: expect.stringMatching(message),
			});
		await expect(resumeRoom(name, { runtime: bare, agents: [] })).rejects.toEqual(
			refused('missing_definition', /cannot resume: agent 'alpha' has no binding/),
		);
		await expect(resumeRoom(name, { runtime: bare, agents: [alpha, alpha] })).rejects.toEqual(
			refused('duplicate_name', /Duplicate agent name 'alpha'/),
		);
		await expect(
			resumeRoom(roomName('never-started'), { runtime: runtime(), agents: [] }),
		).rejects.toEqual(refused('no_composition', /no composition/));
	});
});

describe('a room dropped from memory', () => {
	async function evictable() {
		const opened = await memory.open();
		const runtime = createRuntime({ storage: opened.storage, clock: fakeClock() });
		return { opened, runtime, evict: (name: string) => hostingOf(runtime).evict(name) };
	}

	/**
	 * `seats()` answers off the composition, and never off the room's phase.
	 * A room dropped before it wrote anything wrote no composition, so it
	 * answers with the one it was given: a host reads the room it asked for
	 * whatever happened to the run.
	 */
	it('answers with the composition it was given, dropped before it wrote one', async () => {
		const { runtime, evict } = await evictable();
		const name = roomName('evicted-early');
		const session = await open(runtime, name, byAgent({}), [alpha, beta]);
		evict(name);
		expect((await participantsOf(session)).map((s) => s.name)).toEqual([
			'alpha',
			'beta',
			'assistant',
		]);
	});

	it.each([
		['at once', false],
		['after the activation starts', true],
	])(
		'rejects the exchange wait and writes nothing for an abort, a departure or a stop, evicted %s',
		async (_, started) => {
			const { opened, runtime, evict } = await evictable();
			const held = deferred();
			onTestFinished(held.resolve);
			const session = await open(
				runtime,
				roomName('evicted'),
				byAgent({ alpha: holds(held.promise) }),
			);
			const visit = await session.visit(priya);
			const exchange = await visit.send({ text: 'go' });
			if (started) await tick();
			evict(session.name);
			await expect(exchange.waitForClose()).rejects.toThrow(/stopped|interrupted|evicted/i);

			await tick();
			const before = (await storedOf(opened.journals, session.name)).length;
			await expect(session.abort()).rejects.toThrow(/evicted|stopped|interrupted/i);
			await tick();
			await tick();
			await visit.leave();
			await tick();
			await expect(visit.send({ text: 'still there?' })).rejects.toThrow();
			await session.stop();
			await tick();
			expect((await storedOf(opened.journals, session.name)).length).toBe(before);
		},
	);
});
