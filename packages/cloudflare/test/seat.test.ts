/**
 * The seat object: a wake sets its alarm, the alarm runs one activation
 * against the room over RPC, and a wake a seat on hold never takes is sent
 * again by the room's own alarm. Alarms fire on their own inside workerd,
 * so the test waits for what they do.
 */

import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { LeaseChange, Message } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { sqlSessions } from '../src/storage.ts';
import { until } from './until.ts';

it('wakes, runs the activation on its alarm, and the room sends an untaken wake again', async () => {
	const room = env.ROOM.get(env.ROOM.idFromName('seat-test'));
	const seat = env.SEAT.get(env.SEAT.idFromName('seat-test:product'));
	await room.start({ name: 'seat-test', assistant: 'assistant', agents: ['product'] });
	await room.visit({ name: 'priya', identity: 'Project manager.' });
	await room.deliver({ from: 'priya', text: 'When is the pour?', key: 'q1' });
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
		activationId: 'message:2:product:1',
		text: 'The pour is Saturday.',
	});
	const leases = await until(async () =>
		runInDurableObject(room, async (_instance, state) => {
			const piSession = await sqlSessions(state).open('seat-test');
			const stored = await piSession.findEntries({ customType: 'ambion/lease' });
			const found = stored.map((entry) =>
				entry.type === 'custom' ? (entry.data as LeaseChange) : undefined,
			);
			return found.at(-1)?.phase === 'ended' ? found : undefined;
		}),
	);
	expect(leases.map((lease) => lease?.phase)).toEqual(['running', 'running', 'ended']);
	expect(leases.at(-1)).toMatchObject({ id: 'message:2:product:1', reason: 'released' });
	// the seat's audit session holds the activation's turns, in the seat's own storage
	const audited = await runInDurableObject(seat, async (_instance, state) => {
		const piSession = await sqlSessions(state).open('seat-test:product');
		return (await piSession.findEntries()).map((entry) => entry.type);
	});
	expect(audited[0]).toBe('custom');
	expect(audited.filter((type) => type === 'message').length).toBeGreaterThanOrEqual(3);

	// a seat on hold keeps the next wake and runs nothing: the room's alarm sends it again
	await seat.hold(true);
	await room.deliver({ from: 'priya', text: 'And the pump?', key: 'q2' });
	expect(await until(async () => (await seat.wakes()) >= 3)).toBe(true);
	expect((await room.seats()).find((s) => s.name === 'product')).toMatchObject({
		status: 'active',
	});
	// the hold lifts: the seat takes the wake it holds, and the exchange closes
	await seat.hold(false);
	const answered = await until(async () => {
		const messages: Message[] = await room.messages();
		return messages.filter((m) => m.kind === 'said' && m.from === 'product').length === 2;
	});
	expect(answered).toBe(true);
	expect(await until(async () => (await room.exchange()) === undefined)).toBe(true);
});

it('takes the cut the room sends over RPC when it revokes a wake', async () => {
	const room = env.ROOM.get(env.ROOM.idFromName('cut-test'));
	const seat = env.SEAT.get(env.SEAT.idFromName('cut-test:product'));
	await room.start({ name: 'cut-test', assistant: 'assistant', agents: ['product'] });
	await room.visit({ name: 'priya', identity: 'Project manager.' });
	await room.deliver({ from: 'priya', text: 'When is the pour?', key: 'q1' });
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
			const piSession = await sqlSessions(state).open('cut-test');
			const stored = await piSession.findEntries({ customType: 'ambion/lease' });
			const leases = stored.flatMap((entry) =>
				entry.type === 'custom' ? [entry.data as LeaseChange] : [],
			);
			return leases.find((lease) => lease.phase === 'ended' && lease.reason === 'revoked');
		}),
	);
	expect(revoked).toMatchObject({ id: 'message:2:product:1', reason: 'revoked' });
	await runDurableObjectAlarm(seat);
	const messages: Message[] = await room.messages();
	expect(messages.filter((m) => m.from === 'product')).toEqual([]);
});
