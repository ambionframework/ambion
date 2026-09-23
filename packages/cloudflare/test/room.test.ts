/**
 * The room object: it starts from names, admits a person, lands a repeated
 * idempotency key once, and resumes over its own storage after eviction.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { Message } from '@ambionframework/ambion';
import { namespaced } from '@ambionframework/journal';
import { expect, it } from 'vitest';
import { sqlStorage } from '../src/storage.ts';
import { evict, inside, roomOf } from './objects.ts';
import { until } from './until.ts';

/** The internals of the room object that a test reaches. */
interface Room {
	visit(person: { name: string; identity: string }): Promise<void>;
	send(input: {
		from: string;
		to?: string;
		text: string;
		key?: string;
	}): Promise<{ owner: string }>;
	leave(name: string): Promise<void>;
	visits: Map<string, { leave(): Promise<void> }>;
	metadata: {
		read(): Promise<Record<string, unknown>>;
		change(change: () => { patch: Record<string, unknown> }): Promise<unknown>;
	};
}

const priya = { name: 'priya', identity: 'Project manager.' };

/** A started room with no agents that priya has visited. */
async function visited(name: string) {
	const stub = roomOf(name);
	await stub.start({ name, agents: [] });
	await stub.visit(priya);
	return stub;
}

async function count(stub: ReturnType<typeof roomOf>, kind: Message['kind']) {
	return (await stub.read()).messages.filter((message) => message.kind === kind).length;
}

const refusesImpostor = (stub: ReturnType<typeof roomOf>) =>
	inside<Room, void>(stub, async (object) => {
		await expect(object.visit({ name: 'priya', identity: 'Impostor.' })).rejects.toThrow(
			/different identity/,
		);
	});

async function presenceOf(stub: ReturnType<typeof roomOf>, name: string) {
	const participants = (await stub.read({ messages: false })).participants;
	const found = participants.find((one) => one.kind === 'human' && one.name === name);
	return found && 'presence' in found ? found.presence : undefined;
}

async function seedStoppedOpen(stub: ReturnType<typeof roomOf>, name: string): Promise<void> {
	await inside<Room, void>(stub, async (object, state) => {
		await object.metadata.change(() => ({ patch: { name, agents: [], stopped: true } }));
		const journal = await namespaced(sqlStorage(state), 'ambion/room').open(name);
		let position = (await journal.read(0)).position;
		const entries = [
			{ kind: 'run', body: { at: '2026-01-01T00:00:00.000Z' }, seq: 1, run: 'seeded-run' },
			{
				kind: 'composition',
				body: { version: 2, agents: [], available: [], at: '2026-01-01T00:00:00.000Z' },
				seq: 2,
				run: 'seeded-run',
			},
			{
				kind: 'message',
				body: {
					kind: 'arrived',
					at: '2026-01-01T00:00:01.000Z',
					from: 'priya',
					subject: 'priya',
					identity: 'Project manager.',
				},
				seq: 3,
				run: 'seeded-run',
			},
			{
				kind: 'message',
				body: { kind: 'said', at: '2026-01-01T00:00:02.000Z', from: 'priya', text: 'Still open?' },
				seq: 4,
				run: 'seeded-run',
			},
		];
		for (const entry of entries) {
			const landed = await journal.append(entry, position);
			if (landed === undefined)
				throw new Error('The seeded record moved while it was being written.');
			position = landed.position;
		}
	});
	await evict(stub, 'reconstruct stopped record');
}

it('starts, admits a person, and returns one plain exchange for repeated sends, also for an empty key', async () => {
	const stub = roomOf('room-test');
	await stub.start({
		name: 'room-test',
		summary: 'assistant',
		seats: { assistant: 'none' },
		agents: ['assistant'],
		goal: 'Decide the pour date.',
	});
	await stub.visit(priya);
	const question = { from: 'priya', text: 'Can I tell the client Thursday?', key: 'question-1' };
	const exchange = await stub.send(question);
	const retry = await stub.send(question);
	expect(exchange).toEqual({ owner: 'priya', from: expect.any(Number), at: expect.any(String) });
	expect(retry).toEqual(exchange);
	const conversation = await stub.waitForClose(exchange.from);
	expect(conversation.map((message) => message.seq)).toEqual([exchange.from]);
	expect(conversation.every((message) => message.kind !== 'summary')).toBe(true);
	// There was no agent answer, so the response milestone is deliberately silent.
	expect(await stub.waitForSummary(exchange.from)).toBeUndefined();

	const messages = (await stub.read()).messages;
	expect(messages.map((m) => [m.kind, m.from])).toEqual([
		['arrived', 'priya'],
		['said', 'priya'],
	]);
	expect(messages[1]).toMatchObject({ key: 'question-1', text: 'Can I tell the client Thursday?' });
	const participants = (await stub.read({ messages: false })).participants;
	expect(participants.map((participant) => participant.name)).toEqual(['assistant', 'priya']);
	// The closed exchange remains reacquirable by its opening sequence.
	expect(await stub.exchange(exchange.from)).toEqual(exchange);

	// An explicitly empty delivery key is still a key across RPC retries.
	const empty = { from: 'priya', text: 'An empty key is still a key.', key: '' };
	expect(await stub.send(empty)).toEqual(await stub.send(empty));
	expect(
		(await stub.read()).messages.filter((message) => message.kind === 'said' && message.key === ''),
	).toHaveLength(1);
});

it('resumes over its own storage after eviction: it fences the old run, keeps the person present, and refuses a conflicting identity', async () => {
	const name = 'room-fence';
	const stub = await visited(name);
	await refusesImpostor(stub);
	const first = await stub.send({ from: 'priya', text: 'Before the restart.', key: 'q1' });
	expect(first.owner).toBe('priya');

	await evict(stub, 'the test takes the object');
	const again = roomOf(name);
	// The next call builds the object again, and its constructor resumes the name.
	// Startup rebuilds the live handle from journal presence, so a send needs no
	// second visit. The abort may still be settling: the call that finds it retries.
	const retry = await until(async () => {
		try {
			return await again.send({ from: 'priya', text: 'After the restart.', key: 'q2' });
		} catch {
			return undefined;
		}
	});
	expect(retry.owner).toBe('priya');
	// The rebuild's visit is idempotent, so it adds no arrival.
	expect(await count(again, 'arrived')).toBe(1);
	expect(await presenceOf(again, 'priya')).toBe('present');
	await refusesImpostor(again);

	const runs = await until(async () =>
		runInDurableObject(again, async (_instance, state) => {
			const journal = await namespaced(sqlStorage(state), 'ambion/room').open(name);
			const stored = (await journal.read(0)).entries.map(
				(entry) => entry.entry as { kind: string; run?: string },
			);
			const runs = stored.filter((entry) => entry.kind === 'run');
			return runs.length > 1 ? runs : undefined;
		}),
	);
	// Two runs, each with a name of its own: the second run's fence stands, and an
	// entry the first run writes past it is void for every reader. The journal
	// stamps the run beside every body, and a run entry is where the fence reads it.
	const ids = runs.map((entry) => entry.run ?? '');
	expect(ids).toHaveLength(2);
	expect(new Set(ids).size).toBe(2);
	// The record holds both messages: the resume lost nothing.
	const messages = (await again.read()).messages;
	expect(messages.filter((m) => m.kind === 'said').map((m) => m.key)).toEqual(['q1', 'q2']);
});

it('does not persist malformed visits and makes repeated leave harmless', async () => {
	const stub = roomOf('room-malformed-visit');
	await stub.start({ name: 'room-malformed-visit', agents: [] });
	const metadata = await inside<Room, Record<string, unknown>>(stub, async (object) => {
		await expect(object.visit({ name: 'Not valid', identity: 'Unknown.' })).rejects.toThrow(
			/Invalid participant name/,
		);
		return object.metadata.read();
	});
	expect(metadata.people).toBeUndefined();
	await stub.visit(priya);
	await stub.leave('priya');
	await expect(stub.leave('priya')).resolves.toBeUndefined();
	await inside<Room, void>(stub, async (object) => {
		await expect(object.send({ from: 'priya', text: 'Must not reenter.' })).rejects.toThrow(
			/has not visited/,
		);
	});
	expect(await count(stub, 'arrived')).toBe(1);
	expect(await count(stub, 'left')).toBe(1);
});

it('rejects a conflicting delivery key payload and recipient over RPC', async () => {
	const name = 'room-delivery-conflict';
	const stub = roomOf(name);
	await stub.start({ name, agents: ['assistant'] });
	await stub.visit(priya);
	await stub.visit({ name: 'sam', identity: 'Engineering lead.' });
	await inside<Room, void>(stub, async (object) => {
		await object.send({ from: 'priya', to: 'assistant', text: 'Original.', key: 'same' });
		for (const changed of [
			{ from: 'priya', to: 'assistant', text: 'Changed.' },
			{ from: 'sam', to: 'assistant', text: 'Original.' },
			{ from: 'priya', text: 'Original.' },
		])
			await expect(object.send({ ...changed, key: 'same' })).rejects.toThrow(
				/different room operation/,
			);
	});
});

it('rebuilds an admitted visit after the adapter loses its cache on eviction', async () => {
	const name = 'room-interrupted-admission';
	const stub = roomOf(name);
	await stub.start({ name, agents: [] });
	await inside<Room, void>(stub, async (object) => {
		const originalSet = object.visits.set.bind(object.visits);
		object.visits.set = ((key: string, value: { leave(): Promise<void> }) => {
			if (key === 'priya') throw new Error('lose adapter admission cache');
			return originalSet(key, value);
		}) as typeof object.visits.set;
		await expect(object.visit(priya)).rejects.toThrow(/lose adapter admission cache/);
	});
	await evict(stub, 'lose adapter admission cache');
	const again = roomOf(name);
	const exchange = await inside<Room, { owner: string }>(again, (object) =>
		object.send({ from: 'priya', text: 'The admitted visit survived.', key: 'q1' }),
	);
	expect(exchange.owner).toBe('priya');
	expect(await count(again, 'arrived')).toBe(1);
});

it('keeps a departed human absent after restart', async () => {
	const name = 'room-departure-restart';
	const stub = await visited(name);
	await stub.leave('priya');
	await evict(stub, 'reconstruct after departure');
	const again = roomOf(name);
	await until(() =>
		presenceOf(again, 'priya').then(
			(presence) => presence === 'absent',
			() => false,
		),
	);
	await inside<Room, void>(again, async (object) => {
		await expect(object.send({ from: 'priya', text: 'Must stay absent.' })).rejects.toThrow(
			/has not visited/,
		);
		await object.leave('priya');
	});
	expect(await count(again, 'arrived')).toBe(1);
});

it('does not delete a deliberately reentered handle after an older leave returns', async () => {
	const stub = await visited('room-leave-reentry-fence');
	await inside<Room, void>(stub, async (object) => {
		const old = object.visits.get('priya');
		if (old === undefined) throw new Error('The test visit was not cached.');
		const original = old.leave.bind(old);
		const gate = Promise.withResolvers<void>();
		const departure = Promise.withResolvers<void>();
		old.leave = async () => {
			await original();
			departure.resolve();
			await gate.promise;
		};
		const leaving = object.leave('priya');
		await departure.promise;
		await object.visit(priya);
		gate.resolve();
		await leaving;
		await object.send({ from: 'priya', text: 'The new visit remains cached.', key: 'q1' });
	});
	expect(await count(stub, 'arrived')).toBe(2);
	expect(await count(stub, 'left')).toBe(1);
});

it('can ensure a resumed room and report its current state', async () => {
	const stub = roomOf('room-status');
	const composition = { name: 'room-status', assistant: 'assistant', agents: [] } as const;
	await stub.ensureStart(composition);
	await stub.ensureStart(composition);
	await expect(stub.read()).resolves.toMatchObject({
		name: 'room-status',
		exchange: undefined,
	});
	// @ts-expect-error The object has no messages(): read() carries the record.
	void stub.messages;
	// @ts-expect-error The object has no status(): read() carries the record.
	void stub.status;
});

it('keeps a stopped record readable without resuming the room, and runs the alarm only while the room runs', async () => {
	await expect(runDurableObjectAlarm(roomOf('room-alarm-idle'))).resolves.toBe(false);
	const stub = await visited('room-stopped-status');
	const exchange = await stub.send({
		from: 'priya',
		text: 'A durable question?',
		key: 'stopped-1',
	});
	await stub.waitForClose(exchange.from);
	await stub.waitForSummary(exchange.from);
	await runInDurableObject(stub, (instance) => instance.alarm());
	await stub.stop();
	await runInDurableObject(stub, (instance) => instance.alarm());
	expect(await stub.read()).toMatchObject({
		name: 'room-stopped-status',
		initialized: true,
		exchange: undefined,
		exchanges: [{ status: 'closed', from: exchange.from, summary: { status: 'silent' } }],
	});
	expect(await stub.exchange(exchange.from)).toEqual(exchange);
});

it('reads a stopped open exchange and reconstructs it after eviction', async () => {
	await seedStoppedOpen(roomOf('room-stopped-open'), 'room-stopped-open');
	const again = roomOf('room-stopped-open');
	const stopped = await again.read({ messages: false });
	expect(stopped.exchange).toMatchObject({ status: 'open', from: 4 });
	expect(stopped.watermark).toBe(4);
	expect((await again.read()).messages).toHaveLength(2);
});

it('retains the stopped handle when saving stop metadata fails', async () => {
	const stub = roomOf('room-stop-retry');
	await stub.start({ name: 'room-stop-retry', agents: [] });
	type Stoppable = {
		metadata: { change: (...args: never[]) => Promise<unknown> };
		stop(): Promise<void>;
	};
	await inside<Stoppable, void>(stub, async (object) => {
		const original = object.metadata.change.bind(object.metadata);
		let fail = true;
		object.metadata.change = (...args) => {
			if (!fail) return original(...args);
			fail = false;
			return Promise.reject(new Error('metadata write failed'));
		};
		await expect(object.stop()).rejects.toThrow('metadata write failed');
		await object.stop();
	});
	const again = roomOf('room-stop-retry');
	await expect(again.read({ messages: false })).resolves.toMatchObject({ initialized: true });
});

it('leaves an uninitialized named record for an explicit start retry', async () => {
	const name = 'room-uninitialized-retry';
	const stub = roomOf(name);
	await inside<Room, void>(stub, async (object) => {
		await object.metadata.change(() => ({
			patch: { name, agents: ['assistant'], stopped: false },
		}));
	});
	await evict(stub, 'reconstruct uninitialized object');
	const again = roomOf(name);
	await expect(again.read({ messages: false })).resolves.toMatchObject({
		name,
		initialized: false,
	});
	await again.start({ name, agents: [] });
	await expect(again.read({ messages: false })).resolves.toMatchObject({
		name,
		initialized: true,
	});
});

it('changes membership by name without installing a definition', async () => {
	const stub = roomOf('room-roster');
	await stub.start({
		name: 'room-roster',
		summary: 'assistant',
		agents: ['product', 'assistant'],
		seats: { assistant: 'none' },
	});
	const names = async () =>
		(await stub.read({ messages: false })).participants.map((participant) => participant.name);
	expect(await names()).toEqual(['assistant']);
	await stub.seat('product', { attention: 'named' });
	expect(
		(await stub.read({ messages: false })).participants.find(
			(participant) => participant.name === 'product',
		),
	).toMatchObject({ attention: 'named' });
	await stub.unseat('product');
	expect(await names()).toEqual(['assistant']);
});
