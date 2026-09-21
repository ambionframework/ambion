import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	hostingOf,
	inProcessTransport,
	type LeaseRequest,
	type RoomProtocol,
	type Transport,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	type RoomNotification,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { crash, deferred, roomName, stateOf } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer.', model: 'scripted/worker' }),
});
const human = defineHuman({ name: 'priya', identity: 'Asks questions.' });

type DeliveryError = Extract<RoomNotification, { type: 'delivery_error' }>;

function deliveryErrors(events: readonly RoomNotification[]): DeliveryError[] {
	return events.filter((event): event is DeliveryError => event.type === 'delivery_error');
}

async function flush(): Promise<void> {
	for (let round = 0; round < 5; round += 1)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

function delayedClaimTransport(
	claimStarted: { resolve: () => void },
	claimRelease: Promise<void>,
): Transport {
	const base = inProcessTransport();
	let held = true;
	return {
		connect(room, context) {
			const delayed: RoomProtocol = {
				view: (id, range) => room.view(id, range),
				commit: (commit) => room.commit(commit),
				lease: async (request: LeaseRequest) => {
					if (held && request.operation === 'claim') {
						held = false;
						claimStarted.resolve();
						await claimRelease;
					}
					return room.lease(request);
				},
			};
			return base.connect(delayed, context);
		},
	};
}

function hangingWakeTransport(): Transport {
	const base = inProcessTransport();
	return {
		connect(room, context) {
			const port = base.connect(room, context);
			return {
				cut: (activation) => port.cut(activation),
				steer: (steer) => port.steer(steer),
				wake: () => new Promise<void>(() => {}),
			};
		},
	};
}

describe.each(storages)('dispatch failures on $name storage', (storage) => {
	it('reports a synchronous connector throw while accepting the human send', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const events: RoomNotification[] = [];
		let connects = 0;
		const room = await startRoom({
			name: roomName(`dispatch-connect-throw-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime: createRuntime({
				storage: opened.storage,
				clock,
				transport: {
					connect() {
						connects += 1;
						throw new Error('connector unavailable');
					},
				},
			}),
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		const throwing = room.subscribe((event) => {
			if (event.type === 'delivery_error') throw new Error('observer failed');
		});
		const off = room.subscribe((event) => events.push(event));
		try {
			const visit = await room.visit(human);
			const exchange = await visit.send({ text: 'Keep this question.' });
			await flush();
			const pending = stateOf(room).due.find((work) => work.seat === worker.name);
			const errors = deliveryErrors(events);
			expect(exchange.from).toBeGreaterThan(0);
			expect(connects).toBeGreaterThan(0);
			expect(errors).toContainEqual(
				expect.objectContaining({
					agent: worker.name,
					activation: pending?.id,
					operation: 'wake',
					error: expect.objectContaining({ message: 'connector unavailable' }),
				}),
			);
		} finally {
			throwing();
			off();
			await room.stop();
			await opened.dispose();
		}
	});

	it('reports a rejected wake, coalesces retries, and emits again after recovery', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const events: RoomNotification[] = [];
		let available = false;
		const base = inProcessTransport();
		const transport: Transport = {
			connect(room, context) {
				const port = base.connect(room, context);
				return {
					cut: (activation) => port.cut(activation),
					steer: (steer) => port.steer(steer),
					wake: async (wake) => {
						if (!available) throw new Error('wake unavailable');
						await port.wake(wake);
					},
				};
			},
		};
		const runtime = createRuntime({
			storage: opened.storage,
			clock,
			transport,
			limits: { delivery: { resend: 10 } },
		});
		const room = await startRoom({
			name: roomName(`dispatch-wake-reject-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		const off = room.subscribe((event) => events.push(event));
		try {
			const visit = await room.visit(human);
			const first = await visit.send({ text: 'Retry this question.' });
			await flush();
			const firstPending = stateOf(room).due.find((work) => work.seat === worker.name);
			expect(first.from).toBeGreaterThan(0);
			expect(deliveryErrors(events)).toHaveLength(1);

			await clock.advance(hostingOf(runtime).limits.delivery.resend);
			expect(deliveryErrors(events)).toHaveLength(1);

			available = true;
			await clock.advance(hostingOf(runtime).limits.delivery.resend);
			await flush();
			expect(deliveryErrors(events)).toHaveLength(1);

			available = false;
			await visit.send({ text: 'Try the recovered connection.' });
			await flush();
			await clock.advance(hostingOf(runtime).limits.delivery.resend);
			await flush();
			const errors = deliveryErrors(events);
			expect(errors).toHaveLength(2);
			expect(errors[0]).toMatchObject({
				agent: worker.name,
				activation: firstPending?.id,
				operation: 'wake',
			});
			expect(errors[1]).toMatchObject({ agent: worker.name, operation: 'wake' });
			expect(errors[1]?.activation).not.toBe(errors[0]?.activation);
		} finally {
			off();
			await room.stop();
			await opened.dispose();
		}
	});

	it('resends an unresolved wake and completes when the next delivery works', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const base = inProcessTransport();
		let deliveries = 0;
		const room = await startRoom({
			name: roomName(`dispatch-hung-retry-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime: createRuntime({
				storage: opened.storage,
				clock,
				limits: { delivery: { resend: 10 } },
				transport: {
					connect(calls, context) {
						const port = base.connect(calls, context);
						return {
							cut: (id) => port.cut(id),
							steer: (steer) => port.steer(steer),
							wake: (wake) => {
								deliveries += 1;
								return deliveries === 1 ? new Promise<void>(() => {}) : port.wake(wake);
							},
						};
					},
				},
			}),
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		try {
			const visit = await room.visit(human);
			const exchange = await visit.send({ text: 'Do not wait forever for the first delivery.' });
			await flush();
			expect(deliveries).toBe(1);
			await clock.advance(10);
			await flush();
			expect(deliveries).toBe(2);
			expect(
				(await room.read()).exchanges.find((item) => item.from === exchange.from)?.status,
			).toBe('closed');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('does not block durable abort on a wake that never resolves, then keeps cancellation on restart', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const firstRuntime = createRuntime({
			storage: opened.storage,
			clock,
			transport: hangingWakeTransport(),
		});
		const name = roomName(`dispatch-hanging-wake-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime: firstRuntime,
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		let resumed: Room | undefined;
		try {
			const visit = await first.visit(human);
			const exchange = await visit.send({ text: 'Cancel this delivery.' });
			await flush();
			await first.abort();
			expect(stateOf(first).exchange).toBeUndefined();

			crash(firstRuntime, first);
			resumed = await resumeRoom(name, {
				agents: [worker],
				runtime: createRuntime({ storage: opened.storage, clock, transport: inProcessTransport() }),
				execution: piExecution({ stream: scripted(() => quiet()) }),
			});
			const snapshot = await resumed.read({ messages: false });
			expect(snapshot.exchange).toBeUndefined();
			expect(snapshot.exchanges).toContainEqual(
				expect.objectContaining({ from: exchange.from, status: 'closed' }),
			);
			expect(stateOf(resumed).due).toEqual([]);
		} finally {
			await resumed?.stop();
			await opened.dispose();
		}
	});

	it('replays pending work after eviction past the wake deadline with its identity', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const sent: string[] = [];
		const lost = {
			connect(room: RoomProtocol, context: Parameters<Transport['connect']>[1]) {
				const port = inProcessTransport().connect(room, context);
				return {
					cut: (activation: string) => port.cut(activation),
					steer: (steer: Parameters<typeof port.steer>[0]) => port.steer(steer),
					wake: async () => {},
				};
			},
		} satisfies Transport;
		const firstRuntime = createRuntime({
			storage: opened.storage,
			clock,
			transport: lost,
		});
		const name = roomName(`dispatch-old-work-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime: firstRuntime,
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		let resumed: Room | undefined;
		try {
			const visit = await first.visit(human);
			await visit.send({ text: 'Keep this work pending.' });
			await first.reconcile();
			const pending = stateOf(first).due.find((work) => work.seat === worker.name);
			expect(pending).toBeDefined();
			const activation = pending?.id;
			if (activation === undefined) throw new Error('The test did not create pending work.');
			crash(firstRuntime, first);
			await clock.advance(hostingOf(firstRuntime).limits.lease.deadline + 1);

			const recovered = inProcessTransport();
			const transport: Transport = {
				connect(room, context) {
					const port = recovered.connect(room, context);
					return {
						cut: (id) => port.cut(id),
						steer: (steer) => port.steer(steer),
						wake: async (wake) => {
							sent.push(wake.activation);
							await port.wake(wake);
						},
					};
				},
			};
			resumed = await resumeRoom(name, {
				agents: [worker],
				runtime: createRuntime({ storage: opened.storage, clock, transport }),
				execution: piExecution({ stream: scripted(() => quiet()) }),
			});
			await resumed.reconcile();
			await flush();
			expect(sent).toContain(activation);
			expect(stateOf(resumed).due).toEqual([]);
		} finally {
			await resumed?.stop();
			await opened.dispose();
		}
	});

	it.each([
		['abort', async (room: Room) => room.abort()],
		['unseat', async (room: Room) => room.unseat(worker.name)],
	] as const)('lets durable %s reject a delayed claim', async (_operation, finish) => {
		const opened = await storage.open();
		const clock = fakeClock();
		const claimStarted = deferred();
		const claimRelease = deferred();
		const runtime = createRuntime({
			storage: opened.storage,
			clock,
			transport: delayedClaimTransport(claimStarted, claimRelease.promise),
		});
		const room = await startRoom({
			name: roomName(`dispatch-delayed-claim-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		const events: RoomNotification[] = [];
		const off = room.subscribe((event) => events.push(event));
		try {
			const visit = await room.visit(human);
			await visit.send({ text: 'Claim this slowly.' });
			await claimStarted.promise;
			await finish(room);
			claimRelease.resolve();
			await flush();
			expect(events.filter((event) => event.type === 'activation_start')).toEqual([]);
			expect(stateOf(room).due).toEqual([]);
			expect(stateOf(room).leases).toEqual(new Map());
		} finally {
			claimRelease.resolve();
			off();
			await room.stop();
			await opened.dispose();
		}
	});
});
