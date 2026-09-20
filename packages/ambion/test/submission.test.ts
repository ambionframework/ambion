import { describe, expect, it } from 'vitest';
import { type AgentPort, hostingOf, inProcessTransport, type Transport } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	pi,
	type Room,
	type RoomNotification,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import {
	messagesOf,
	participantsOf,
	roomName,
	runningLeases,
	stateOf,
	waitForRoom,
} from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { faultyJournals, storages } from './support/storage.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Observe every operation before a listener or transport effect can reject it. */
function observed<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => {});
	return promise;
}

function activationStarted(room: Room, agent: string): Promise<void> {
	return new Promise((resolve) => {
		const off = room.subscribe((event) => {
			if (event.type !== 'activation_start' || event.agent !== agent) return;
			off();
			resolve();
		});
	});
}

function throwingConnect(): Transport {
	return {
		connect() {
			throw new Error('transport connect failed');
		},
	};
}

function recordingTransport(isEvicted: () => boolean): {
	transport: Transport;
	afterEviction: string[];
	steers: string[];
} {
	const afterEviction: string[] = [];
	const steers: string[] = [];
	const record = (effect: string) => {
		if (isEvicted()) afterEviction.push(effect);
	};
	return {
		afterEviction,
		steers,
		transport: {
			connect(_room, context) {
				record(`connect:${context.seat}`);
				const port: AgentPort = {
					wake: async () => record('wake'),
					steer: async () => {
						steers.push(isEvicted() ? 'after' : 'before');
						record('steer');
					},
					cut: async () => record('cut'),
				};
				return port;
			},
		},
	};
}

function types(events: readonly RoomNotification[]): string[] {
	return events.map((event) => event.type);
}

describe.each(storages)('submission and effects on $name storage', (storage) => {
	it('keeps a confirmed delivery durable when steering connect throws, then replays its key once', async () => {
		const opened = await storage.open();
		const agent = defineAgent({
			name: 'watcher',
			identity: 'Watches the room.',
			executor: pi({ instructions: 'Stay quiet.', model: 'scripted/watcher' }),
		});
		const held = deferred();
		const started = deferred();
		const stream = scripted(async () => {
			started.resolve();
			await held.promise;
			return quiet();
		});
		const firstRuntime = createRuntime({
			storage: opened.storage,
			transport: inProcessTransport(),
		});
		const name = roomName(`submission-steer-connect-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [agent],
			seats: { [agent.name]: 'broadcast' },
			runtime: firstRuntime,
			stream: stream,
		});
		let resumed: Room | undefined;
		try {
			const visit = await first.visit(person);
			const firstStarted = activationStarted(first, agent.name);
			await visit.send({ text: 'first', key: 'submission-first' });
			await firstStarted;
			await started.promise;

			hostingOf(firstRuntime).evict(name);
			held.resolve();

			const throwingRuntime = createRuntime({
				storage: opened.storage,
				transport: throwingConnect(),
			});
			resumed = await resumeRoom(name, {
				agents: [agent],
				runtime: throwingRuntime,
				stream: scripted(() => quiet()),
			});
			const reentered = await resumed.visit(person);
			const confirmed = observed(reentered.send({ text: 'second', key: 'submission-second' }));
			await expect(confirmed).resolves.toMatchObject({ owner: person.name });
			expect((await messagesOf(resumed)).filter((message) => message.kind === 'said')).toHaveLength(
				2,
			);

			hostingOf(throwingRuntime).evict(name);
			resumed = undefined;
			const healthyRuntime = createRuntime({
				storage: opened.storage,
				transport: inProcessTransport(),
			});
			resumed = await resumeRoom(name, {
				agents: [agent],
				runtime: healthyRuntime,
				stream: scripted(() => quiet()),
			});
			const retryVisit = await resumed.visit(person);
			const retry = await retryVisit.send({ text: 'second', key: 'submission-second' });
			expect(retry.from).toBeGreaterThan(0);
			expect(
				(await messagesOf(resumed)).filter(
					(message) => message.kind === 'said' && message.key === 'submission-second',
				),
			).toHaveLength(1);
		} finally {
			held.resolve();
			await resumed?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('lets a message listener submit a nested delivery without deadlocking the append queue', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`submission-reentrant-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			const visit = await room.visit(person);
			let nested: Promise<unknown> | undefined;
			const off = room.subscribe((event) => {
				if (event.type !== 'message' || event.message.kind !== 'said') return;
				if (event.message.key !== 'submission-outer') return;
				nested = observed(visit.send({ text: 'inner', key: 'submission-inner' }));
			});

			const outer = observed(visit.send({ text: 'outer', key: 'submission-outer' }));
			await expect(outer).resolves.toMatchObject({ owner: person.name });
			expect(nested).toBeDefined();
			await expect(nested).resolves.toMatchObject({ owner: person.name });
			off();
			expect(
				(await messagesOf(room))
					.filter((message) => message.kind === 'said')
					.map((message) => message.text),
			).toEqual(['outer', 'inner']);
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('does not steer an inherited lease after a message listener evicts the room', async () => {
		const opened = await storage.open();
		const agent = defineAgent({
			name: 'watcher',
			identity: 'Watches the room.',
			executor: pi({ instructions: 'Stay quiet.', model: 'scripted/watcher' }),
		});
		const held = deferred();
		const started = deferred();
		const firstRuntime = createRuntime({
			storage: opened.storage,
			transport: inProcessTransport(),
		});
		const name = roomName(`submission-eviction-steer-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [agent],
			seats: { [agent.name]: 'broadcast' },
			runtime: firstRuntime,
			stream: scripted(async () => {
				started.resolve();
				await held.promise;
				return quiet();
			}),
		});
		let resumed: Room | undefined;
		let recovered: Room | undefined;
		try {
			const visit = await first.visit(person);
			const activation = activationStarted(first, agent.name);
			await visit.send({ to: agent.name, text: 'prime lease', key: 'submission-eviction-prime' });
			await activation;
			await started.promise;
			hostingOf(firstRuntime).evict(name);

			let evicted = false;
			const recording = recordingTransport(() => evicted);
			const failingRuntime = createRuntime({
				storage: opened.storage,
				transport: recording.transport,
			});
			resumed = await resumeRoom(name, {
				agents: [agent],
				runtime: failingRuntime,
				stream: scripted(() => quiet()),
			});
			expect(runningLeases(resumed)).toBeGreaterThan(0);
			const resumedVisit = await resumed.visit(person);
			await resumedVisit.send({
				to: agent.name,
				text: 'prove inherited delivery',
				key: 'submission-eviction-probe',
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(recording.steers).toContain('before');
			let triggerSeq: number | undefined;
			const off = resumed.subscribe((event) => {
				if (event.type !== 'message' || event.message.key !== 'submission-eviction-trigger') return;
				triggerSeq = event.message.seq;
				hostingOf(failingRuntime).evict(name);
				evicted = true;
			});

			await expect(
				resumedVisit.send({
					to: agent.name,
					text: 'evict while publishing',
					key: 'submission-eviction-trigger',
				}),
			).resolves.toMatchObject({ owner: person.name });
			await new Promise<void>((resolve) => setImmediate(resolve));
			off();
			expect(evicted).toBe(true);
			expect(triggerSeq).toBeDefined();
			expect(stateOf(resumed).deliveries.get(triggerSeq as number)?.steers).toContainEqual(
				expect.objectContaining({ seat: agent.name }),
			);
			expect(recording.steers).toEqual(['before']);
			expect(recording.afterEviction).toEqual([]);

			const healthyRuntime = createRuntime({ storage: opened.storage });
			recovered = await resumeRoom(name, {
				agents: [agent],
				runtime: healthyRuntime,
				stream: scripted(() => quiet()),
			});
			expect(
				(await messagesOf(recovered)).filter(
					(message) => message.kind === 'said' && message.key === 'submission-eviction-trigger',
				),
			).toHaveLength(1);
		} finally {
			held.resolve();
			await recovered?.stop().catch(() => {});
			await resumed?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('publishes message, exchange-opened, and exchange-closed in order without replay duplicates', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`submission-notification-order-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			const visit = await room.visit(person);
			const events: RoomNotification[] = [];
			const off = room.subscribe((event) => events.push(event));
			await visit.send({ text: 'question', key: 'submission-order' });
			await waitForRoom(room);
			await visit.send({ text: 'follow-up', key: 'submission-order-2' });
			await waitForRoom(room);
			const before = types(events);
			expect(before).toEqual([
				'message',
				'exchange_opened',
				'exchange_closed',
				'message',
				'exchange_opened',
				'exchange_closed',
			]);
			const messages = events
				.filter(
					(event): event is Extract<RoomNotification, { type: 'message' }> =>
						event.type === 'message',
				)
				.map((event) => event.message);
			const opened = events.filter(
				(event): event is Extract<RoomNotification, { type: 'exchange_opened' }> =>
					event.type === 'exchange_opened',
			);
			const closed = events.filter(
				(event): event is Extract<RoomNotification, { type: 'exchange_closed' }> =>
					event.type === 'exchange_closed',
			);
			expect(messages.map((message) => [message.key, message.seq])).toEqual([
				['submission-order', messages[0]?.seq],
				['submission-order-2', messages[1]?.seq],
			]);
			expect(opened.map((event) => event.exchange.from)).toEqual(
				messages.map((message) => message.seq),
			);
			expect(closed.map((event) => event.exchange.from)).toEqual(
				messages.map((message) => message.seq),
			);
			expect(
				closed.every((event, index) => event.exchange.through >= (messages[index]?.seq ?? 0)),
			).toBe(true);

			await room.reconcile();
			await messagesOf(room);
			off();
			expect(types(events)).toEqual(before);
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('publishes a recovered after-append message once and continues with later entries', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName(`submission-recovered-publication-${storage.name}`),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const visit = await room.visit(person);
			const events: RoomNotification[] = [];
			const off = room.subscribe((event) => events.push(event));
			faulty.fail('after', 'message');
			const lost = observed(visit.send({ text: 'recovered', key: 'submission-recovered' }));
			await expect(lost).rejects.toThrow(/disk is full/);

			faulty.fail(false);
			await messagesOf(room);
			await waitForRoom(room);
			expect(
				events.filter(
					(event) => event.type === 'message' && event.message.key === 'submission-recovered',
				),
			).toHaveLength(1);
			expect(types(events)).toEqual(['message', 'exchange_opened', 'exchange_closed']);

			const later = await visit.send({ text: 'later', key: 'submission-later' });
			expect(later.owner).toBe(person.name);
			await waitForRoom(room);
			expect(
				events.filter(
					(event) => event.type === 'message' && event.message.key === 'submission-later',
				),
			).toHaveLength(1);
			expect((await messagesOf(room)).filter((message) => message.kind === 'said')).toHaveLength(2);
			off();
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('keeps a durable inherited lease revocation successful when cut connect throws', async () => {
		const opened = await storage.open();
		const agent = defineAgent({
			name: 'watcher',
			identity: 'Watches the room.',
			executor: pi({ instructions: 'Stay quiet.', model: 'scripted/watcher' }),
		});
		const held = deferred();
		const started = deferred();
		const stream = scripted(async () => {
			started.resolve();
			await held.promise;
			return quiet();
		});
		const name = roomName(`submission-cut-connect-${storage.name}`);
		const firstRuntime = createRuntime({
			storage: opened.storage,
			transport: inProcessTransport(),
		});
		const first = await startRoom({
			name,
			agents: [agent],
			seats: { [agent.name]: 'broadcast' },
			runtime: firstRuntime,
			stream: stream,
		});
		let resumed: Room | undefined;
		try {
			const visit = await first.visit(person);
			const firstStarted = activationStarted(first, agent.name);
			await visit.send({ text: 'start work', key: 'submission-cut-start' });
			await firstStarted;
			await started.promise;

			hostingOf(firstRuntime).evict(name);
			held.resolve();
			const failingRuntime = createRuntime({
				storage: opened.storage,
				transport: throwingConnect(),
			});
			resumed = await resumeRoom(name, {
				agents: [agent],
				runtime: failingRuntime,
				stream: scripted(() => quiet()),
			});

			const stopped = observed(resumed.stop());
			await expect(stopped).resolves.toBeUndefined();
			expect(
				(await participantsOf(resumed)).find((participant) => participant.name === agent.name),
			).toMatchObject({
				status: 'idle',
			});
		} finally {
			held.resolve();
			await resumed?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});
});
