/**
 * The room object: it starts from names, admits a person, and lands a
 * repeated delivery key once.
 */
import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { until } from './until.ts';

it('starts, admits a person, and lands one message for two deliveries under one key', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-test'));
	await stub.start({
		name: 'room-test',
		assistant: 'assistant',
		agents: [],
		goal: 'Decide the pour date.',
	});
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.deliver({ from: 'priya', text: 'Can I tell the client Thursday?', key: 'delivery-1' });
	await stub.deliver({
		from: 'priya',
		text: 'Can I tell the client Thursday, again?',
		key: 'delivery-1',
	});

	const messages = await stub.messages();
	expect(messages.map((m) => [m.kind, m.from])).toEqual([
		['arrived', 'priya'],
		['said', 'priya'],
	]);
	expect(messages[1]).toMatchObject({ key: 'delivery-1', text: 'Can I tell the client Thursday?' });
	const seats = await stub.seats();
	expect(seats.map((s) => s.name)).toEqual(['assistant', 'priya']);
	// nobody was there to answer, so the exchange closed at the room's next reconcile
	expect(await until(async () => (await stub.exchange()) === undefined)).toBe(true);
});
