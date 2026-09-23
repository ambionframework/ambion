/**
 * The seat object: a wake sets its alarm, the alarm runs one activation
 * against the room over RPC, and a wake a seat on hold never takes is sent
 * again by the room's own alarm. Alarms fire on their own inside workerd,
 * so the test waits for what they do.
 */

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { TraceRecord } from '@ambionframework/ambion';
import type { LeaseResponse, RoomProtocol, Steer } from '@ambionframework/ambion/hosting';
import { namespaced } from '@ambionframework/journal';
import { expect, it, onTestFinished } from 'vitest';
import { configure, type SeatEvent } from '../src/configure.ts';
import { seatMetadata, sqlStorage } from '../src/storage.ts';
import { inside, roomOf, seatOf } from './objects.ts';
import { until } from './until.ts';
import { configuration } from './worker.ts';

type LeaseObservation = { id: string; phase: 'running' | 'ended'; reason?: string };

/** A room whose product seat answers, with priya's first question sent. */
async function asked(name: string) {
	const room = roomOf(name);
	const seat = seatOf(name);
	await room.start({
		name,
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
	return { room, seat, exchange };
}

it('wakes, runs the activation on its alarm, and the room sends an untaken wake again', async () => {
	const records: TraceRecord[] = [];
	configure({ ...configuration, logger: (record) => void records.push(record) });
	onTestFinished(() => configure(configuration));
	const { room, seat } = await asked('seat-test');

	// the seat's alarm runs the activation: a lease claimed, a say, the lease renewed at the
	// end of the pass, and released. workerd may run the alarm first; the call then returns.
	await runDurableObjectAlarm(seat);
	const said = await until(async () => {
		const messages = (await room.read()).messages;
		return messages.find((m) => m.kind === 'said' && m.from === 'product');
	});
	expect(said).toMatchObject({
		activationId: 'message:4:product:1',
		text: 'The pour is Saturday.',
	});
	const leases = await until(async () =>
		runInDurableObject(room, async (_instance, state) => {
			const journal = await namespaced(sqlStorage(state), 'ambion/room').open('seat-test');
			const found = (await journal.read(0)).entries
				.map((entry) => entry.entry as { kind: string; body: LeaseObservation })
				.filter((entry) => entry.kind === 'lease' && entry.body.id === 'message:4:product:1')
				.map((entry) => entry.body);
			return found.at(-1)?.phase === 'ended' ? found : undefined;
		}),
	);
	expect(leases.map((lease) => lease?.phase)).toEqual(['running', 'running', 'ended']);
	expect(leases.at(-1)).toMatchObject({ id: 'message:4:product:1', reason: 'released' });
	// the seat gives the activation's steps to the configured logger
	const traced = records.filter(
		(record) => record.room === 'seat-test' && record.step.activation === 'message:4:product:1',
	);
	expect(traced.length).toBeGreaterThanOrEqual(3);
	expect(traced.every((record) => record.seat === 'product')).toBe(true);
	expect(traced.some((record) => record.step.type === 'end')).toBe(true);

	// a seat on hold keeps the next wake and runs nothing: the room's alarm sends it again
	await seat.hold(true);
	const secondExchange = await room.send({ from: 'priya', text: 'And the pump?', key: 'q2' });
	expect(await until(async () => (await seat.wakes()) >= 3)).toBe(true);
	expect(
		(await room.read({ messages: false })).participants.find((s) => s.name === 'product'),
	).toMatchObject({
		status: 'active',
	});
	// the hold lifts: the seat takes the wake it holds, and the exchange closes
	await seat.hold(false);
	const answered = await until(async () => {
		const messages = (await room.read()).messages;
		return messages.filter((m) => m.kind === 'said' && m.from === 'product').length === 2;
	});
	expect(answered).toBe(true);
	await room.waitForClose(secondExchange.from);
	expect(await room.exchange(secondExchange.from)).toEqual(secondExchange);
});

it('runs one activation when a second alarm starts while the first runs', async () => {
	type Seat = { alarm(): Promise<void>; roomFor(room: string): RoomProtocol };
	// The hold keeps workerd from firing the alarm, so the test starts both. The first run
	// holds its lease and waits at its say until the second alarm has returned.
	const seat = seatOf('alarm-twice');
	await seat.hold(true);
	const { room } = await asked('alarm-twice');
	await inside<Seat, void>(seat, async (object) => {
		const roomFor = object.roomFor.bind(object);
		let saying = () => {};
		const reached = new Promise<void>((resolve) => {
			saying = resolve;
		});
		let open = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		object.roomFor = (name) => {
			const protocol = roomFor(name);
			return {
				...protocol,
				commit: async (commit) => {
					saying();
					await gate;
					return protocol.commit(commit);
				},
			};
		};
		const first = object.alarm();
		await reached;
		await object.alarm();
		open();
		await first;
	});
	const said = (await room.read()).messages.filter(
		(m) => m.kind === 'said' && m.from === 'product',
	);
	expect(said).toMatchObject([{ activationId: 'message:4:product:1' }]);
	const leases = await runInDurableObject(room, async (_instance, state) => {
		const journal = await namespaced(sqlStorage(state), 'ambion/room').open('alarm-twice');
		return (await journal.read(0)).entries
			.map((entry) => entry.entry as { kind: string; body: LeaseObservation })
			.filter((entry) => entry.kind === 'lease')
			.map((entry) => entry.body);
	});
	expect(leases.map((lease) => lease.reason ?? lease.phase)).toEqual([
		'running',
		'running',
		'released',
	]);
});

it('cancels an unclaimed wake over RPC and closes its exchange', async () => {
	const { room, seat, exchange } = await asked('cut-test');

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
	const messages = (await room.read()).messages;
	expect(messages.filter((m) => m.from === 'product')).toEqual([]);
});

it('keeps the first pending activation when different wakes arrive together', async () => {
	const seat = seatOf('wake-race');
	await seat.hold(true);
	await Promise.all([
		seat.wake({ room: 'wake-race', seat: 'product', activation: 'first' }),
		seat.wake({ room: 'wake-race', seat: 'product', activation: 'second' }),
	]);
	expect(await seat.wakes()).toBe(1);
});

it('forwards steering to the live runner without recording a wake', async () => {
	type Runner = { last?: Steer; steer(value: Steer): Promise<void> };
	type Holder = { runner?: Runner };
	const seat = seatOf('steer-forward');
	const runner: Runner = {
		steer(value) {
			this.last = value;
			return Promise.resolve();
		},
	};
	await inside<Holder, void>(seat, async (object) => {
		object.runner = runner;
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
	expect(
		await inside<Holder, Steer | undefined>(seat, async (object) => object.runner?.last),
	).toEqual(steer);
	expect(await seat.wakes()).toBe(0);
	expect(
		await runInDurableObject(seat, async (_instance, state) => state.storage.getAlarm()),
	).toBeNull();
	await inside<Holder, void>(seat, async (object) => {
		object.runner = undefined;
	});
});

type SeatInternals = {
	metadata: {
		change: (
			change: (current: Readonly<Record<string, unknown>>) => {
				patch: Record<string, unknown>;
			},
		) => Promise<unknown>;
	};
	roomFor: (room: string) => RoomProtocol;
};

/**
 * A seat that recovers a running activation on its alarm, against a room whose
 * release call `lease` answers. A room call times out after 10 ms. The test
 * restores the tier configuration when it ends.
 */
async function recovering(
	name: string,
	lease: (metadata: ReturnType<typeof seatMetadata>) => Promise<LeaseResponse>,
) {
	const activation = 'message:1:product:1';
	const seat = seatOf(name);
	const events: SeatEvent[] = [];
	configure({
		...configuration,
		limits: { ...configuration.limits, call: { attempts: 1, timeout: 10 } },
		onSeatEvent: (event) => events.push(event),
	});
	onTestFinished(() => configure(configuration));
	await inside<SeatInternals, void>(seat, async (object, state) => {
		await object.metadata.change(() => ({
			patch: { room: name, seat: 'product', activation, phase: 'running' },
		}));
		const metadata = seatMetadata(sqlStorage(state));
		object.roomFor = () => ({
			view: async () => ({ stale: 'unused' }),
			commit: async () => ({ stale: 'unused' }),
			lease: () => lease(metadata),
		});
		await state.storage.setAlarm(Date.now());
	});
	await runDurableObjectAlarm(seat);
	await new Promise((resolve) => setTimeout(resolve, 25));
	const read = () =>
		runInDurableObject(seat, (_instance, state) => seatMetadata(sqlStorage(state)).read());
	const timedOut = () =>
		expect(events).toContainEqual(
			expect.objectContaining({
				event: 'delivery_error',
				activation,
				operation: 'release',
				error: 'Room call timed out.',
			}),
		);
	return { read, timedOut };
}

it('bounds recovery release and clears local state after an unknown result', async () => {
	const { read, timedOut } = await recovering(
		'seat-recovery-release-timeout',
		() => new Promise<LeaseResponse>(() => {}),
	);
	expect((await read()).activation).toBeUndefined();
	timedOut();
});

it('keeps newer metadata when a timed out recovery release replies late', async () => {
	const newer = 'message:2:product:1';
	const late = Promise.withResolvers<LeaseResponse>();
	onTestFinished(() => late.resolve({ stale: 'late' }));
	const name = 'seat-recovery-release-late';
	const { read, timedOut } = await recovering(name, async (metadata) => {
		await metadata.change(() => ({
			patch: { room: name, seat: 'product', activation: newer, phase: 'pending' },
		}));
		return late.promise;
	});
	expect((await read()).activation).toBe(newer);
	late.resolve({ ok: { expiresAt: Date.now() + 10_000, lastSeq: 1 } });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect((await read()).activation).toBe(newer);
	timedOut();
});

it.each(['idle', 'pending'] as const)(
	'ignores steering to a %s seat without changing metadata or alarms',
	async (phase) => {
		const name = `steer-${phase}`;
		const seat = seatOf(name);
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
