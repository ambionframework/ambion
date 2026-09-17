/** Working rooms share the origin object and retain distinct seat identities. */
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { seatMetadata, sqlStorage } from '../src/storage.ts';
import { until } from './until.ts';

async function begin(name: string, text: string) {
	const room = env.ROOM.get(env.ROOM.idFromName(name));
	await room.start({
		name,
		agents: ['task-owner', 'task-worker', 'task-slow'],
		seats: { 'task-owner': 'broadcast' },
	});
	await room.visit({ name: 'priya', identity: 'Project manager.' });
	const exchange = await room.send({ from: 'priya', text, key: 'assignment' });
	return { room, exchange };
}

it('executes a Task through a child seat and the originating room object', async () => {
	const { room, exchange } = await begin('task-rpc', 'Run a Task.');
	await room.waitForClose(exchange.from);
	const snapshot = await room.read();
	expect(snapshot.tasks).toHaveLength(1);
	expect(snapshot.tasks[0]).toMatchObject({
		status: 'succeeded',
		outcome: 'The remote Task completed.',
	});
	const task = snapshot.tasks[0];
	if (task === undefined) throw new Error('The Task was not recorded.');
	const seat = env.SEAT.get(
		env.SEAT.idFromName(JSON.stringify(['ambion/seat-object', task.workingRoom, 'task-worker'])),
	);
	const metadata = await runInDurableObject(seat, async (_instance, state) =>
		seatMetadata(sqlStorage(state)).read(),
	);
	expect(metadata).toMatchObject({ room: task.workingRoom, hostRoom: 'task-rpc' });
	expect(snapshot.messages.filter((message) => 'taskId' in message)).toHaveLength(1);
});

it('reconstructs a working room before its remote seat returns after eviction', async () => {
	const name = 'task-restart';
	const { room, exchange } = await begin(name, 'Please recover Task execution.');
	await until(async () => {
		const snapshot = await room.read({ messages: false });
		return snapshot.tasks.find((task) => task.status === 'open');
	});
	await runInDurableObject(room, async (_instance, state) => {
		state.abort('reconstruct Task rooms');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName(name));
	await until(async () => {
		try {
			const snapshot = await again.read();
			return snapshot.exchange === undefined && snapshot.tasks[0]?.status === 'succeeded';
		} catch {
			return false;
		}
	});
	const snapshot = await again.read();
	expect(snapshot.tasks).toHaveLength(1);
	expect(snapshot.exchanges).toContainEqual(
		expect.objectContaining({ from: exchange.from, status: 'closed' }),
	);
	expect(snapshot.messages.filter((message) => 'taskId' in message)).toHaveLength(1);
});
