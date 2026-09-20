import { describe, expect, it } from 'vitest';
import { type RoomProtocol, runningRoom, type Transport } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	exchangeUri,
	pi,
	type Room,
	type Runtime,
	readRoom,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import { quiet, scripted, settled, speak } from '../src/testing.ts';
import { refusal } from './support/errors.ts';
import { collect, messagesOf, roomName, stateOf } from './support/room.ts';
import { toolResultTexts } from './support/scripted.ts';
import {
	faultyJournals,
	memory,
	type OpenedStorage,
	type Storage,
	storages,
} from './support/storage.ts';

const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const secondPerson = defineHuman({ name: 'sam', identity: 'Engineer.' });
const worker = defineAgent({
	name: 'worker',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer the record.', model: 'scripted/worker' }),
});
const writer = defineAgent({
	name: 'writer',
	identity: 'Writes summaries.',
	executor: pi({ instructions: 'Summarise the record.', model: 'scripted/writer' }),
});
const reserveAgent = defineAgent({
	name: 'reserve',
	identity: 'Joins when invited.',
	executor: pi({ instructions: 'Wait.', model: 'scripted/reserve' }),
});

const passiveTransport: Transport = {
	connect: () => ({
		wake: async () => {},
		steer: async () => {},
		cut: async () => {},
	}),
};

interface World {
	opened: OpenedStorage;
	runtime: Runtime;
	room: Room;
}

async function openWorld(
	storage: Storage,
	options: Omit<StartRoomOptions, 'name' | 'runtime'>,
): Promise<World> {
	const opened = await storage.open();
	const runtime = createRuntime({ storage: opened.storage, transport: passiveTransport });
	const room = await startRoom({
		name: roomName(`contribution-validation-${storage.name}`),
		runtime,
		...options,
	});
	return { opened, runtime, room };
}

async function protocol(runtime: Runtime, name: string): Promise<RoomProtocol> {
	const peer = runningRoom(runtime, name);
	if (peer === undefined) throw new Error('The room is absent.');
	return peer;
}

describe('the message byte limit', () => {
	const limits = { limits: { message: { bytes: 16 } } };
	const long = 'a message that is far over sixteen bytes';

	it('refuses a long delivery, reserves no key, and lets a short retry land', async () => {
		const runtime = createRuntime({ ...limits, transport: passiveTransport });
		const room = await startRoom({ name: roomName('byte-delivery'), runtime, agents: [] });
		try {
			const visit = await room.visit(person);
			await expect(visit.send({ text: long, key: 'k' })).rejects.toEqual(
				refusal('message_too_large'),
			);
			expect((await messagesOf(room)).some((m) => 'text' in m && m.text === long)).toBe(false);
			await expect(visit.send({ text: 'short', key: 'k' })).resolves.toMatchObject({
				owner: person.name,
			});
		} finally {
			await room.stop();
		}
	});

	it('gives an agent a tool error for a long say and leaves no mark', async () => {
		const results: string[][] = [];
		const runtime = createRuntime({
			...limits,
			stream: scripted((context) => {
				results.push(toolResultTexts(context));
				return toolResultTexts(context).length === 0 ? speak(long) : quiet();
			}),
		});
		const room = await startRoom({ name: roomName('byte-say'), runtime, agents: [worker] });
		const events = collect(room);
		try {
			await (await room.visit(person)).send({ text: 'Hi.' });
			await settled(room);
			expect(results.flat().some((text) => /bytes/.test(text))).toBe(true);
			expect((await messagesOf(room)).some((m) => m.from === 'worker' && m.kind === 'said')).toBe(
				false,
			);
			expect(events.some((e) => e.type === 'activation_end' && e.spoke === false)).toBe(true);
		} finally {
			await room.stop();
		}
	});
});

const blankTexts = ['', '\u00a0\u2003\u202f'];

describe.each(storages)('contribution validation on $name storage', (storage) => {
	it('keeps a delivery key bound to its author, recipient, and content', async () => {
		const { opened, room } = await openWorld(storage, { agents: [] });
		try {
			const first = await room.visit(person);
			const second = await room.visit(secondPerson);
			const key = 'delivery-integrity';
			const original = await first.send({ key, to: secondPerson.name, text: 'Original.' });
			await expect(first.send({ key, to: secondPerson.name, text: 'Changed.' })).rejects.toThrow(
				/different room operation/,
			);
			await expect(first.send({ key, to: secondPerson.name, text: 'Changed.' })).rejects.toEqual(
				refusal('refused'),
			);
			await expect(first.send({ key, to: person.name, text: 'Original.' })).rejects.toThrow(
				/different room operation/,
			);
			await expect(second.send({ key, to: secondPerson.name, text: 'Original.' })).rejects.toThrow(
				/different room operation/,
			);
			const exactRetry = await first.send({ key, to: secondPerson.name, text: 'Original.' });
			expect(exactRetry).toMatchObject({
				owner: original.owner,
				from: original.from,
				at: original.at,
			});
			expect((await messagesOf(room)).filter((message) => message.key === key)).toHaveLength(1);

			// An explicitly supplied empty key is still a real idempotency key.
			const empty = await first.send({ key: '', text: 'Empty key.' });
			const emptyRetry = await first.send({ key: '', text: 'Empty key.' });
			expect(emptyRetry).toMatchObject({ owner: empty.owner, from: empty.from, at: empty.at });
			await expect(first.send({ key: '', text: 'Different empty key.' })).rejects.toThrow(
				/different room operation/,
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps a delivery key bound to its refs', async () => {
		const { opened, room } = await openWorld(storage, { agents: [] });
		try {
			const visit = await room.visit(person);
			const key = 'delivery-refs';
			const refs = ['https://x/a', 'https://x/b'];
			const original = await visit.send({ key, text: 'Cited.', refs });
			const retry = await visit.send({ key, text: 'Cited.', refs: [...refs] });
			expect(retry).toMatchObject({ owner: original.owner, from: original.from });
			for (const changed of [['https://x/a'], [...refs].reverse(), undefined])
				await expect(
					visit.send({ key, text: 'Cited.', ...(changed === undefined ? {} : { refs: changed }) }),
				).rejects.toThrow(/different room operation/);
			const stored = (await messagesOf(room)).filter((message) => message.key === key);
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({ refs });
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('refuses an invalid ref on a delivery without consuming the key', async () => {
		const { opened, room } = await openWorld(storage, { agents: [] });
		try {
			const visit = await room.visit(person);
			const key = 'delivery-bad-ref';
			const before = (await messagesOf(room)).length;
			await expect(visit.send({ key, text: 'Cited.', refs: ['shared/report.md'] })).rejects.toEqual(
				refusal('refused'),
			);
			await expect(visit.send({ key, text: 'Cited.', refs: ['shared/report.md'] })).rejects.toThrow(
				/ref/,
			);
			expect((await messagesOf(room)).length).toBe(before);
			await visit.send({ key, text: 'Cited.', refs: ['https://x/a'] });
			expect((await messagesOf(room)).filter((message) => message.key === key)).toHaveLength(1);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('serializes concurrent retries under one delivery key', async () => {
		const { opened, room } = await openWorld(storage, { agents: [] });
		try {
			const visit = await room.visit(person);
			const winner = visit.send({ key: 'concurrent-delivery', text: 'First.' });
			const conflict = visit.send({ key: 'concurrent-delivery', text: 'Second.' });
			await expect(winner).resolves.toMatchObject({ owner: person.name });
			await expect(conflict).rejects.toThrow(/different room operation/);
			expect(
				(await messagesOf(room)).filter((message) => message.key === 'concurrent-delivery'),
			).toHaveLength(1);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('replays a delivery after its append acknowledgement is lost', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const runtime = createRuntime({ storage: faulty.journals, transport: passiveTransport });
		const room = await startRoom({
			name: roomName(`delivery-lost-ack-${storage.name}`),
			runtime,
		});
		try {
			const visit = await room.visit(person);
			const input = { key: 'lost-delivery', text: 'Durable once.' };
			faulty.fail('after', 'message');
			await expect(visit.send(input)).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			const replay = await visit.send(input);
			expect(replay.owner).toBe(person.name);
			expect((await messagesOf(room)).filter((message) => message.key === input.key)).toHaveLength(
				1,
			);
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('accepts an agent commit that reuses a human delivery key, in a separate key space', async () => {
		const { opened, room, runtime } = await openWorld(storage, {
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (
				await room.visit(person)
			).send({ key: 'cross-operation', text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const view = await peer.view(activation);
			if (!('view' in view)) throw new Error('The ordinary activation is absent.');
			const committed = await peer.commit({
				activation,
				key: 'cross-operation',
				readThrough: view.view.through,
				intent: { kind: 'said', text: 'An answer.' },
			});
			expect(committed).toHaveProperty('committed');
			expect(
				(await messagesOf(room)).filter((message) => message.key === 'cross-operation'),
			).toHaveLength(2);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('binds an agent commit key to its refs', async () => {
		const { opened, room, runtime } = await openWorld(storage, {
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const view = await peer.view(activation);
			if (!('view' in view)) throw new Error('The ordinary activation is absent.');
			const request = (refs: string[]) => ({
				activation,
				key: 'refs-key',
				readThrough: view.view.through,
				intent: { kind: 'said' as const, text: 'An answer.', refs },
			});
			const bad = await peer.commit(request(['shared/report.md']));
			expect(bad).toHaveProperty('refused');
			const first = await peer.commit(request(['https://x/a']));
			expect(first).toHaveProperty('committed');
			expect(await peer.commit(request(['https://x/a']))).toEqual(first);
			expect(await peer.commit(request(['https://x/b']))).toEqual({
				refused: expect.stringMatching(/different room operation/),
			});
			const stored = (await messagesOf(room)).filter((message) => message.key === 'refs-key');
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({ refs: ['https://x/a'] });
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('binds membership keys to the committed subject and operation', async () => {
		const { opened, room, runtime } = await openWorld(storage, {
			agents: [worker, reserveAgent],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const key = 'membership-integrity';
			const seated = await peer.commit({
				activation,
				key,
				intent: { kind: 'seated', name: reserveAgent.name },
			});
			expect(seated).toMatchObject({ committed: { kind: 'seated', subject: reserveAgent.name } });
			expect(
				await peer.commit({
					activation,
					key,
					intent: { kind: 'seated', name: reserveAgent.name },
				}),
			).toEqual(seated);
			const changedSubject = await peer.commit({
				activation,
				key,
				intent: { kind: 'seated', name: worker.name },
			});
			expect(changedSubject).toMatchObject({
				refused: expect.stringMatching(/different room operation/),
			});
			const changedOperation = await peer.commit({
				activation,
				key,
				intent: { kind: 'unseated', name: reserveAgent.name },
			});
			expect(changedOperation).toMatchObject({
				refused: expect.stringMatching(/different room operation/),
			});
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it.each(blankTexts)(
		'rejects blank visit %j without changing the record, then accepts the same key verbatim',
		async (blank) => {
			const { opened, room, runtime } = await openWorld(storage, { agents: [] });
			try {
				const visit = await room.visit(person);
				const before = await messagesOf(room);
				const beforeSnapshot = await readRoom(room.name, { runtime });
				const key = 'visit-blank';
				await expect(visit.send({ key, text: blank })).rejects.toThrow(/message is empty/i);
				expect(await messagesOf(room)).toEqual(before);
				expect((await readRoom(room.name, { runtime })).exchange).toEqual(beforeSnapshot.exchange);
				expect((await readRoom(room.name, { runtime })).watermark).toBe(beforeSnapshot.watermark);

				const preserved = '  accepted \u00a0 ';
				const exchange = await visit.send({ key, text: preserved });
				const said = (await messagesOf(room)).find((message) => message.key === key);
				expect(said).toMatchObject({ kind: 'said', text: preserved, key });
				expect(exchange.from).toBe(said?.seq);
				const accepted = await messagesOf(room);
				await expect(visit.send({ key, text: blank })).rejects.toThrow(/different room operation/);
				expect(await messagesOf(room)).toEqual(accepted);
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it.each(blankTexts)(
		'rejects blank ordinary commit %j without consuming its key, then accepts a corrected retry',
		async (blank) => {
			const { opened, room, runtime } = await openWorld(storage, {
				agents: [worker],
				seats: { [worker.name]: 'broadcast' },
			});
			try {
				const exchange = await (await room.visit(person)).send({ text: 'Question?' });
				const peer = await protocol(runtime, room.name);
				const activation = `message:${exchange.from}:${worker.name}:1`;
				expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
				const key = 'ordinary-blank';
				const view = await peer.view(activation);
				if (!('view' in view)) throw new Error('The ordinary activation is absent.');
				const before = await readRoom(room.name, { runtime });
				const refused = await peer.commit({
					activation,
					key,
					readThrough: view.view.through,
					intent: { kind: 'said', text: blank },
				});
				expect(refused).toMatchObject({ refused: expect.stringMatching(/message is empty/i) });
				expect(await messagesOf(room)).toEqual(before.messages);
				expect((await readRoom(room.name, { runtime })).watermark).toBe(before.watermark);

				const preserved = '  ordinary \u00a0 ';
				const latest = await peer.view(activation);
				if (!('view' in latest)) throw new Error('The ordinary activation is absent.');
				const accepted = await peer.commit({
					activation,
					key,
					readThrough: latest.view.through,
					intent: { kind: 'said', text: preserved },
				});
				expect(accepted).toMatchObject({ committed: { kind: 'said', text: preserved, key } });
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it.each(blankTexts)(
		'rejects blank closing summary %j without consuming its key, then accepts a corrected retry',
		async (blank) => {
			const { opened, room, runtime } = await openWorld(storage, {
				agents: [writer],
				summary: writer.name,
				seats: { [writer.name]: 'none' },
			});
			try {
				const exchange = await (await room.visit(person)).send({ text: 'Question?' });
				await room.reconcile();
				const owed = stateOf(room).due.find((work) => work.source === 'closed');
				if (owed === undefined) throw new Error('The room has no closing assignment.');
				const peer = await protocol(runtime, room.name);
				expect(await peer.lease({ activation: owed.id, operation: 'claim' })).toHaveProperty('ok');
				const key = 'summary-blank';
				const before = await readRoom(room.name, { runtime });
				const refused = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', text: blank },
				});
				expect(refused).toMatchObject({ refused: expect.stringMatching(/message is empty/i) });
				expect(await messagesOf(room)).toEqual(before.messages);
				expect((await readRoom(room.name, { runtime })).watermark).toBe(before.watermark);

				const preserved = '  summary \u00a0 ';
				const accepted = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', text: preserved },
				});
				expect(accepted).toMatchObject({
					committed: {
						kind: 'summary',
						text: preserved,
						key,
						to: person.name,
						covers: { from: exchange.from, through: exchange.from },
					},
				});
				const canonicalRetry = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', to: person.name, text: preserved },
				});
				expect(canonicalRetry).toEqual(accepted);
				const changedRecipient = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', to: secondPerson.name, text: preserved },
				});
				expect(changedRecipient).toMatchObject({
					refused: expect.stringMatching(/different room operation/),
				});
				const changedContent = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', text: 'Another summary.' },
				});
				expect(changedContent).toMatchObject({
					refused: expect.stringMatching(/different room operation/),
				});
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it('stores refs on a closing summary and binds its key to them', async () => {
		const { opened, room, runtime } = await openWorld(storage, {
			agents: [writer],
			summary: writer.name,
			seats: { [writer.name]: 'none' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			await room.reconcile();
			const owed = stateOf(room).due.find((work) => work.source === 'closed');
			if (owed === undefined) throw new Error('The room has no closing assignment.');
			const peer = await protocol(runtime, room.name);
			expect(await peer.lease({ activation: owed.id, operation: 'claim' })).toHaveProperty('ok');
			const key = 'summary-refs';
			const refs = [exchangeUri(room.name, exchange.from)];
			const commit = (cited: string[]) =>
				peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', text: 'Summary.', refs: cited },
				});
			const first = await commit(refs);
			expect(first).toMatchObject({ committed: { kind: 'summary', refs } });
			expect(await commit([...refs])).toEqual(first);
			expect(await commit(['https://x/other'])).toEqual({
				refused: expect.stringMatching(/different room operation/),
			});
			const stored = (await messagesOf(room)).filter((message) => message.kind === 'summary');
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({ refs });
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('replays an exact committed key and rejects a replacement under that key', async () => {
		const { opened, room, runtime } = await openWorld(storage, {
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const view = await peer.view(activation);
			if (!('view' in view)) throw new Error('The ordinary activation is absent.');
			const original = await peer.commit({
				activation,
				key: 'replay-original',
				readThrough: view.view.through,
				intent: { kind: 'said', text: 'Original text.' },
			});
			expect(original).toMatchObject({ committed: { text: 'Original text.' } });
			const before = await messagesOf(room);
			const replay = await peer.commit({
				activation,
				key: 'replay-original',
				readThrough: view.view.through,
				intent: { kind: 'said', text: 'Original text.' },
			});
			expect(replay).toEqual(original);
			const conflict = await peer.commit({
				activation,
				key: 'replay-original',
				readThrough: view.view.through,
				intent: { kind: 'said', text: '\u00a0\u2003' },
			});
			expect(conflict).toMatchObject({
				refused: expect.stringMatching(/different room operation/),
			});
			expect(await messagesOf(room)).toEqual(before);
			expect(
				(await messagesOf(room)).filter((message) => message.key === 'replay-original'),
			).toHaveLength(1);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});

describe('outer protocol authority', () => {
	it('keeps stale and missed refusals ahead of contribution validation', async () => {
		const { opened, room, runtime } = await openWorld(memory, {
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const view = await peer.view(activation);
			if (!('view' in view)) throw new Error('The ordinary activation is absent.');
			await (await room.visit(person)).send({ text: 'New context?' });
			const missed = await peer.commit({
				activation,
				key: 'missed-blank',
				readThrough: view.view.through,
				intent: { kind: 'said', text: '\u00a0' },
			});
			expect(missed).toHaveProperty('missed');
			await peer.lease({ activation, operation: 'release', reason: 'released', readThrough: 0 });
			const stale = await peer.commit({
				activation,
				key: 'stale-blank',
				readThrough: view.view.through,
				intent: { kind: 'said', text: '' },
			});
			expect(stale).toHaveProperty('stale');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
