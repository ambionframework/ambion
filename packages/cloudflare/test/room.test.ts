/**
 * The room object: it starts from names, admits a person, and lands a
 * repeated delivery key once.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import type { Message } from '@ambionframework/ambion';
import type { RunRow } from '@ambionframework/ambion/protocol';
import { expect, it } from 'vitest';
import { sqlSessions } from '../src/storage.ts';
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

it('resumes over its own storage after an abort, and fences the run before it', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-fence'));
	await stub.start({ name: 'room-fence', assistant: 'assistant', agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.deliver({ from: 'priya', text: 'First?', key: 'q1' });

	// the object goes away mid-life, the way the platform may take it. The abort
	// breaks the stub that held it, so what comes next takes a stub of its own.
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('the test takes the object');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName('room-fence'));
	// the next call builds the object again, and its constructor resumes the name
	await until(async () => {
		// The abort may still be settling: the call that finds it retries.
		try {
			await again.deliver({ from: 'priya', text: 'Second?', key: 'q2' });
			return true;
		} catch {
			return false;
		}
	});

	const runs = await until(async () =>
		runInDurableObject(again, async (_instance, state) => {
			const piSession = await sqlSessions(state).open('room-fence');
			const rows = await piSession.findEntries({ customType: 'ambion/run' });
			return rows.length > 1 ? rows : undefined;
		}),
	);
	// two runs, each with a name of its own: the fence is the second one's row,
	// and an entry the first run writes past it is void for every reader
	const ids = (runs ?? []).map((row) => (row.type === 'custom' ? (row.data as RunRow).run : ''));
	expect(ids).toHaveLength(2);
	expect(new Set(ids).size).toBe(2);
	// the record holds both deliveries: the resume lost nothing
	const messages: Message[] = await again.messages();
	expect(messages.filter((m) => m.kind === 'said').map((m) => m.key)).toEqual(['q1', 'q2']);
});
