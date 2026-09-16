/**
 * The seat object: a wake sets its alarm, the alarm runs one activation
 * against the room over RPC, and a wake a seat on hold never takes is sent
 * again by the room's own alarm. Alarms fire on their own inside workerd,
 * so the test waits for what they do.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Message } from '@ambionframework/ambion';
import type { Steer } from '@ambionframework/ambion/transport';
import { namespaced } from '@ambionframework/journal';
import { piSessions } from '@ambionframework/pi-journal';
import { expect, it } from 'vitest';
import { seatMetadata, sqlStorage } from '../src/storage.ts';
import { until } from './until.ts';

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
	await room.exchangeMessages(secondExchange.from);
	expect(await room.exchange(secondExchange.from)).toEqual(secondExchange);
});

it('takes the cut the room sends over RPC when it revokes a wake', async () => {
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

	// the room writes off every wake it owes, and tells the seat side over the wire
	await room.abort();
	expect(await until(() => seat.cuts())).toBe(1);
	// the lease the room revoked ends on the record, so the alarm claims nothing
	const revoked = await until(async () =>
		runInDurableObject(room, async (_instance, state) => {
			const journal = await namespaced(sqlStorage(state), 'ambion/room').open('cut-test');
			const stored = (await journal.read(0)).entries.map(
				(entry) =>
					entry.entry as {
						kind: string;
						body: LeaseObservation;
					},
			);
			const leases = stored.filter((entry) => entry.kind === 'lease').map((entry) => entry.body);
			return leases.find((lease) => lease.phase === 'ended' && lease.reason === 'revoked');
		}),
	);
	expect(revoked).toMatchObject({ id: 'message:4:product:1', reason: 'revoked' });
	await runDurableObjectAlarm(seat);
	// The revoked exchange still closes durably and remains addressable by its
	// opening sequence, while the product has no answer to publish.
	await room.exchangeMessages(exchange.from);
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

it('forwards steering to the live actor without recording a wake', async () => {
	type FakeActor = { last?: Steer; steer(value: Steer): Promise<void> };
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', 'steer-forward', 'product'])),
	);
	const fake: FakeActor = {
		steer(value) {
			this.last = value;
			return Promise.resolve();
		},
	};
	await runInDurableObject(seat, async (instance) => {
		(instance as unknown as { actor: FakeActor }).actor = fake;
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
		async (instance) => (instance as unknown as { actor?: FakeActor }).actor?.last,
	);
	expect(forwarded).toEqual(steer);
	expect(await seat.wakes()).toBe(0);
	expect(
		await runInDurableObject(seat, async (_instance, state) => state.storage.getAlarm()),
	).toBeNull();
	await runInDurableObject(seat, async (instance) => {
		(instance as unknown as { actor?: FakeActor }).actor = undefined;
	});
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
