/**
 * The room object: it starts from names, admits a person, and lands a
 * repeated idempotency key once.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { namespaced } from '@ambionframework/journal';
import { expect, it } from 'vitest';
import { sqlStorage } from '../src/storage.ts';
import { until } from './until.ts';

async function seedStoppedOpen(stub: DurableObjectStub, name: string): Promise<void> {
	await runInDurableObject(stub, async (instance, state) => {
		type MetadataObject = {
			metadata: { change: (change: () => { patch: Record<string, unknown> }) => Promise<unknown> };
		};
		const object = instance as unknown as MetadataObject;
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
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('reconstruct stopped record');
	}).catch(() => {});
}

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
		text: 'Can I tell the client Thursday?',
		key: 'question-1',
	});
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
});

it('rejects conflicting identity without poisoning send or restart recovery', async () => {
	const name = 'room-identity-conflict';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			visit(person: { name: string; identity: string }): Promise<void>;
		};
		await expect(object.visit({ name: 'priya', identity: 'Impostor.' })).rejects.toThrow(
			/different identity/,
		);
	});
	const first = await stub.send({
		from: 'priya',
		text: 'The admitted identity remains usable.',
		key: 'q1',
	});
	expect(first.owner).toBe('priya');

	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('reconstruct after identity conflict');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName(name));
	const retry = await until(async () => {
		try {
			return await again.send({ from: 'priya', text: 'After restart.', key: 'q2' });
		} catch {
			return undefined;
		}
	});
	expect(retry.owner).toBe('priya');
	await runInDurableObject(again, async (instance) => {
		const object = instance as unknown as {
			visit(person: { name: string; identity: string }): Promise<void>;
		};
		await expect(object.visit({ name: 'priya', identity: 'Impostor.' })).rejects.toThrow(
			/different identity/,
		);
	});
});

it('does not persist malformed visits and makes repeated leave harmless', async () => {
	const name = 'room-malformed-visit';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			visit(person: { name: string; identity: string }): Promise<void>;
		};
		await expect(object.visit({ name: 'Not valid', identity: 'Unknown.' })).rejects.toThrow(
			/Invalid participant name/,
		);
	});
	const metadata = await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			metadata: { read(): Promise<Record<string, unknown>> };
		};
		return object.metadata.read();
	});
	expect(metadata.people).toBeUndefined();
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.leave('priya');
	await expect(stub.leave('priya')).resolves.toBeUndefined();
	await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			send(input: { from: string; text: string }): Promise<unknown>;
		};
		await expect(object.send({ from: 'priya', text: 'Must not reenter.' })).rejects.toThrow(
			/has not visited/,
		);
	});
	expect((await stub.read()).messages.filter((message) => message.kind === 'arrived')).toHaveLength(
		1,
	);
	expect((await stub.read()).messages.filter((message) => message.kind === 'left')).toHaveLength(1);
});

it('preserves an explicitly empty delivery key across RPC retries', async () => {
	const name = 'room-empty-delivery-key';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const first = await stub.send({ from: 'priya', text: 'An empty key is still a key.', key: '' });
	const retry = await stub.send({ from: 'priya', text: 'An empty key is still a key.', key: '' });
	expect(retry).toEqual(first);
	expect(
		(await stub.read()).messages.filter((message) => message.kind === 'said' && message.key === ''),
	).toHaveLength(1);
});

it('rejects a conflicting delivery key payload and recipient over RPC', async () => {
	const name = 'room-delivery-conflict';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: ['assistant'] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.visit({ name: 'sam', identity: 'Engineering lead.' });
	await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			send(input: { from: string; to?: string; text: string; key?: string }): Promise<unknown>;
		};
		await object.send({ from: 'priya', to: 'assistant', text: 'Original.', key: 'same' });
		await expect(
			object.send({ from: 'priya', to: 'assistant', text: 'Changed.', key: 'same' }),
		).rejects.toThrow(/different room operation/);
		await expect(
			object.send({ from: 'sam', to: 'assistant', text: 'Original.', key: 'same' }),
		).rejects.toThrow(/different room operation/);
		await expect(object.send({ from: 'priya', text: 'Original.', key: 'same' })).rejects.toThrow(
			/different room operation/,
		);
	});
});

it('rebuilds an admitted visit after the adapter loses its cache on eviction', async () => {
	const name = 'room-interrupted-admission';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			visit(person: { name: string; identity: string }): Promise<void>;
			visits: Map<string, unknown>;
		};
		const originalSet = object.visits.set.bind(object.visits);
		object.visits.set = ((key: string, value: unknown) => {
			if (key === 'priya') throw new Error('lose adapter admission cache');
			return originalSet(key, value);
		}) as typeof object.visits.set;
		await expect(object.visit({ name: 'priya', identity: 'Project manager.' })).rejects.toThrow(
			/lose adapter admission cache/,
		);
	});
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('lose adapter admission cache');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName(name));
	const exchange = await runInDurableObject(again, async (instance) => {
		const object = instance as unknown as {
			send(input: { from: string; text: string; key?: string }): Promise<{ owner: string }>;
		};
		return object.send({ from: 'priya', text: 'The admitted visit survived.', key: 'q1' });
	});
	expect(exchange.owner).toBe('priya');
	expect(
		(await again.read()).messages.filter((message) => message.kind === 'arrived'),
	).toHaveLength(1);
});

it('rebuilds a present human handle after restart without a duplicate arrival', async () => {
	const name = 'room-present-restart';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.send({ from: 'priya', text: 'Before the restart.', key: 'q1' });
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('reconstruct with a present human');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName(name));
	// Startup rebuilds the live handle from journal presence, so a send needs no
	// second visit. The rebuild's visit is idempotent, so it adds no arrival.
	const exchange = await again.send({ from: 'priya', text: 'After the restart.', key: 'q2' });
	expect(exchange.owner).toBe('priya');
	expect(
		(await again.read()).messages.filter((message) => message.kind === 'arrived'),
	).toHaveLength(1);
	expect(
		(await again.read({ messages: false })).participants.some(
			(participant) =>
				participant.kind === 'human' &&
				participant.name === 'priya' &&
				participant.presence === 'present',
		),
	).toBe(true);
});

it('keeps a departed human absent after restart', async () => {
	const name = 'room-departure-restart';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await stub.leave('priya');
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('reconstruct after departure');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName(name));
	await until(async () => {
		try {
			const participants = (await again.read({ messages: false })).participants;
			return participants.some(
				(participant) =>
					participant.kind === 'human' &&
					participant.name === 'priya' &&
					participant.presence === 'absent',
			)
				? true
				: undefined;
		} catch {
			return undefined;
		}
	});
	await runInDurableObject(again, async (instance) => {
		const object = instance as unknown as {
			send(input: { from: string; text: string }): Promise<unknown>;
			leave(name: string): Promise<void>;
		};
		await expect(object.send({ from: 'priya', text: 'Must stay absent.' })).rejects.toThrow(
			/has not visited/,
		);
		await object.leave('priya');
	});
	expect(
		(await again.read()).messages.filter((message) => message.kind === 'arrived'),
	).toHaveLength(1);
});

it('does not delete a deliberately reentered handle after an older leave returns', async () => {
	const name = 'room-leave-reentry-fence';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await stub.start({ name, agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	await runInDurableObject(stub, async (instance) => {
		const object = instance as unknown as {
			visits: Map<string, { leave(): Promise<void> }>;
			leave(name: string): Promise<void>;
			visit(person: { name: string; identity: string }): Promise<void>;
			send(input: { from: string; text: string; key?: string }): Promise<unknown>;
		};
		const old = object.visits.get('priya');
		if (old === undefined) throw new Error('The test visit was not cached.');
		const original = old.leave.bind(old);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let departed!: () => void;
		const departure = new Promise<void>((resolve) => {
			departed = resolve;
		});
		old.leave = async () => {
			await original();
			departed();
			await gate;
		};
		const leaving = object.leave('priya');
		await departure;
		await object.visit({ name: 'priya', identity: 'Project manager.' });
		release();
		await leaving;
		await object.send({ from: 'priya', text: 'The new visit remains cached.', key: 'q1' });
	});
	expect((await stub.read()).messages.filter((message) => message.kind === 'arrived')).toHaveLength(
		2,
	);
	expect((await stub.read()).messages.filter((message) => message.kind === 'left')).toHaveLength(1);
});

it('can ensure a resumed room and report its current state', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-status'));
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

it('keeps a stopped record readable without resuming the room', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-stopped-status'));
	await stub.start({
		name: 'room-stopped-status',
		agents: [],
	});
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const exchange = await stub.send({
		from: 'priya',
		text: 'A durable question?',
		key: 'stopped-1',
	});
	await stub.waitForClose(exchange.from);
	await stub.waitForSummary(exchange.from);
	await stub.stop();
	const read = await stub.read();
	expect(read).toMatchObject({
		name: 'room-stopped-status',
		initialized: true,
		exchange: undefined,
		exchanges: [{ status: 'closed', from: exchange.from, summary: { status: 'silent' } }],
	});
	expect(await stub.exchange(exchange.from)).toEqual(exchange);
});

it('reads a stopped open exchange and reconstructs it after eviction', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-stopped-open'));
	await seedStoppedOpen(stub, 'room-stopped-open');
	const again = env.ROOM.get(env.ROOM.idFromName('room-stopped-open'));
	const stopped = await again.read({ messages: false });
	expect(stopped.exchange).toMatchObject({ status: 'open', from: 4 });
	expect(stopped.watermark).toBe(4);
	expect((await again.read()).messages).toHaveLength(2);
});

it('retains the stopped handle when saving stop metadata fails', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('room-stop-retry'));
	await stub.start({ name: 'room-stop-retry', agents: [] });
	await runInDurableObject(stub, async (instance) => {
		type MutableObject = {
			metadata: { change: (...args: never[]) => Promise<unknown> };
			stop(): Promise<void>;
		};
		const object = instance as unknown as MutableObject;
		const original = object.metadata.change.bind(object.metadata);
		let fail = true;
		object.metadata.change = (...args) => {
			if (fail) {
				fail = false;
				return Promise.reject(new Error('metadata write failed'));
			}
			return original(...args);
		};
		await expect(object.stop()).rejects.toThrow('metadata write failed');
		await object.stop();
	});
	const again = env.ROOM.get(env.ROOM.idFromName('room-stop-retry'));
	await expect(again.read({ messages: false })).resolves.toMatchObject({ initialized: true });
});

it('leaves an uninitialized named record for an explicit start retry', async () => {
	const name = 'room-uninitialized-retry';
	const stub = env.ROOM.get(env.ROOM.idFromName(name));
	await runInDurableObject(stub, async (instance) => {
		type MetadataObject = {
			metadata: { change: (change: () => { patch: Record<string, unknown> }) => Promise<unknown> };
		};
		const object = instance as unknown as MetadataObject;
		await object.metadata.change(() => ({
			patch: { name, agents: ['assistant'], stopped: false },
		}));
	});
	await runInDurableObject(stub, async (_instance, state) => {
		state.abort('reconstruct uninitialized object');
	}).catch(() => {});
	const again = env.ROOM.get(env.ROOM.idFromName(name));
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
	const messages = (await again.read()).messages;
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
	expect(
		(await stub.read({ messages: false })).participants.map((participant) => participant.name),
	).toEqual(['assistant']);
	await stub.seat('product', { attention: 'named' });
	expect(
		(await stub.read({ messages: false })).participants.find(
			(participant) => participant.name === 'product',
		),
	).toMatchObject({
		attention: 'named',
	});
	await stub.unseat('product');
	expect(
		(await stub.read({ messages: false })).participants.map((participant) => participant.name),
	).toEqual(['assistant']);
});

it('runs the alarm through the hosting registry, and ignores it without a running room', async () => {
	const idle = env.ROOM.get(env.ROOM.idFromName('room-alarm-idle'));
	await expect(runDurableObjectAlarm(idle)).resolves.toBe(false);
	const stub = env.ROOM.get(env.ROOM.idFromName('room-alarm'));
	await stub.start({ name: 'room-alarm', agents: [] });
	await stub.visit({ name: 'priya', identity: 'Project manager.' });
	const exchange = await stub.send({ from: 'priya', text: 'Alarm question?', key: 'alarm-1' });
	await stub.waitForClose(exchange.from);
	await runInDurableObject(stub, (instance) => instance.alarm());
	await stub.stop();
	await runInDurableObject(stub, (instance) => instance.alarm());
	expect((await stub.read()).exchanges).toMatchObject([{ status: 'closed', from: exchange.from }]);
});
