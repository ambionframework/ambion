/**
 * The seat object: a wake sets its alarm, the alarm runs one activation
 * against the room over RPC, and a wake a seat on hold never takes is sent
 * again by the room's own alarm. Alarms fire on their own inside workerd,
 * so the test waits for what they do.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Message } from '@ambionframework/ambion';
import type { LeaseResponse, RoomProtocol, Steer } from '@ambionframework/ambion/hosting';
import { namespaced } from '@ambionframework/journal';
import { piSessions } from '@ambionframework/pi-journal';
import { expect, it } from 'vitest';
import { configure, type SeatEvent } from '../src/configure.ts';
import { seatMetadata, sqlStorage } from '../src/storage.ts';
import { stream } from './answers.ts';
import { until } from './until.ts';
import { assistant, product, slow } from './worker.ts';

type LeaseObservation = { id: string; phase: 'running' | 'ended'; reason?: string };

it('wakes, runs the activation on its alarm, and the room sends an untaken wake again', async () => {
	const room = env.ROOM.get(env.ROOM.idFromName('seat-test'));
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', 'seat-test', 'product'])),
	);
	await room.start({
		name: 'seat-test',
		summary: 'assistant',
		agents: ['product', 'assistant'],
		seats: { assistant: 'none', product: 'broadcast' },
	});
	await room.visit({ name: 'priya', identity: 'Project manager.' });
	await room.send({ from: 'priya', text: 'When is the pour?', key: 'q1' });
	// At least one wake reached the seat. The room sends a wake nobody has taken
	// again every 50 ms here, so how many arrive before the alarm runs is the
	// runner's speed and not the room's behaviour.
	expect(await until(() => seat.wakes())).toBeGreaterThanOrEqual(1);

	// the seat's alarm runs the activation: a lease claimed, a say, the lease renewed at the
	// end of the pass, and released
	await runDurableObjectAlarm(seat);
	const said = await until(async () => {
		const messages: Message[] = await room.messages();
		return messages.find((m) => m.kind === 'said' && m.from === 'product');
	});
	expect(said).toMatchObject({
		activationId: 'message:4:product:1',
		text: 'The pour is Saturday.',
	});
	const leases = await until(async () =>
		runInDurableObject(room, async (_instance, state) => {
			const journal = await namespaced(sqlStorage(state), 'ambion/room').open('seat-test');
			const stored = (await journal.read(0)).entries.map(
				(entry) =>
					entry.entry as {
						kind: string;
						body: LeaseObservation;
					},
			);
			const found = stored
				.filter((entry) => entry.kind === 'lease' && entry.body.id === 'message:4:product:1')
				.map((entry) => entry.body);
			return found.at(-1)?.phase === 'ended' ? found : undefined;
		}),
	);
	expect(leases.map((lease) => lease?.phase)).toEqual(['running', 'running', 'ended']);
	expect(leases.at(-1)).toMatchObject({ id: 'message:4:product:1', reason: 'released' });
	// the seat's audit session holds the activation's turns, in the seat's own storage
	const audited = await runInDurableObject(seat, async (_instance, state) => {
		const piSession = await piSessions(sqlStorage(state)).open(
			JSON.stringify(['ambion/seat-session', 'seat-test', 'product']),
		);
		return (await piSession.findEntries({ order: 'oldestFirst' })).map((entry) => entry.type);
	});
	expect(audited[0]).toBe('custom');
	expect(audited.filter((type) => type === 'message').length).toBeGreaterThanOrEqual(3);

	// a seat on hold keeps the next wake and runs nothing: the room's alarm sends it again
	await seat.hold(true);
	const secondExchange = await room.send({ from: 'priya', text: 'And the pump?', key: 'q2' });
	expect(await until(async () => (await seat.wakes()) >= 3)).toBe(true);
	expect((await room.participants()).find((s) => s.name === 'product')).toMatchObject({
		status: 'active',
	});
	// the hold lifts: the seat takes the wake it holds, and the exchange closes
	await seat.hold(false);
	const answered = await until(async () => {
		const messages: Message[] = await room.messages();
		return messages.filter((m) => m.kind === 'said' && m.from === 'product').length === 2;
	});
	expect(answered).toBe(true);
	await room.waitForClose(secondExchange.from);
	expect(await room.exchange(secondExchange.from)).toEqual(secondExchange);
});

it('cancels an unclaimed wake over RPC and closes its exchange', async () => {
	const room = env.ROOM.get(env.ROOM.idFromName('cut-test'));
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', 'cut-test', 'product'])),
	);
	await room.start({
		name: 'cut-test',
		summary: 'assistant',
		agents: ['product', 'assistant'],
		seats: { assistant: 'none', product: 'broadcast' },
	});
	await room.visit({ name: 'priya', identity: 'Project manager.' });
	const exchange = await room.send({ from: 'priya', text: 'When is the pour?', key: 'q1' });
	// At least one wake reached the seat. The room sends a wake nobody has taken
	// again every 50 ms here, so how many arrive before the alarm runs is the
	// runner's speed and not the room's behaviour.
	expect(await until(() => seat.wakes())).toBeGreaterThanOrEqual(1);

	// The room records the cancellation and writes off the unclaimed wake.
	await room.abort();
	const cancelled = await room.read({ messages: false });
	expect(cancelled.exchange).toBeUndefined();
	expect(cancelled.exchanges).toContainEqual(
		expect.objectContaining({ status: 'closed', from: exchange.from }),
	);
	// The RPC returns after the durable cancellation cut and exchange close.
	await room.waitForClose(exchange.from);
	await runDurableObjectAlarm(seat);
	// The revoked exchange remains addressable by its opening sequence, while
	// the product has no answer to publish.
	expect(await room.exchange(exchange.from)).toEqual(exchange);
	const messages: Message[] = await room.messages();
	expect(messages.filter((m) => m.from === 'product')).toEqual([]);
});

it('keeps the first pending activation when different wakes arrive together', async () => {
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', 'wake-race', 'product'])),
	);
	await seat.hold(true);
	await Promise.all([
		seat.wake({ room: 'wake-race', seat: 'product', activation: 'first' }),
		seat.wake({ room: 'wake-race', seat: 'product', activation: 'second' }),
	]);
	expect(await seat.wakes()).toBe(1);
});

it('forwards steering to the live runner without recording a wake', async () => {
	type FakeRunner = { last?: Steer; steer(value: Steer): Promise<void> };
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', 'steer-forward', 'product'])),
	);
	const fake: FakeRunner = {
		steer(value) {
			this.last = value;
			return Promise.resolve();
		},
	};
	await runInDurableObject(seat, async (instance) => {
		(instance as unknown as { runner: FakeRunner }).runner = fake;
	});
	const steer: Steer = {
		room: 'steer-forward',
		seat: 'product',
		activation: 'message:1:product:1',
		after: 0,
		message: {
			kind: 'said',
			seq: 1,
			at: '2026-01-01T00:00:00.000Z',
			from: 'priya',
			text: 'Context',
		},
	};
	await seat.steer(steer);
	const forwarded = await runInDurableObject(
		seat,
		async (instance) => (instance as unknown as { runner?: FakeRunner }).runner?.last,
	);
	expect(forwarded).toEqual(steer);
	expect(await seat.wakes()).toBe(0);
	expect(
		await runInDurableObject(seat, async (_instance, state) => state.storage.getAlarm()),
	).toBeNull();
	await runInDurableObject(seat, async (instance) => {
		(instance as unknown as { runner?: FakeRunner }).runner = undefined;
	});
});

it('bounds recovery release and clears local state after an unknown result', async () => {
	const name = 'seat-recovery-release-timeout';
	const activation = 'message:1:product:1';
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', name, 'product'])),
	);
	const events: SeatEvent[] = [];
	const defaults = {
		agents: [assistant, product, slow],
		stream,
		limits: { delivery: { resend: 50 } },
	};
	configure({
		...defaults,
		limits: { ...defaults.limits, call: { attempts: 1, timeout: 10 } },
		onSeatEvent: (event) => events.push(event),
	});
	try {
		await runInDurableObject(seat, async (instance, state) => {
			type Internal = {
				metadata: {
					change: (
						change: (current: Readonly<Record<string, unknown>>) => {
							patch: Record<string, unknown>;
						},
					) => Promise<unknown>;
				};
				roomFor: (room: string) => RoomProtocol;
			};
			const object = instance as unknown as Internal;
			await object.metadata.change(() => ({
				patch: { room: name, seat: 'product', activation, phase: 'running' },
			}));
			object.roomFor = () => ({
				view: async () => ({ stale: 'unused' }),
				commit: async () => ({ stale: 'unused' }),
				lease: async () => new Promise<LeaseResponse>(() => {}),
			});
			await state.storage.setAlarm(Date.now());
		});

		await runDurableObjectAlarm(seat);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const metadata = await runInDurableObject(seat, (_instance, state) =>
			seatMetadata(sqlStorage(state)).read(),
		);
		expect(metadata.activation).toBeUndefined();
		expect(events).toContainEqual(
			expect.objectContaining({
				event: 'delivery_error',
				activation,
				operation: 'release',
				error: 'Room call timed out.',
			}),
		);
	} finally {
		configure(defaults);
	}
});

it('keeps newer metadata when a timed out recovery release replies late', async () => {
	const name = 'seat-recovery-release-late';
	const activation = 'message:1:product:1';
	const newer = 'message:2:product:1';
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', name, 'product'])),
	);
	let resolveLate: (response: LeaseResponse) => void = () => {};
	const late = new Promise<LeaseResponse>((resolve) => {
		resolveLate = resolve;
	});
	const events: SeatEvent[] = [];
	const defaults = {
		agents: [assistant, product, slow],
		stream,
		limits: { delivery: { resend: 50 } },
	};
	configure({
		...defaults,
		limits: { ...defaults.limits, call: { attempts: 1, timeout: 10 } },
		onSeatEvent: (event) => events.push(event),
	});
	try {
		await runInDurableObject(seat, async (instance, state) => {
			type Internal = {
				metadata: {
					change: (
						change: (current: Readonly<Record<string, unknown>>) => {
							patch: Record<string, unknown>;
						},
					) => Promise<unknown>;
				};
				roomFor: (room: string) => RoomProtocol;
			};
			const object = instance as unknown as Internal;
			await object.metadata.change(() => ({
				patch: { room: name, seat: 'product', activation, phase: 'running' },
			}));
			const metadata = seatMetadata(sqlStorage(state));
			object.roomFor = () => ({
				view: async () => ({ stale: 'unused' }),
				commit: async () => ({ stale: 'unused' }),
				lease: async () => {
					await metadata.change(() => ({
						patch: { room: name, seat: 'product', activation: newer, phase: 'pending' },
					}));
					return late;
				},
			});
			await state.storage.setAlarm(Date.now());
		});

		await runDurableObjectAlarm(seat);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const metadata = await runInDurableObject(seat, (_instance, state) =>
			seatMetadata(sqlStorage(state)).read(),
		);
		expect(metadata.activation).toBe(newer);
		resolveLate({ ok: { expiresAt: Date.now() + 10_000, lastSeq: 1 } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const afterLate = await runInDurableObject(seat, (_instance, state) =>
			seatMetadata(sqlStorage(state)).read(),
		);
		expect(afterLate.activation).toBe(newer);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: 'delivery_error',
				activation,
				operation: 'release',
				error: 'Room call timed out.',
			}),
		);
	} finally {
		resolveLate({ stale: 'late' });
		configure(defaults);
	}
});

it.each(['idle', 'pending'] as const)(
	'ignores steering to a %s seat without changing metadata or alarms',
	async (phase) => {
		const name = `steer-${phase}`;
		const seat = env.SEAT.get(
			env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', name, 'product'])),
		);
		if (phase === 'pending') {
			await seat.hold(true);
			await seat.wake({ room: name, seat: 'product', activation: 'message:1:product:1' });
		}
		const snapshot = () =>
			runInDurableObject(seat, async (_instance, state) => ({
				metadata: await seatMetadata(sqlStorage(state)).read(),
				alarm: await state.storage.getAlarm(),
			}));
		const before = await snapshot();
		await seat.steer({
			room: name,
			seat: 'product',
			activation: 'message:1:product:1',
			after: 1,
			message: {
				kind: 'said',
				seq: 2,
				at: '2026-01-01T00:00:00.000Z',
				from: 'priya',
				text: 'Later context.',
			},
		});
		expect(await snapshot()).toEqual(before);
		expect(before.alarm).toBeNull();
	},
);
