/**
 * The room object: it starts from names, admits a person, and lands a
 * repeated idempotency key once.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import type { Message } from '@ambionframework/ambion';
import { namespaced } from '@ambionframework/journal';
import { expect, it } from 'vitest';
import { sqlStorage } from '../src/storage.ts';
import { until } from './until.ts';

it('starts, admits a person, and returns one plain exchange for repeated sends', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-test'));
	await stub.start({
		name: 'room-test',
		summary: 'assistant',
		seats: { assistant: 'none' },
		agents: ['assistant'],
		goal: 'Decide the pour date.',
	});
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const exchange = await stub.send({
		from: 'priya',
		text: 'Can I tell the client Thursday?',
		key: 'question-1',
	});
	const retry = await stub.send({
		from: 'priya',
		text: 'Can I tell the client Thursday, again?',
		key: 'question-1',
	});
	expect(exchange).toEqual({ owner: 'priya', from: expect.any(Number), at: expect.any(String) });
	expect(retry).toEqual(exchange);
	const conversation = await stub.exchangeMessages(exchange.from);
	expect(conversation.map((message) => message.seq)).toEqual([exchange.from]);
	expect(conversation.every((message) => message.kind !== 'summary')).toBe(true);
	// There was no agent answer, so the response milestone is deliberately silent.
	expect(await stub.response(exchange.from)).toBeUndefined();

	const messages = await stub.messages();
	expect(messages.map((m) => [m.kind, m.from])).toEqual([
		['arrived', 'priya'],
		['said', 'priya'],
	]);
	expect(messages[1]).toMatchObject({ key: 'question-1', text: 'Can I tell the client Thursday?' });
	const participants = await stub.participants();
	expect(participants.map((participant) => participant.name)).toEqual(['assistant', 'priya']);
	// The closed exchange remains reacquirable by its opening sequence.
	expect(await stub.exchange(exchange.from)).toEqual(exchange);
});

it('resumes over its own storage after an abort, and fences the run before it', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-fence'));
	await stub.start({
		name: 'room-fence',
		summary: 'assistant',
		seats: { assistant: 'none' },
		agents: ['assistant'],
	});
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.send({ from: 'priya', text: 'First?', key: 'q1' });

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
			await again.send({ from: 'priya', text: 'Second?', key: 'q2' });
			return true;
		} catch {
			return false;
		}
	});

	const runs = await until(async () =>
		runInDurableObject(again, async (_instance, state) => {
			const journal = await namespaced(sqlStorage(state), 'ambion/room').open('room-fence');
			const stored = (await journal.read(0)).entries.map(
				(entry) => entry.entry as { kind: string; run?: string },
			);
			const runs = stored.filter((entry) => entry.kind === 'run');
			return runs.length > 1 ? runs : undefined;
		}),
	);
	// two runs, each with a name of its own: the second run's fence stands,
	// and an entry the first run writes past it is void for every reader
	// The journal stamps the run beside every body, and a run entry is where the fence reads it.
	const ids = (runs ?? []).map((entry) => entry.run ?? '');
	expect(ids).toHaveLength(2);
	expect(new Set(ids).size).toBe(2);
	// the record holds both messages: the resume lost nothing
	const messages: Message[] = await again.messages();
	expect(messages.filter((m) => m.kind === 'said').map((m) => m.key)).toEqual(['q1', 'q2']);
});

it('changes membership by name without installing a definition', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-roster'));
	await stub.start({
		name: 'room-roster',
		summary: 'assistant',
		agents: ['product', 'assistant'],
		seats: { assistant: 'none', ...{} },
	});
	expect((await stub.participants()).map((participant) => participant.name)).toEqual(['assistant']);
	await stub.seat('product', { attention: 'named' });
	expect(
		(await stub.participants()).find((participant) => participant.name === 'product'),
	).toMatchObject({
		attention: 'named',
	});
	await stub.unseat('product');
	expect((await stub.participants()).map((participant) => participant.name)).toEqual(['assistant']);
});
