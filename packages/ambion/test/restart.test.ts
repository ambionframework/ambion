/**
 * A room resumed over its journal continues where the last run stopped. What the
 * room held in memory is a fold over the journal, so a crash loses nothing but
 * the run: the exchange, the roster, the people, the leases and the summary
 * still owed all fold back, on every storage.
 */
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { hostingOf, inProcessTransport } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { refusal } from './support/errors.ts';
import {
	assistantEnded,
	collect,
	crash,
	currentExchange,
	deferred,
	messagesOf,
	participantsOf,
	roomName,
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

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	executor: pi({ instructions: 'Answer what was asked, once.', model: 'scripted/assistant' }),
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	executor: pi({ instructions: 'x', model: 'scripted/alpha' }),
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Beta.',
	executor: pi({ instructions: 'x', model: 'scripted/beta' }),
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
		if (!isClosing(context)) return quiet();
		if (call <= failures) throw new Error('the model failed');
		return call === failures + 1 ? summarise(text) : quiet();
	};

interface World {
	opened: OpenedStorage;
	clock: FakeClock;
	/** A runtime over the storage. Each call is a new host over the same journal. */
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
				storage: opened.storage,
				clock,
				transport: faultyTransport(inProcessTransport(), faults, clock),
			}),
	};
}

const summaries = async (session: Room) => (await messagesOf(session)).filter(isSummary);

/** Resolves when this seat's next activation ends. */
const ended = (session: Room, seat: string) =>
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
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, beta, assistant],
				runtime: first,
				execution: piExecution({ stream: scripted(script) }),
			});
			const visit = await session.visit(priya);
			await visit.send({ text: 'Can I tell the client Thursday?' });
			await new Promise((resolve) => setImmediate(resolve));
			const before = {
				participants: await participantsOf(session),
				exchange: await currentExchange(session),
			};
			expect(before.participants.find((s) => s.name === 'alpha')).toMatchObject({
				status: 'active',
			});
			expect(before.exchange).toMatchObject({ owner: 'priya' });
			crash(first, session);

			const second = runtime();
			const resumed = await resumeRoom(name, {
				runtime: second,
				agents,
				execution: piExecution({ stream: scripted(script) }),
			});
			const events = collect(resumed);
			// the fold before the crash is the fold after the resume
			expect(await participantsOf(resumed)).toEqual(before.participants);
			expect(await currentExchange(resumed)).toEqual(before.exchange);
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
			expect(
				events.filter((e) => e.type === 'activation_start' && e.agent === 'alpha'),
			).toHaveLength(1);
			expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
			expect(await summaries(resumed)).toHaveLength(1);
			expect((await participantsOf(resumed)).find((s) => s.name === 'alpha')).toMatchObject({
				status: 'idle',
			});
			await resumed.stop();
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
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: first,
				execution: piExecution({ stream: scripted(script) }),
			});
			const visit = await session.visit(priya);
			await visit.send({ text: 'Anyone?' });
			await new Promise((resolve) => setImmediate(resolve));
			crash(first, session);
			held.resolve();

			await clock.advance(61_000);
			const resumed = await resumeRoom(name, {
				runtime: runtime(),
				agents,
				execution: piExecution({ stream: scripted(script) }),
			});
			const events = collect(resumed);
			// the resume itself expired the lease: the wake it took is pending again,
			// so the exchange stays open until the seat is woken after the backoff
			expect(await currentExchange(resumed)).toMatchObject({ owner: 'priya' });
			expect(events.filter((e) => e.type === 'activation_start')).toHaveLength(0);
			await clock.advance(30_000);
			await waitForRoom(resumed);
			expect(
				events.filter((e) => e.type === 'activation_start' && e.agent === 'alpha'),
			).toHaveLength(1);
			expect(await currentExchange(resumed)).toBeUndefined();
			expect((await participantsOf(resumed)).find((s) => s.name === 'alpha')).toMatchObject({
				status: 'idle',
			});
			const stored = await storedOf(opened.journals, name);
			expect(stored.map((entry) => entry.kind)).toContain('close');
			await resumed.stop();
		} finally {
			await opened.dispose();
		}
	});

	it('writes one composition per run, and the latest roster wins', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const one = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: runtime(),
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
			await waitForRoom(one);
			expect((await participantsOf(one)).map((s) => s.name)).toEqual(['alpha', 'assistant']);
			await one.stop();

			const two = await startRoom({
				name,
				summary: assistant.name,
				seats: { [beta.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [beta, assistant],
				runtime: runtime(),
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
			await waitForRoom(two);
			expect((await participantsOf(two)).map((s) => s.name)).toEqual(['beta', 'assistant']);
			await two.stop();

			const view = await readRoom(name, { runtime: runtime() });
			view.messages;
			expect(view.participants.map((s) => s.name)).toEqual(['beta', 'assistant']);
		} finally {
			await opened.dispose();
		}
	});

	it('reads every identity off the journal, in a process that holds no definition', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-identity-${storage.name}`);
			const session = await startRoom({
				name,
				summary: assistant.name,
				agents: [alpha, beta, assistant],
				seats: { [assistant.name]: 'none', [alpha.name]: 'broadcast' },
				runtime: runtime(),
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
			// before the replay, the seats fold from the composition the run is about to write
			expect((await participantsOf(session)).map((s) => [s.name, s.identity])).toEqual([
				['alpha', 'Alpha.'],
				['assistant', assistant.identity],
			]);
			await waitForRoom(session, 'settled');
			await session.seat(beta.name);
			await waitForRoom(session);
			await session.stop();

			// a fresh runtime knows no definition: the composition and the seating carry them
			const view = await readRoom(name, {
				runtime: createRuntime({ storage: opened.storage }),
			});
			view.messages;
			expect(view.participants.map((s) => [s.name, s.identity])).toEqual([
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
			const one = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: runtime(),
				execution: piExecution({
					stream: scripted(
						byAgent({
							alpha: async () => {
								working.resolve();
								await new Promise(() => {});
								return quiet();
							},
						}),
					),
				}),
			});
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
			const two = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: runtime(),
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
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
		} finally {
			await opened.dispose();
		}
	});

	it('keeps a person present across a crash, holds their identity while present, and frees it after leave', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const first = runtime();
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [assistant.name]: 'none' },
				agents: [assistant],
				runtime: first,
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
			await session.visit(priya);
			await session.visit(sam);
			crash(first, session);

			const resumed = await resumeRoom(name, {
				runtime: runtime(),
				agents,
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
			// no `left` was written, so both are still present, and visiting again writes nothing
			expect(
				(await participantsOf(resumed))
					.filter((s) => s.kind === 'human')
					.map((s) => [s.name, s.presence]),
			).toEqual([
				['priya', 'present'],
				['sam', 'present'],
			]);
			const again = await resumed.visit(priya);
			expect((await messagesOf(resumed)).map((m) => m.kind)).toEqual(['arrived', 'arrived']);

			const renamed = defineHuman({ name: 'priya', identity: 'A different priya.' });
			await expect(resumed.visit(renamed)).rejects.toThrow(/different identity/);
			await again.leave();
			const back = await resumed.visit(renamed);
			expect(back.human.identity).toBe('A different priya.');
			expect((await messagesOf(resumed)).map((m) => m.kind)).toEqual([
				'arrived',
				'arrived',
				'left',
				'arrived',
			]);
			expect((await participantsOf(resumed)).find((s) => s.name === 'priya')).toMatchObject({
				identity: 'A different priya.',
			});
			await resumed.stop();
		} finally {
			await opened.dispose();
		}
	});

	it('keeps an owed close after a restart', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const script = byAgent({
				alpha: says(['alpha one', 'alpha two', 'alpha three']),
				beta: says(['beta one']),
				assistant: writes('Both questions, answered.', 2),
			});
			const name = roomName(`restart-${storage.name}`);
			const first = runtime();
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, beta, assistant],
				runtime: first,
				execution: piExecution({ stream: scripted(script) }),
			});
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
			const record = await messagesOf(session);
			const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
			crash(first, session);

			// the resumed room's assistant writes at the first draft it is given
			const writing = byAgent({ assistant: writes('Both questions, answered.') });
			const resumed = await resumeRoom(name, {
				runtime: runtime(),
				agents,
				execution: piExecution({ stream: scripted(writing) }),
			});
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
			expect(second).toBeDefined();
			if (second === undefined) throw new Error('Expected the later question.');
			expect(written[0]?.covers.through).toBeLessThan(second.seq);
			expect(written[0]?.to).toBe('priya');
			await resumed.stop();
		} finally {
			await opened.dispose();
		}
	});

	it('writes off a draft the last run revoked at its stop, and goes quiet with nothing owed', async () => {
		const { opened, clock, runtime } = await world(storage);
		try {
			const drafting = deferred();
			const hangs: Script = (context) => {
				if (!isClosing(context)) return quiet();
				drafting.resolve();
				return new Promise<never>(() => {});
			};
			const name = roomName(`restart-${storage.name}`);
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: runtime(),
				execution: piExecution({
					stream: scripted(byAgent({ alpha: says(['alpha one', 'alpha two']), assistant: hangs })),
				}),
			});
			const visit = await session.visit(priya);
			await visit.send({ text: 'First?' });
			await drafting.promise;
			// the stop revokes the draft in flight: the host wrote the summary off
			await session.stop();

			const resumed = await resumeRoom(name, {
				runtime: runtime(),
				agents,
				execution: piExecution({
					stream: scripted(byAgent({ assistant: writes('Never written.') })),
				}),
			});
			const events = collect(resumed);
			await waitForRoom(resumed);
			await clock.advance(120_000);
			await waitForRoom(resumed);
			expect(await summaries(resumed)).toHaveLength(0);
			expect(events.filter((e) => e.type === 'activation_start')).toEqual([]);
			expect(await currentExchange(resumed)).toBeUndefined();
			await resumed.stop();
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
			const first = createRuntime({
				storage: opened.storage,
				clock,
			});
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: first,
				execution: piExecution({ stream: scripted(script) }),
			});
			const visit = await session.visit(priya);
			await visit.send({ text: 'Anyone?' });
			await tick();
			expect((await participantsOf(session)).find((s) => s.name === 'alpha')).toMatchObject({
				status: 'active',
			});
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
			const resumed = await resumeRoom(name, {
				runtime: second,
				agents,
				execution: piExecution({ stream: scripted(script) }),
			});
			expect((await participantsOf(resumed)).find((s) => s.name === 'alpha')).toMatchObject({
				status: 'active',
			});
			await resumed.abort();
			await waitForRoom(resumed);
			await tick();
			// the seat side hears the cut over the wire, and the room opened it to say so
			expect(cuts).toEqual(['message:4:alpha:1']);
			await resumed.stop();
		} finally {
			await opened.dispose();
		}
	});

	it('refuses to resume a name whose seats the catalog does not hold, and one with no composition', async () => {
		const { opened, runtime } = await world(storage);
		try {
			const name = roomName(`restart-${storage.name}`);
			const session = await startRoom({
				name,
				summary: assistant.name,
				seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
				agents: [alpha, assistant],
				runtime: runtime(),
				execution: piExecution({ stream: scripted(byAgent({})) }),
			});
			await waitForRoom(session);
			await session.stop();
			const bare = createRuntime({
				storage: opened.storage,
				clock: fakeClock(),
			});
			await expect(resumeRoom(name, { runtime: bare, agents: [] })).rejects.toThrow(
				/cannot resume: agent 'alpha' has no binding/,
			);
			await expect(resumeRoom(name, { runtime: bare, agents: [] })).rejects.toEqual(
				refusal('missing_definition'),
			);
			await expect(resumeRoom(name, { runtime: bare, agents: [alpha, alpha] })).rejects.toThrow(
				/Duplicate agent name 'alpha'/,
			);
			await expect(resumeRoom(name, { runtime: bare, agents: [alpha, alpha] })).rejects.toEqual(
				refusal('duplicate_name'),
			);
			await expect(
				resumeRoom(roomName('never-started'), { runtime: runtime(), agents: [] }),
			).rejects.toThrow(/no composition/);
			await expect(
				resumeRoom(roomName('never-started'), { runtime: runtime(), agents: [] }),
			).rejects.toEqual(refusal('no_composition'));
		} finally {
			await opened.dispose();
		}
	});
});

describe('a room dropped from memory', () => {
	/**
	 * `seats()` answers off the composition, and never off the room's phase.
	 * A room dropped before it wrote anything wrote no composition, so it
	 * answers with the one it was given: a host reads the room it asked for
	 * whatever happened to the run.
	 */
	it('answers with the composition it was given, dropped before it wrote one', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
		});
		const name = roomName('evicted-early');
		const session = await startRoom({
			name,
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alpha, beta, assistant],
			runtime,
			execution: piExecution({ stream: scripted(byAgent({})) }),
		});
		hostingOf(runtime).evict(name);
		expect((await participantsOf(session)).map((s) => s.name)).toEqual([
			'alpha',
			'beta',
			'assistant',
		]);
		await opened.dispose();
	});

	/** A room with one activation held open, over a storage the test can read. */
	async function dropped() {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
		});
		const held = deferred();
		const session = await startRoom({
			name: roomName('evicted'),
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alpha, assistant],
			runtime,
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: async (_c, _n, call) => {
							if (call !== 1) return quiet();
							await held.promise;
							return quiet();
						},
					}),
				),
			}),
		});
		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'go' });
		await tick();
		hostingOf(runtime).evict(session.name);
		return { session, visit, exchange, opened, held };
	}

	it('rejects an exchange messages wait when runtime evicts the room', async () => {
		const { exchange, held } = await dropped();
		await expect(exchange.waitForClose()).rejects.toThrow(/stopped|interrupted|evicted/i);
		held.resolve();
	});

	it('writes nothing for an abort or a departure on the dropped handle', async () => {
		const { session, visit, opened, held } = await dropped();
		await tick();
		const before = (await storedOf(opened.journals, session.name)).length;
		await expect(session.abort()).rejects.toThrow(/evicted|stopped|interrupted/i);
		await tick();
		await tick();
		await visit.leave();
		await tick();
		expect((await storedOf(opened.journals, session.name)).length).toBe(before);
		await expect(visit.send({ text: 'still there?' })).rejects.toThrow();
		held.resolve();
	});

	it('rejects an exchange messages wait after eviction', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
		});
		const held = deferred();
		const session = await startRoom({
			name: roomName('evicted-waiting'),
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alpha, assistant],
			runtime,
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: async (_c, _n, call) => {
							if (call !== 1) return quiet();
							await held.promise;
							return quiet();
						},
					}),
				),
			}),
		});
		const visit = await session.visit(priya);
		const exchange = await visit.send({ text: 'go' });
		hostingOf(runtime).evict(session.name);
		await expect(exchange.waitForClose()).rejects.toThrow(/stopped|interrupted|evicted/i);
		held.resolve();
	});

	it('writes nothing for a stop on the dropped handle', async () => {
		const { session, opened, held } = await dropped();
		await tick();
		const before = (await storedOf(opened.journals, session.name)).length;
		await session.stop();
		await tick();
		expect((await storedOf(opened.journals, session.name)).length).toBe(before);
		held.resolve();
	});
});
