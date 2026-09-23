/**
 * Submission and its effects under faults. A write that lands and loses
 * its confirmation leaves the room in doubt: the journal reads the storage
 * at once, and the room hears what it finds the way it hears what it wrote.
 * A transport that throws, or a listener that evicts the room, does not
 * undo a delivery that the record confirmed, and a keyed retry lands
 * nothing new.
 */
import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	type AgentPort,
	type CommitResult,
	hostingOf,
	inProcessTransport,
	type Transport,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineHuman,
	isPresence,
	isSpoken,
	isSummary,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { observed, openFor, tapped } from './support/core-failure.ts';
import {
	collect,
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	runningLeases,
	scriptedAgent,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import {
	answersLastQuestion,
	byAgent,
	isClosing,
	quiet,
	type Script,
	says,
	scripted,
	summarise,
	toolResultTexts,
} from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import {
	faultyJournals,
	memory,
	type Storage,
	storages,
	tappedJournals,
} from './support/storage.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const alpha = scriptedAgent('alpha');
const assistant = scriptedAgent('assistant');
const watcher = scriptedAgent('watcher');

/** Alpha speaks by `script`, and the assistant summarises each closed exchange once. */
async function summarisedRoom(storage: JournalOpener, script: Script, transport?: Transport) {
	const clock = fakeClock();
	const session = stopAtEnd(
		await startRoom({
			name: roomName('doubt'),
			runtime: createRuntime({ clock, storage, ...(transport === undefined ? {} : { transport }) }),
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alpha, assistant],
			execution: piExecution({
				stream: scripted(
					byAgent({
						alpha: script,
						assistant: (context) =>
							isClosing(context) && !toolResultTexts(context).includes('delivered')
								? summarise('The one message.')
								: quiet(),
					}),
				),
			}),
		}),
	);
	return { clock, session, events: collect(session) };
}

const answers = answersLastQuestion([person.name]);

describe('a room in doubt', () => {
	it('returns one summary when its first commit confirmation is lost', async () => {
		const opened = await openFor(memory);
		const replies: CommitResult[] = [];
		const confirmation = deferred();
		// The first summary commit lands twice, and the seat hears only the second reply.
		const transport = tapped({
			room: (room) => ({
				commit: async (commit) => {
					if (replies.length > 0 || !commit.activation.startsWith('closed:')) {
						return room.commit(commit);
					}
					replies.push(await room.commit(commit), await room.commit(commit));
					confirmation.resolve();
					return replies[1] as CommitResult;
				},
			}),
		});
		const { session } = await summarisedRoom(opened.storage, says(['one', 'two']), transport);
		await (await session.visit(person)).send({ text: 'First?', key: 'q1' });
		await confirmation.promise;
		const summaries = (await messagesOf(session)).filter(isSummary);
		expect(summaries).toHaveLength(1);
		const seqs = replies.flatMap((reply) => ('committed' in reply ? [reply.committed.seq] : []));
		expect(seqs).toEqual([summaries[0]?.seq, summaries[0]?.seq]);
	});

	it('hears a visit and a delivery that landed and lost their confirmation, answers a read with what it found, and wakes the seats once', async () => {
		const opened = await openFor(memory);
		const faulty = faultyJournals(opened.storage);
		const { session, events } = await summarisedRoom(faulty.journals, answers);
		await waitForRoom(session);
		faulty.fail('after', 'message');
		const first = session.visit(person);
		const second = first.catch(() => session.visit(person));
		await expect(first).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		const visit = await second;
		await waitForRoom(session);
		const arrivals = (await messagesOf(session))
			.filter(isPresence)
			.filter((m) => m.kind === 'arrived');
		expect(arrivals).toHaveLength(1);

		faulty.fail('after', 'message');
		const delivery = visit.send({ text: 'First?', key: 'q1' });
		const read = messagesOf(session);
		await expect(delivery).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		expect((await read).map((m) => m.key)).toContain('q1');
		await waitForRoom(session);
		const record = await messagesOf(session);
		expect(record.filter((m) => m.key === 'q1')).toHaveLength(1);
		expect(record.filter(isSpoken).filter((m) => m.from === alpha.name)).toHaveLength(1);
		expect(events.filter((e) => e.type === 'message' && e.message.key === 'q1')).toHaveLength(1);
		// and a retry under the same key lands nothing new
		await visit.send({ text: 'First?', key: 'q1' });
		expect((await messagesOf(session)).filter((m) => m.key === 'q1')).toHaveLength(1);
	});

	it('keeps a question queued before close in the current exchange', async () => {
		const opened = await openFor(memory);
		let failNextClose = false;
		const journals = tappedJournals(opened.storage, (_id, _n, phase, customType) => {
			if (failNextClose && phase === 'after' && customType === 'close') {
				failNextClose = false;
				throw new Error('the disk is full');
			}
		});
		const { clock, session, events } = await summarisedRoom(journals, answers);
		const visit = await session.visit(person);
		await waitForRoom(session);
		// The second question is delivered the moment alpha's activation ends, so its
		// commit is queued ahead of the close the reconcile decides, and that close
		// lands and loses its confirmation.
		let delivered: Promise<unknown> | undefined;
		session.subscribe((event) => {
			if (event.type === 'activation_end' && event.agent === alpha.name && !delivered) {
				failNextClose = true;
				delivered = visit.send({ text: 'Second?', key: 'q2' });
			}
		});
		await visit.send({ text: 'First?', key: 'q1' });
		await waitForRoom(session);
		await delivered;
		for (let i = 0; i < 4; i += 1) await clock.advance(61_000);
		await waitForRoom(session);
		const closes = (await storedOf(opened.journals, session.name)).filter(
			(r) => r.kind === 'close',
		);
		expect(closes).toHaveLength(1);
		expect(closes[0]?.body).toMatchObject({ from: 4, through: 11 });
		const exchanges = events.filter(
			(e) => e.type === 'exchange_opened' || e.type === 'exchange_closed',
		);
		expect(exchanges.map((e) => e.type)).toEqual(['exchange_opened', 'exchange_closed']);
	});
});

/**
 * A watcher whose activation holds until the test releases it, and a host
 * that dies while it runs: the next host inherits a running lease.
 */
async function inheritedLease(storage: Storage, send: { to?: string; text: string; key: string }) {
	const opened = await openFor(storage);
	const held = deferred();
	const started = deferred();
	const runtime = createRuntime({ storage: opened.storage, transport: inProcessTransport() });
	const name = roomName(`submission-${storage.name}`);
	const first = stopAtEnd(
		await startRoom({
			name,
			agents: [watcher],
			seats: { [watcher.name]: 'broadcast' },
			runtime,
			execution: piExecution({
				stream: scripted(async () => {
					started.resolve();
					await held.promise;
					return quiet();
				}),
			}),
		}),
	);
	await (await first.visit(person)).send(send);
	await started.promise;
	hostingOf(runtime).evict(name);
	const resume = (transport: Transport) => {
		const next = createRuntime({ storage: opened.storage, transport });
		return {
			runtime: next,
			room: resumeRoom(name, {
				agents: [watcher],
				runtime: next,
				execution: piExecution({ stream: scripted(() => quiet()) }),
			}),
		};
	};
	return { name, held, resume };
}

const throwingConnect: Transport = {
	connect() {
		throw new Error('transport connect failed');
	},
};

describe.each(storages)('submission and effects on $name storage', (storage) => {
	it('keeps a confirmed delivery durable when steering connect throws, then replays its key once', async () => {
		const { held, resume } = await inheritedLease(storage, {
			text: 'first',
			key: 'submission-first',
		});
		held.resolve();
		const throwing = resume(throwingConnect);
		const resumed = await throwing.room;
		const reentered = await resumed.visit(person);
		await expect(
			observed(reentered.send({ text: 'second', key: 'submission-second' })),
		).resolves.toMatchObject({ owner: person.name });
		expect((await messagesOf(resumed)).filter((message) => message.kind === 'said')).toHaveLength(
			2,
		);

		hostingOf(throwing.runtime).evict(resumed.name);
		const healthy = stopAtEnd(await resume(inProcessTransport()).room);
		const retry = await (
			await healthy.visit(person)
		).send({
			text: 'second',
			key: 'submission-second',
		});
		expect(retry.from).toBeGreaterThan(0);
		expect(
			(await messagesOf(healthy)).filter(
				(message) => message.kind === 'said' && message.key === 'submission-second',
			),
		).toHaveLength(1);
	});

	it('does not steer an inherited lease after a message listener evicts the room', async () => {
		const { name, held, resume } = await inheritedLease(storage, {
			to: watcher.name,
			text: 'prime lease',
			key: 'submission-eviction-prime',
		});
		let evicted = false;
		const afterEviction: string[] = [];
		const steers: string[] = [];
		const record = (effect: string) => {
			if (evicted) afterEviction.push(effect);
		};
		const recording: Transport = {
			connect(_room, context) {
				record(`connect:${context.seat}`);
				const port: AgentPort = {
					wake: async () => record('wake'),
					steer: async () => {
						steers.push(evicted ? 'after' : 'before');
						record('steer');
					},
					cut: async () => record('cut'),
				};
				return port;
			},
		};
		const failing = resume(recording);
		const resumed = stopAtEnd(await failing.room);
		onTestFinished(() => held.resolve());
		expect(runningLeases(resumed)).toBeGreaterThan(0);
		const visit = await resumed.visit(person);
		await visit.send({
			to: watcher.name,
			text: 'prove inherited delivery',
			key: 'submission-eviction-probe',
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(steers).toContain('before');
		let triggerSeq: number | undefined;
		const off = resumed.subscribe((event) => {
			if (event.type !== 'message' || event.message.key !== 'submission-eviction-trigger') return;
			triggerSeq = event.message.seq;
			hostingOf(failing.runtime).evict(name);
			evicted = true;
		});
		await expect(
			visit.send({
				to: watcher.name,
				text: 'evict while publishing',
				key: 'submission-eviction-trigger',
			}),
		).resolves.toMatchObject({ owner: person.name });
		await new Promise<void>((resolve) => setImmediate(resolve));
		off();
		expect(evicted).toBe(true);
		expect(stateOf(resumed).deliveries.get(triggerSeq ?? -1)?.steers).toContainEqual(
			expect.objectContaining({ seat: watcher.name }),
		);
		expect(steers).toEqual(['before']);
		expect(afterEviction).toEqual([]);

		const recovered = stopAtEnd(await resume(inProcessTransport()).room);
		expect(
			(await messagesOf(recovered)).filter(
				(message) => message.kind === 'said' && message.key === 'submission-eviction-trigger',
			),
		).toHaveLength(1);
	});

	it('keeps a durable inherited lease revocation successful when cut connect throws', async () => {
		const { held, resume } = await inheritedLease(storage, {
			text: 'start work',
			key: 'submission-cut-start',
		});
		held.resolve();
		const resumed = await resume(throwingConnect).room;
		await expect(observed(resumed.stop())).resolves.toBeUndefined();
		expect(
			(await participantsOf(resumed)).find((participant) => participant.name === watcher.name),
		).toMatchObject({ status: 'idle' });
	});

	it('lets a message listener submit a nested delivery without deadlocking the append queue', async () => {
		const opened = await openFor(storage);
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`submission-reentrant-${storage.name}`),
				runtime: createRuntime({ storage: opened.storage }),
			}),
		);
		const visit = await room.visit(person);
		let nested: Promise<unknown> | undefined;
		const off = room.subscribe((event) => {
			if (event.type !== 'message' || event.message.key !== 'submission-outer') return;
			nested = observed(visit.send({ text: 'inner', key: 'submission-inner' }));
		});
		await expect(
			observed(visit.send({ text: 'outer', key: 'submission-outer' })),
		).resolves.toMatchObject({ owner: person.name });
		expect(nested).toBeDefined();
		await expect(nested).resolves.toMatchObject({ owner: person.name });
		off();
		expect(
			(await messagesOf(room))
				.filter((message) => message.kind === 'said')
				.map((message) => message.text),
		).toEqual(['outer', 'inner']);
	});

	it('publishes message, exchange-opened, and exchange-closed in order without replay duplicates', async () => {
		const opened = await openFor(storage);
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`submission-notification-order-${storage.name}`),
				runtime: createRuntime({ storage: opened.storage }),
			}),
		);
		const visit = await room.visit(person);
		const events = collect(room);
		await visit.send({ text: 'question', key: 'submission-order' });
		await waitForRoom(room);
		await visit.send({ text: 'follow-up', key: 'submission-order-2' });
		await waitForRoom(room);
		const before = events.map((event) => event.type);
		expect(before).toEqual([
			'message',
			'exchange_opened',
			'exchange_closed',
			'message',
			'exchange_opened',
			'exchange_closed',
		]);
		const messages = events.flatMap((event) => (event.type === 'message' ? [event.message] : []));
		expect(messages.map((message) => message.key)).toEqual([
			'submission-order',
			'submission-order-2',
		]);
		const seqs = messages.map((message) => message.seq);
		const opens = events.flatMap((e) => (e.type === 'exchange_opened' ? [e.exchange] : []));
		const closed = events.flatMap((e) => (e.type === 'exchange_closed' ? [e.exchange] : []));
		expect(opens.map((exchange) => exchange.from)).toEqual(seqs);
		expect(closed.map((exchange) => exchange.from)).toEqual(seqs);
		expect(closed.every((exchange, index) => exchange.through >= (seqs[index] ?? 0))).toBe(true);

		await room.reconcile();
		await messagesOf(room);
		expect(events.map((event) => event.type)).toEqual(before);
	});

	it('publishes a recovered after-append message once and continues with later entries', async () => {
		const opened = await openFor(storage);
		const faulty = faultyJournals(opened.storage);
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`submission-recovered-publication-${storage.name}`),
				runtime: createRuntime({ storage: faulty.journals }),
			}),
		);
		const visit = await room.visit(person);
		const events = collect(room);
		const keyed = (key: string) =>
			events.filter((event) => event.type === 'message' && event.message.key === key);
		faulty.fail('after', 'message');
		await expect(
			observed(visit.send({ text: 'recovered', key: 'submission-recovered' })),
		).rejects.toThrow(/disk is full/);

		faulty.fail(false);
		await messagesOf(room);
		await waitForRoom(room);
		expect(keyed('submission-recovered')).toHaveLength(1);
		expect(events.map((event) => event.type)).toEqual([
			'message',
			'exchange_opened',
			'exchange_closed',
		]);

		const later = await visit.send({ text: 'later', key: 'submission-later' });
		expect(later.owner).toBe(person.name);
		await waitForRoom(room);
		expect(keyed('submission-later')).toHaveLength(1);
		expect((await messagesOf(room)).filter((message) => message.kind === 'said')).toHaveLength(2);
	});
});
