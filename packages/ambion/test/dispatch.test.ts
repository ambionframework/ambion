/**
 * Activation dispatch: the room sends a wake for each recorded cause at
 * once, sends it again after a lost or failed delivery, and a durable
 * abort or unseat holds against a wake or a claim that never returns.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { hostingOf, inProcessTransport, type Transport, type Wake } from '../src/hosting.ts';
import {
	type CreateRuntimeOptions,
	createRuntime,
	defineHuman,
	type Room,
	type RoomNotification,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { flush, tapped } from './support/core-failure.ts';
import {
	assistant,
	collect,
	crash,
	deferred,
	roomName,
	scriptedAgent,
	stateOf,
	waitForRoom,
} from './support/room.ts';
import { byAgent, quiet, scripted } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { type Storage, storages } from './support/storage.ts';

const alpha = scriptedAgent('alpha');
const beta = scriptedAgent('beta');
const worker = scriptedAgent('worker');
const priya = defineHuman({ name: 'priya', identity: 'Asks questions.' });
const quietly = () => piExecution({ stream: scripted(() => quiet()) });

/** Record every wake, and deliver it only when `deliver` says so. */
function recorded(deliver = true): { transport: Transport; sent: Wake[] } {
	const sent: Wake[] = [];
	const transport = tapped({
		wake: async (wake, port) => {
			sent.push(wake);
			if (deliver) await port.wake(wake);
		},
	});
	return { sent, transport };
}

const activations = (sent: readonly Wake[]): string[] => sent.map((wake) => wake.activation).sort();

type DeliveryError = Extract<RoomNotification, { type: 'delivery_error' }>;
const deliveryErrors = (events: readonly RoomNotification[]): DeliveryError[] =>
	events.filter((event): event is DeliveryError => event.type === 'delivery_error');

/** One broadcast worker on a fake clock, stopped with its storage when the test ends. */
async function workerRoom(storage: Storage, options: Omit<CreateRuntimeOptions, 'storage'>) {
	const opened = await openFor(storage);
	const clock = fakeClock();
	const runtime = createRuntime({ storage: opened.storage, clock, ...options });
	const room = stopAtEnd(
		await startRoom({
			name: roomName(`dispatch-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: quietly(),
		}),
	);
	return { opened, clock, runtime, room };
}

describe.each(storages)('activation dispatch on $name', (storage) => {
	it('starts ordinary work promptly with only their recorded causes', async () => {
		const opened = await openFor(storage);
		const clock = fakeClock();
		const before = clock.now();
		const alphaStarted = deferred();
		const assistantStarted = deferred();
		const observed = recorded();
		const room = stopAtEnd(
			await startRoom({
				name: roomName('dispatch-causes'),
				agents: [alpha, beta, assistant],
				seats: { [assistant.name]: 'broadcast', [alpha.name]: 'broadcast' },
				runtime: createRuntime({ storage: opened.storage, clock, transport: observed.transport }),
				execution: piExecution({
					stream: scripted(
						byAgent({
							alpha: () => {
								alphaStarted.resolve();
								return quiet();
							},
							assistant: () => {
								assistantStarted.resolve();
								return quiet();
							},
						}),
					),
				}),
			}),
		);
		const exchange = await (await room.visit(priya)).send({ text: 'Who can answer?' });
		// No caller-driven reconciliation or clock advance starts these activations.
		await Promise.all([alphaStarted.promise, assistantStarted.promise]);
		await waitForRoom(room);
		expect(clock.now()).toBe(before);
		expect(activations(observed.sent)).toEqual([
			`message:${exchange.from}:alpha:1`,
			`message:${exchange.from}:assistant:1`,
		]);
	});

	it.each([
		['at once', false],
		['after the wake deadline', true],
	])(
		'recovers lost initial sends %s with the same activation identities and no resend delay',
		async (_when, late) => {
			const opened = await openFor(storage);
			const clock = fakeClock();
			const lost = recorded(false);
			const firstRuntime = createRuntime({
				storage: opened.storage,
				clock,
				transport: lost.transport,
			});
			const room = stopAtEnd(
				await startRoom({
					name: roomName('dispatch-recovery'),
					agents: [alpha, beta, assistant],
					seats: { [assistant.name]: 'broadcast', [alpha.name]: 'broadcast' },
					runtime: firstRuntime,
					execution: quietly(),
				}),
			);
			await (await room.visit(priya)).send({ text: 'Recover this work.' });
			await room.reconcile();
			const expected = stateOf(room)
				.due.map((work) => work.id)
				.sort();
			expect(expected).toHaveLength(2);
			expect(stateOf(room).leases.size).toBe(0);
			crash(firstRuntime, room);
			if (late) await clock.advance(hostingOf(firstRuntime).limits.lease.deadline + 1);
			const recovered = recorded();
			const before = clock.now();
			const resumed = stopAtEnd(
				await resumeRoom(room.name, {
					runtime: createRuntime({
						storage: opened.storage,
						clock,
						transport: recovered.transport,
					}),
					agents: [alpha, beta, assistant],
					execution: quietly(),
				}),
			);
			await waitForRoom(resumed);
			expect(clock.now()).toBe(before);
			expect(activations(lost.sent)).toEqual(expected);
			expect(activations(recovered.sent)).toEqual(expected);
			expect(stateOf(resumed).due).toEqual([]);
		},
	);

	it('reports a synchronous connector throw while accepting the human send', async () => {
		let connects = 0;
		const { room } = await workerRoom(storage, {
			transport: {
				connect() {
					connects += 1;
					throw new Error('connector unavailable');
				},
			},
		});
		room.subscribe((event) => {
			if (event.type === 'delivery_error') throw new Error('observer failed');
		});
		const events = collect(room);
		const exchange = await (await room.visit(priya)).send({ text: 'Keep this question.' });
		await flush();
		const pending = stateOf(room).due.find((work) => work.seat === worker.name);
		expect(exchange.from).toBeGreaterThan(0);
		expect(connects).toBeGreaterThan(0);
		expect(deliveryErrors(events)).toContainEqual(
			expect.objectContaining({
				agent: worker.name,
				activation: pending?.id,
				operation: 'wake',
				error: expect.objectContaining({ message: 'connector unavailable' }),
			}),
		);
	});

	it('reports a rejected wake, coalesces retries, and emits again after recovery', async () => {
		let available = false;
		const { room, clock, runtime } = await workerRoom(storage, {
			limits: { delivery: { resend: 10 } },
			transport: tapped({
				wake: async (wake, port) => {
					if (!available) throw new Error('wake unavailable');
					await port.wake(wake);
				},
			}),
		});
		const resend = hostingOf(runtime).limits.delivery.resend;
		const events = collect(room);
		const visit = await room.visit(priya);
		const first = await visit.send({ text: 'Retry this question.' });
		await flush();
		const firstPending = stateOf(room).due.find((work) => work.seat === worker.name);
		expect(first.from).toBeGreaterThan(0);
		expect(deliveryErrors(events)).toHaveLength(1);

		await clock.advance(resend);
		expect(deliveryErrors(events)).toHaveLength(1);

		available = true;
		await clock.advance(resend);
		await flush();
		expect(deliveryErrors(events)).toHaveLength(1);

		available = false;
		await visit.send({ text: 'Try the recovered connection.' });
		await flush();
		await clock.advance(resend);
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
	});

	it('resends an unresolved wake and completes when the next delivery works', async () => {
		let deliveries = 0;
		const { room, clock } = await workerRoom(storage, {
			limits: { delivery: { resend: 10 } },
			transport: tapped({
				wake: (wake, port) => {
					deliveries += 1;
					return deliveries === 1 ? new Promise<void>(() => {}) : port.wake(wake);
				},
			}),
		});
		const exchange = await (
			await room.visit(priya)
		).send({
			text: 'Do not wait forever for the first delivery.',
		});
		await flush();
		expect(deliveries).toBe(1);
		await clock.advance(10);
		await flush();
		expect(deliveries).toBe(2);
		expect((await room.read()).exchanges.find((item) => item.from === exchange.from)?.status).toBe(
			'closed',
		);
	});

	it('does not block durable abort on a wake that never resolves, then keeps cancellation on restart', async () => {
		const {
			opened,
			clock,
			runtime,
			room: first,
		} = await workerRoom(storage, {
			transport: tapped({ wake: () => new Promise<void>(() => {}) }),
		});
		const exchange = await (await first.visit(priya)).send({ text: 'Cancel this delivery.' });
		await flush();
		await first.abort();
		expect(stateOf(first).exchange).toBeUndefined();

		crash(runtime, first);
		const resumed = stopAtEnd(
			await resumeRoom(first.name, {
				agents: [worker],
				runtime: createRuntime({ storage: opened.storage, clock, transport: inProcessTransport() }),
				execution: quietly(),
			}),
		);
		const snapshot = await resumed.read({ messages: false });
		expect(snapshot.exchange).toBeUndefined();
		expect(snapshot.exchanges).toContainEqual(
			expect.objectContaining({ from: exchange.from, status: 'closed' }),
		);
		expect(stateOf(resumed).due).toEqual([]);
	});

	it.each([
		['abort', async (room: Room) => room.abort()],
		['unseat', async (room: Room) => room.unseat(worker.name)],
	] as const)('lets durable %s reject a delayed claim', async (_operation, finish) => {
		const claimStarted = deferred();
		const claimRelease = deferred();
		let held = true;
		const { room } = await workerRoom(storage, {
			transport: tapped({
				room: (calls) => ({
					lease: async (request) => {
						if (held && request.operation === 'claim') {
							held = false;
							claimStarted.resolve();
							await claimRelease.promise;
						}
						return calls.lease(request);
					},
				}),
			}),
		});
		const events = collect(room);
		await (await room.visit(priya)).send({ text: 'Claim this slowly.' });
		await claimStarted.promise;
		await finish(room);
		claimRelease.resolve();
		await flush();
		expect(events.filter((event) => event.type === 'activation_start')).toEqual([]);
		expect(stateOf(room).due).toEqual([]);
		expect(stateOf(room).leases).toEqual(new Map());
	});
});
