/**
 * A room resumed over its log continues where the last run stopped. What the
 * room held in memory is a fold over the log, so a crash loses nothing but
 * the run: the exchange, the roster, the people, the leases and the summary
 * still owed all fold back, on every storage.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	inProcessTransport,
	isSpoken,
	isSummary,
	type Runtime,
	readSession,
	resumeSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { collect, crash, deferred, roomName, rowsOf, tick } from './support/room.ts';
import {
	byAgent,
	quiet,
	type Script,
	says,
	scripted,
	summarise,
	toolNames,
} from './support/scripted.ts';
import { memory, type OpenedStorage, storages } from './support/storage.ts';
import { faultyTransport } from './support/transport.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	instructions: 'x',
	model: 'scripted/alpha',
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Beta.',
	instructions: 'x',
	model: 'scripted/beta',
});
const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });
const agents = [assistant, alpha, beta];

/** The assistant writes once when it holds `summarise`, or fails when told to. */
const writes =
	(text: string, failures = 0): Script =>
	(context, _name, call) => {
		if (!toolNames(context).includes('summarise')) return quiet();
		if (call <= failures) throw new Error('the model failed');
		return call === failures + 1 ? summarise(text) : quiet();
	};

interface World {
	opened: OpenedStorage;
	clock: FakeClock;
	/** A runtime over the storage. Each call is a new host over the same log. */
	runtime(faults?: Parameters<typeof faultyTransport>[1]): Runtime;
}

async function world(storage: (typeof storages)[number]): Promise<World> {
	const opened = await storage.open();
	const clock = fakeClock();
	return {
		opened,
		clock,
		runtime: (faults = []) =>
			createRuntime({
				sessions: opened.sessions,
				clock,
				agents,
				transport: faultyTransport(inProcessTransport(), faults, clock),
				// Every resume in this file folds over a checkpoint, not the rows it replaced.
				checkpoint: { rows: 3 },
			}),
	};
}

const summaries = async (session: Session) => (await session.messages()).filter(isSummary);

/** Resolves when this seat's next activation ends. */
const ended = (session: Session, seat: string) =>
	new Promise<void>((resolve) => {
		const off = session.subscribe((event) => {
			if (event.type !== 'activation_end' || event.agent !== seat) return;
			off();
			resolve();
		});
	});

describe.each(storages)('a room resumed on $name', (storage) => {
	it('continues an exchange with a lease live and a wake pending, and expires what never comes back', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const held = deferred();
			const script = byAgent({
				alpha: async (_c, _n, call) => {
					if (call === 1) await held.promise;
					return quiet();
				},
				beta: says(['beta one', 'beta two']),
				assistant: writes('The one message.'),
			});
			// beta's wake is lost on the way: at the crash it is still pending
			const first = runtime([
				{ on: 'wake', kind: 'drop', match: (w) => (w as { seat: string }).seat === 'beta' },
			]);
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha, beta],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Can I tell the client Thursday?' });
			await new Promise((resolve) => setImmediate(resolve));
			const before = { seats: session.seats(), exchange: session.exchange() };
			expect(before.seats.find((s) => s.name === 'alpha')).toMatchObject({ status: 'active' });
			expect(before.exchange).toMatchObject({ owner: 'priya' });
			crash(first, session);

			const second = runtime();
			const resumed = await resumeSession(name, { runtime: second, streamFn: scripted(script) });
			const events = collect(resumed);
			// the fold before the crash is the fold after the resume
			expect(resumed.seats()).toEqual(before.seats);
			expect(resumed.exchange()).toEqual(before.exchange);
			// the pending wake is sent again, and beta answers into the same exchange
			await ended(resumed, 'beta');
			expect((await resumed.messages()).filter(isSpoken).map((m) => m.from)).toEqual([
				'priya',
				'beta',
				'beta',
			]);
			expect(resumed.exchange()).toMatchObject({ owner: 'priya' });

			// alpha's lease is held by a run that is gone: it expires, alpha is woken
			// again after the backoff, and the exchange closes once alpha stands down
			held.resolve();
			await clock.advance(60_000);
			expect(events.some((e) => e.type === 'error' && e.agent === 'alpha')).toBe(true);
			expect(resumed.exchange()).toMatchObject({ owner: 'priya' });
			await clock.advance(30_000);
			await resumed.quiet();
			expect(
				events.filter((e) => e.type === 'activation_start' && e.agent === 'alpha'),
			).toHaveLength(1);
			expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
			expect(await summaries(resumed)).toHaveLength(1);
			expect(resumed.seats().find((s) => s.name === 'alpha')).toMatchObject({ status: 'idle' });
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('expires a lease that ran out while the room was down, and wakes the seat again', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const held = deferred();
			const script = byAgent({
				alpha: async (_c, _n, call) => {
					if (call === 1) await held.promise;
					return quiet();
				},
			});
			const first = runtime();
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anyone?' });
			await new Promise((resolve) => setImmediate(resolve));
			crash(first, session);
			held.resolve();

			await clock.advance(61_000);
			const resumed = await resumeSession(name, { runtime: runtime(), streamFn: scripted(script) });
			const events = collect(resumed);
			// the resume itself expired the lease: the wake it took is pending again,
			// so the exchange stays open until the seat is woken after the backoff
			expect(resumed.exchange()).toMatchObject({ owner: 'priya' });
			expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(0);
			await clock.advance(30_000);
			await resumed.quiet();
			expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(1);
			expect(resumed.exchange()).toBeUndefined();
			expect(resumed.seats().find((s) => s.name === 'alpha')).toMatchObject({ status: 'idle' });
			const rows = await rowsOf(opened.sessions, name);
			expect(rows.map((row) => row.type)).toContain('ambion/close');
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('writes one composition per run, and the latest roster wins', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const one = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			await one.messages();
			expect(one.seats().map((s) => s.name)).toEqual(['alpha', 'assistant']);
			await stopSession(one);

			const two = startSession({
				name,
				assistant,
				agents: [beta],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			await two.messages();
			expect(two.seats().map((s) => s.name)).toEqual(['beta', 'assistant']);
			await stopSession(two);

			const view = readSession(name, { runtime: runtime() });
			await view.messages();
			expect(view.seats().map((s) => s.name)).toEqual(['beta', 'assistant']);
		} finally {
			await opened.dispose();
		}
	});

	it('reads every identity off the log, in a process that holds no definition', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-identity-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				available: [beta],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			// before the replay, the seats fold from the row the run is about to write
			expect(session.seats().map((s) => [s.name, s.identity])).toEqual([
				['alpha', 'Alpha.'],
				['assistant', assistant.identity],
			]);
			await session.messages();
			await session.seat(beta);
			await session.quiet();
			await stopSession(session);

			// a fresh runtime knows no definition: the composition row and the seating carry them
			const view = readSession(name, { runtime: createRuntime({ sessions: opened.sessions }) });
			await view.messages();
			expect(view.seats().map((s) => [s.name, s.identity])).toEqual([
				['alpha', 'Alpha.'],
				['assistant', assistant.identity],
				['beta', 'Beta.'],
			]);
		} finally {
			await opened.dispose();
		}
	});

	it('leaves an open exchange to the next run, which closes it before it answers', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-exchange-${storage.name}`);
			const working = deferred();
			const one = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(
					byAgent({
						alpha: async () => {
							working.resolve();
							await new Promise(() => {});
							return quiet();
						},
					}),
				),
			});
			const heard = collect(one);
			const visit = await visitSession(one, priya);
			await visit.deliver({ text: 'Is anybody there?' });
			await working.promise;
			// a stop mid-exchange: the lease is revoked, and the stopped room closes nothing
			await stopSession(one);
			expect(heard.map((e) => e.type)).not.toContain('exchange_closed');
			const before = await rowsOf(opened.sessions, name);
			expect(before.map((row) => row.type)).not.toContain('ambion/close');

			// the next run closes it as it starts, and quiet() waits for that close
			const two = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			const events = collect(two);
			await two.quiet();
			// the close is on the stream when quiet() answers, before any other call replays the log
			expect(events.map((e) => e.type)).toContain('exchange_closed');
			expect(two.exchange()).toBeUndefined();
			const question = (await two.messages()).find((m) => m.kind === 'said');
			const closes = (await rowsOf(opened.sessions, name)).filter(
				(row) => row.type === 'ambion/close',
			);
			expect(closes).toHaveLength(1);
			expect(closes[0]?.data).toMatchObject({ owner: 'priya', from: question?.seq });
			await stopSession(two);
		} finally {
			await opened.dispose();
		}
	});

	it('keeps a person present across a crash, holds their identity while present, and frees it after leave', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const first = runtime();
			const session = startSession({
				name,
				assistant,
				runtime: first,
				streamFn: scripted(byAgent({})),
			});
			await visitSession(session, priya);
			await visitSession(session, sam);
			crash(first, session);

			const resumed = await resumeSession(name, {
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			// no `left` was written, so both are still present, and visiting again writes nothing
			expect(
				resumed
					.seats()
					.filter((s) => s.kind === 'human')
					.map((s) => [s.name, s.presence]),
			).toEqual([
				['priya', 'present'],
				['sam', 'present'],
			]);
			const again = await visitSession(resumed, priya);
			expect((await resumed.messages()).map((m) => m.kind)).toEqual(['arrived', 'arrived']);

			const renamed = defineHuman({ name: 'priya', identity: 'A different priya.' });
			await expect(visitSession(resumed, renamed)).rejects.toThrow(/different identity/);
			await again.leave();
			const back = await visitSession(resumed, renamed);
			expect(back.human.identity).toBe('A different priya.');
			expect((await resumed.messages()).map((m) => m.kind)).toEqual([
				'arrived',
				'arrived',
				'left',
				'arrived',
			]);
			expect(resumed.seats().find((s) => s.name === 'priya')).toMatchObject({
				identity: 'A different priya.',
			});
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('folds two closes owed to one person into one draft, and writes it after the backoff', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const script = byAgent({
				alpha: says(['alpha one', 'alpha two', 'alpha three']),
				beta: says(['beta one']),
				assistant: writes('Both questions, answered.', 1),
			});
			const name = roomName(`restart-${storage.name}`);
			const first = runtime();
			const session = startSession({
				name,
				assistant,
				agents: [alpha, beta],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'First?' });
			await session.quiet();
			// the first draft failed: priya is owed, and the room waits for the backoff
			expect(await summaries(session)).toHaveLength(0);
			await visit.deliver({ text: 'Second?' });
			await session.quiet();
			expect(await summaries(session)).toHaveLength(0);
			const record = await session.messages();
			const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
			crash(first, session);

			// the resumed room's assistant writes at the first draft it is given
			const writing = byAgent({ assistant: writes('Both questions, answered.') });
			const resumed = await resumeSession(name, {
				runtime: runtime(),
				streamFn: scripted(writing),
			});
			await resumed.quiet();
			expect(await summaries(resumed)).toHaveLength(0);
			await clock.advance(30_000);
			await resumed.quiet();
			const written = await summaries(resumed);
			expect(written).toHaveLength(1);
			// one message reaches back to the first question, and covers the second
			expect(written[0]?.covers.from).toBe(questions[0]?.seq);
			expect(written[0]?.covers.through).toBe((written[0]?.seq ?? 0) - 1);
			expect(written[0]?.to).toBe('priya');
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('writes off a draft the last run revoked at its stop, and goes quiet with nothing owed', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const drafting = deferred();
			const hangs: Script = (context) => {
				if (!toolNames(context).includes('summarise')) return quiet();
				drafting.resolve();
				return new Promise<never>(() => {});
			};
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({ alpha: says(['alpha one', 'alpha two']), assistant: hangs })),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'First?' });
			await drafting.promise;
			// the stop revokes the draft in flight: the host wrote the summary off
			await stopSession(session);

			const resumed = await resumeSession(name, {
				runtime: runtime(),
				streamFn: scripted(byAgent({ assistant: writes('Never written.') })),
			});
			const events = collect(resumed);
			await resumed.quiet();
			await clock.advance(120_000);
			await resumed.quiet();
			expect(await summaries(resumed)).toHaveLength(0);
			expect(events.filter((e) => e.type === 'activation_start')).toEqual([]);
			expect(resumed.exchange()).toBeUndefined();
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('cuts a lease the last run took, over a wire this run has not opened yet', async () => {
		const { opened, clock } = await world(storage);
		try {
			// the activation never answers, so the run the crash leaves behind
			// writes nothing after the test ends
			const script = byAgent({
				alpha: (_c, _n, call) =>
					call === 1 ? new Promise<never>(() => {}) : Promise.resolve(quiet()),
			});
			const name = roomName(`restart-${storage.name}`);
			const first = createRuntime({ sessions: opened.sessions, clock, agents });
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: first,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'Anyone?' });
			await tick();
			expect(session.seats().find((s) => s.name === 'alpha')).toMatchObject({ status: 'active' });
			crash(first, session);

			// the resumed run inherits the live lease and never wakes alpha, so it
			// holds no port for that seat when the abort revokes what it inherited
			const cuts: string[] = [];
			const inProcess = inProcessTransport();
			const second = createRuntime({
				sessions: opened.sessions,
				clock,
				agents,
				transport: {
					connect: (room, seat, host) => {
						const port = inProcess.connect(room, seat, host);
						return {
							wake: (wake) => port.wake(wake),
							cut: (activation) => {
								cuts.push(activation);
								return port.cut(activation);
							},
						};
					},
				},
			});
			const resumed = await resumeSession(name, { runtime: second, streamFn: scripted(script) });
			expect(resumed.seats().find((s) => s.name === 'alpha')).toMatchObject({ status: 'active' });
			resumed.abort();
			await resumed.settled();
			await tick();
			// the seat side hears the cut over the wire, and the room opened it to say so
			expect(cuts).toEqual(['2:alpha']);
			await stopSession(resumed);
		} finally {
			await opened.dispose();
		}
	});

	it('refuses to resume a name whose seats the catalog does not hold, and one with no composition', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime: runtime(),
				streamFn: scripted(byAgent({})),
			});
			await session.messages();
			await stopSession(session);
			const bare = createRuntime({ sessions: opened.sessions, clock: fakeClock() });
			await expect(resumeSession(name, { runtime: bare })).rejects.toThrow(
				/not in the runtime's catalog/,
			);
			await expect(
				resumeSession(roomName('never-started'), { runtime: runtime() }),
			).rejects.toThrow(/no composition/);
		} finally {
			await opened.dispose();
		}
	});
});

describe('a room dropped from memory', () => {
	/** A room with one activation held open, over a storage the test can read. */
	async function dropped() {
		const opened = await memory.open();
		const runtime = createRuntime({ clock: fakeClock(), sessions: opened.sessions });
		const held = deferred();
		const session = startSession({
			name: roomName('evicted'),
			assistant,
			agents: [alpha],
			runtime,
			streamFn: scripted(
				byAgent({
					alpha: async (_c, _n, call) => {
						if (call !== 1) return quiet();
						await held.promise;
						return quiet();
					},
				}),
			),
		});
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'go' });
		await tick();
		runtime.evict(session.name);
		return { session, visit, opened, held };
	}

	it('answers quiet() and settled() at once', async () => {
		const { session, held } = await dropped();
		await expect(session.quiet()).resolves.toBeUndefined();
		await expect(session.settled()).resolves.toBeUndefined();
		held.resolve();
	});

	it('writes nothing for an abort or a departure on the dropped handle', async () => {
		const { session, visit, opened, held } = await dropped();
		await tick();
		const before = (await rowsOf(opened.sessions, session.name)).length;
		session.abort();
		await tick();
		await tick();
		await visit.leave();
		await tick();
		expect((await rowsOf(opened.sessions, session.name)).length).toBe(before);
		await expect(visit.deliver({ text: 'still there?' })).rejects.toThrow();
		held.resolve();
	});

	it('releases whoever was already waiting on quiet() or settled()', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({ clock: fakeClock(), sessions: opened.sessions });
		const held = deferred();
		const session = startSession({
			name: roomName('evicted-waiting'),
			assistant,
			agents: [alpha],
			runtime,
			streamFn: scripted(
				byAgent({
					alpha: async (_c, _n, call) => {
						if (call !== 1) return quiet();
						await held.promise;
						return quiet();
					},
				}),
			),
		});
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'go' });
		// both wait while the room is up, and the eviction lands before either has parked
		const waiting = Promise.all([session.quiet(), session.settled()]);
		runtime.evict(session.name);
		await expect(waiting).resolves.toEqual([undefined, undefined]);
		held.resolve();
	});

	it('writes nothing for a stop on the dropped handle', async () => {
		const { session, opened, held } = await dropped();
		await tick();
		const before = (await rowsOf(opened.sessions, session.name)).length;
		await stopSession(session);
		await tick();
		expect((await rowsOf(opened.sessions, session.name)).length).toBe(before);
		held.resolve();
	});
});
