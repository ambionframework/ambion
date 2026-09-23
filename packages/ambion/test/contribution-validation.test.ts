/**
 * What the room accepts from a person and from a seat: the byte limit, the
 * idempotency key of each contribution, blank text, and the lease answers
 * the room protocol gives a seat process.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	type CreateRuntimeOptions,
	createRuntime,
	defineHuman,
	messageUri,
	readRoom,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import { person, protocolOf, recordingTransport } from './support/core-exchange.ts';
import { refusal } from './support/errors.ts';
import {
	collect,
	messagesOf,
	roomName,
	scriptedAgent,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import { quiet, scripted, speak, toolResultTexts } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { faultyJournals, memory, type Storage, storages } from './support/storage.ts';

const secondPerson = defineHuman({ name: 'sam', identity: 'Engineer.' });
const worker = scriptedAgent('worker');
const writer = scriptedAgent('writer');
const reserveAgent = scriptedAgent('reserve');

const differentOperation = { refused: expect.stringMatching(/different room operation/) };

/** A room on a transport that runs nothing, so the test plays the seat process by hand. */
async function openWorld(
	storage: Storage,
	options: Omit<StartRoomOptions, 'name' | 'runtime'>,
	runtimeOptions: CreateRuntimeOptions = {},
) {
	const opened = await openFor(storage);
	const runtime = createRuntime({
		storage: opened.storage,
		transport: recordingTransport(),
		...runtimeOptions,
	});
	const room = stopAtEnd(
		await startRoom({ name: roomName('contribution-validation'), runtime, ...options }),
	);
	return { opened, runtime, room, peer: protocolOf(runtime, room.name) };
}

/** A room where the person asks a question and the test claims the worker's activation for it. */
async function claimedWorker(storage: Storage, agents = [worker]) {
	const world = await openWorld(storage, { agents, seats: { [worker.name]: 'broadcast' } });
	const exchange = await (
		await world.room.visit(person)
	).send({
		key: 'cross-operation',
		text: 'Question?',
	});
	const activation = `message:${exchange.from}:${worker.name}:1`;
	expect(await world.peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
	const through = async () => {
		const view = await world.peer.view(activation);
		if (!('view' in view)) throw new Error('The ordinary activation is absent.');
		return view.view.through;
	};
	const first = await through();
	/** Commit a said intent, read through the latest view unless the test names a position. */
	const say = async (
		key: string,
		text: string,
		extra: { refs?: string[]; readThrough?: number } = {},
	) =>
		world.peer.commit({
			activation,
			key,
			readThrough: extra.readThrough ?? (await through()),
			intent: { kind: 'said', text, ...(extra.refs === undefined ? {} : { refs: extra.refs }) },
		});
	return { ...world, exchange, activation, say, first };
}

/** A room with a summary writer where the test claims the closing activation. */
async function claimedSummary(storage: Storage, runtimeOptions: CreateRuntimeOptions = {}) {
	const world = await openWorld(
		storage,
		{ agents: [writer], summary: writer.name, seats: { [writer.name]: 'none' } },
		runtimeOptions,
	);
	const exchange = await (await world.room.visit(person)).send({ text: 'Question?' });
	await world.room.reconcile();
	const owed = stateOf(world.room).due.find((work) => work.source === 'closed');
	if (owed === undefined) throw new Error('The room has no closing assignment.');
	expect(await world.peer.lease({ activation: owed.id, operation: 'claim' })).toHaveProperty('ok');
	const say = (key: string, text: string, extra: { refs?: string[]; to?: string } = {}) =>
		world.peer.commit({ activation: owed.id, key, intent: { kind: 'said', text, ...extra } });
	return { ...world, exchange, activation: owed.id, say };
}

const keyed = async (world: { room: Parameters<typeof messagesOf>[0] }, key: string) =>
	(await messagesOf(world.room)).filter((message) => message.key === key);

describe('the message byte limit', () => {
	const limits = { limits: { message: { bytes: 16 } } };
	const long = 'a message that is far over sixteen bytes';

	it('refuses a long delivery, reserves no key, and lets a short retry land', async () => {
		const runtime = createRuntime({ ...limits, transport: recordingTransport() });
		const room = stopAtEnd(await startRoom({ name: roomName('byte-delivery'), runtime }));
		const visit = await room.visit(person);
		await expect(visit.send({ text: long, key: 'k' })).rejects.toEqual(
			refusal('message_too_large'),
		);
		expect((await messagesOf(room)).some((m) => 'text' in m && m.text === long)).toBe(false);
		await expect(visit.send({ text: 'short', key: 'k' })).resolves.toMatchObject({
			owner: person.name,
		});
	});

	it('gives an agent a tool error for a long say and leaves no mark', async () => {
		const results: string[][] = [];
		const runtime = createRuntime({
			...limits,
			execution: piExecution({
				stream: scripted((context) => {
					results.push(toolResultTexts(context));
					return toolResultTexts(context).length === 0 ? speak(long) : quiet();
				}),
			}),
		});
		const room = stopAtEnd(
			await startRoom({ name: roomName('byte-say'), runtime, agents: [worker] }),
		);
		const events = collect(room);
		await (await room.visit(person)).send({ text: 'Hi.' });
		await waitForRoom(room);
		expect(results.flat().some((text) => /bytes/.test(text))).toBe(true);
		expect((await messagesOf(room)).some((m) => m.from === 'worker' && m.kind === 'said')).toBe(
			false,
		);
		expect(events.some((e) => e.type === 'activation_end' && e.spoke === false)).toBe(true);
	});
});

const blankTexts = ['', '\u00a0\u2003\u202f'];

describe.each(storages)('contribution validation on $name storage', (storage) => {
	it('binds a delivery key to its author, recipient, content, and refs, and serializes retries', async () => {
		const world = await openWorld(storage, { agents: [] });
		const first = await world.room.visit(person);
		const second = await world.room.visit(secondPerson);
		const key = 'delivery-integrity';
		const original = await first.send({ key, to: secondPerson.name, text: 'Original.' });
		const changed = first.send({ key, to: secondPerson.name, text: 'Changed.' });
		await expect(changed).rejects.toThrow(/different room operation/);
		await expect(changed).rejects.toEqual(refusal('refused'));
		await expect(first.send({ key, to: person.name, text: 'Original.' })).rejects.toThrow(
			/different room operation/,
		);
		await expect(second.send({ key, to: secondPerson.name, text: 'Original.' })).rejects.toThrow(
			/different room operation/,
		);
		expect(await first.send({ key, to: secondPerson.name, text: 'Original.' })).toMatchObject({
			owner: original.owner,
			from: original.from,
			at: original.at,
		});
		expect(await keyed(world, key)).toHaveLength(1);

		// An explicitly supplied empty key is still a real idempotency key.
		const empty = await first.send({ key: '', text: 'Empty key.' });
		expect(await first.send({ key: '', text: 'Empty key.' })).toMatchObject({
			owner: empty.owner,
			from: empty.from,
			at: empty.at,
		});
		await expect(first.send({ key: '', text: 'Different empty key.' })).rejects.toThrow(
			/different room operation/,
		);

		// An invalid ref consumes no key; a key then binds its refs.
		const refs = ['https://x/a', 'https://x/b'];
		const before = (await messagesOf(world.room)).length;
		const bad = first.send({ key: 'refs', text: 'Cited.', refs: ['shared/report.md'] });
		await expect(bad).rejects.toEqual(refusal('refused'));
		await expect(bad).rejects.toThrow(/ref/);
		expect((await messagesOf(world.room)).length).toBe(before);
		const cited = await first.send({ key: 'refs', text: 'Cited.', refs });
		expect(await first.send({ key: 'refs', text: 'Cited.', refs: [...refs] })).toMatchObject({
			owner: cited.owner,
			from: cited.from,
		});
		for (const other of [['https://x/a'], [...refs].reverse(), undefined])
			await expect(
				first.send({
					key: 'refs',
					text: 'Cited.',
					...(other === undefined ? {} : { refs: other }),
				}),
			).rejects.toThrow(/different room operation/);
		const stored = await keyed(world, 'refs');
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ refs });

		// Two concurrent sends under one key: the first lands, the second conflicts.
		const winner = first.send({ key: 'concurrent', text: 'First.' });
		const conflict = first.send({ key: 'concurrent', text: 'Second.' });
		await expect(winner).resolves.toMatchObject({ owner: person.name });
		await expect(conflict).rejects.toThrow(/different room operation/);
		expect(await keyed(world, 'concurrent')).toHaveLength(1);
	});

	it('replays a delivery after its append acknowledgement is lost', async () => {
		const opened = await openFor(storage);
		const faulty = faultyJournals(opened.storage);
		const runtime = createRuntime({ storage: faulty.journals, transport: recordingTransport() });
		const room = stopAtEnd(await startRoom({ name: roomName('delivery-lost-ack'), runtime }));
		const visit = await room.visit(person);
		const input = { key: 'lost-delivery', text: 'Durable once.' };
		faulty.fail('after', 'message');
		await expect(visit.send(input)).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		expect((await visit.send(input)).owner).toBe(person.name);
		expect(await keyed({ room }, input.key)).toHaveLength(1);
	});

	it('binds an agent commit key to its text and refs, in a key space apart from deliveries', async () => {
		const world = await claimedWorker(storage);
		// The question used this key for a delivery; the agent commit is a separate operation.
		expect(await world.say('cross-operation', 'An answer.')).toHaveProperty('committed');
		expect(await keyed(world, 'cross-operation')).toHaveLength(2);

		const original = await world.say('replay-original', 'Original text.');
		expect(original).toMatchObject({ committed: { text: 'Original text.' } });
		const before = await messagesOf(world.room);
		expect(await world.say('replay-original', 'Original text.')).toEqual(original);
		expect(await world.say('replay-original', '\u00a0\u2003')).toMatchObject(differentOperation);
		expect(await messagesOf(world.room)).toEqual(before);

		expect(
			await world.say('refs-key', 'An answer.', { refs: ['shared/report.md'] }),
		).toHaveProperty('refused');
		const first = await world.say('refs-key', 'An answer.', { refs: ['https://x/a'] });
		expect(first).toHaveProperty('committed');
		expect(await world.say('refs-key', 'An answer.', { refs: ['https://x/a'] })).toEqual(first);
		expect(await world.say('refs-key', 'An answer.', { refs: ['https://x/b'] })).toEqual(
			differentOperation,
		);
		const stored = await keyed(world, 'refs-key');
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ refs: ['https://x/a'] });
	});

	it('binds membership keys to the committed subject and operation', async () => {
		const { peer, activation } = await claimedWorker(storage, [worker, reserveAgent]);
		const membership = (kind: 'seated' | 'unseated', name: string) =>
			peer.commit({ activation, key: 'membership-integrity', intent: { kind, name } });
		const seated = await membership('seated', reserveAgent.name);
		expect(seated).toMatchObject({ committed: { kind: 'seated', subject: reserveAgent.name } });
		expect(await membership('seated', reserveAgent.name)).toEqual(seated);
		expect(await membership('seated', worker.name)).toMatchObject(differentOperation);
		expect(await membership('unseated', reserveAgent.name)).toMatchObject(differentOperation);
	});

	it.each(blankTexts)(
		'rejects blank visit %j without changing the record, then accepts the same key verbatim',
		async (blank) => {
			const { room, runtime } = await openWorld(storage, { agents: [] });
			const visit = await room.visit(person);
			const before = await readRoom(room.name, { runtime });
			const key = 'visit-blank';
			await expect(visit.send({ key, text: blank })).rejects.toThrow(/message is empty/i);
			const after = await readRoom(room.name, { runtime });
			expect(after.messages).toEqual(before.messages);
			expect(after.exchange).toEqual(before.exchange);
			expect(after.watermark).toBe(before.watermark);

			const preserved = '  accepted \u00a0 ';
			const exchange = await visit.send({ key, text: preserved });
			const said = (await messagesOf(room)).find((message) => message.key === key);
			expect(said).toMatchObject({ kind: 'said', text: preserved, key });
			expect(exchange.from).toBe(said?.seq);
			const accepted = await messagesOf(room);
			await expect(visit.send({ key, text: blank })).rejects.toThrow(/different room operation/);
			expect(await messagesOf(room)).toEqual(accepted);
		},
	);

	it.each(blankTexts)(
		'rejects blank ordinary commit %j without consuming its key, then accepts a corrected retry',
		async (blank) => {
			const { room, runtime, say } = await claimedWorker(storage);
			const before = await readRoom(room.name, { runtime });
			expect(await say('ordinary-blank', blank)).toMatchObject({
				refused: expect.stringMatching(/message is empty/i),
			});
			expect(await messagesOf(room)).toEqual(before.messages);
			expect((await readRoom(room.name, { runtime })).watermark).toBe(before.watermark);

			const preserved = '  ordinary \u00a0 ';
			expect(await say('ordinary-blank', preserved)).toMatchObject({
				committed: { kind: 'said', text: preserved, key: 'ordinary-blank' },
			});
		},
	);

	it.each(blankTexts)(
		'rejects blank closing summary %j without consuming its key, then accepts a corrected retry',
		async (blank) => {
			const { room, runtime, exchange, say } = await claimedSummary(storage);
			const key = 'summary-blank';
			const before = await readRoom(room.name, { runtime });
			expect(await say(key, blank)).toMatchObject({
				refused: expect.stringMatching(/message is empty/i),
			});
			expect(await messagesOf(room)).toEqual(before.messages);
			expect((await readRoom(room.name, { runtime })).watermark).toBe(before.watermark);

			const preserved = '  summary \u00a0 ';
			const accepted = await say(key, preserved);
			expect(accepted).toMatchObject({
				committed: {
					kind: 'summary',
					text: preserved,
					key,
					to: person.name,
					covers: { from: exchange.from, through: exchange.from },
				},
			});
			expect(await say(key, preserved, { to: person.name })).toEqual(accepted);
			expect(await say(key, preserved, { to: secondPerson.name })).toMatchObject(
				differentOperation,
			);
			expect(await say(key, 'Another summary.')).toMatchObject(differentOperation);
		},
	);

	it('stores refs on a closing summary and binds its key to them', async () => {
		const { room, exchange, say } = await claimedSummary(storage);
		const refs = [messageUri(room.name, exchange.from)];
		const first = await say('summary-refs', 'Summary.', { refs });
		expect(first).toMatchObject({ committed: { kind: 'summary', refs } });
		expect(await say('summary-refs', 'Summary.', { refs: [...refs] })).toEqual(first);
		expect(await say('summary-refs', 'Summary.', { refs: ['https://x/other'] })).toEqual(
			differentOperation,
		);
		const stored = (await messagesOf(room)).filter((message) => message.kind === 'summary');
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ refs });
	});
});

describe('the room protocol on a lease', () => {
	it('keeps stale and missed refusals ahead of contribution validation', async () => {
		const { room, say, peer, activation, first } = await claimedWorker(memory);
		await (await room.visit(person)).send({ text: 'New context?' });
		expect(await say('missed-blank', '\u00a0', { readThrough: first })).toHaveProperty('missed');
		await peer.lease({ activation, operation: 'release', reason: 'released', readThrough: 0 });
		expect(await say('stale-blank', '', { readThrough: first })).toHaveProperty('stale');
	});

	it('releases a live activation with its usage, and refuses a draft nobody claimed', async () => {
		const { opened, room, peer, activation, exchange } = await claimedSummary(memory, {
			limits: { context: { messages: 1 } },
		});
		// The room cap holds the summary view to its last message and counts the rest.
		const view = await peer.view(activation);
		if (!('view' in view)) throw new Error('The closing activation is absent.');
		expect(view.view.context.messages.map((message) => message.seq)).toEqual([exchange.from]);
		expect(view.view.context.omitted).toBe(
			(await messagesOf(room)).filter((message) => message.seq < exchange.from).length,
		);

		const unclaimed = activation.replace(/:\d+$/, ':99');
		expect(
			await peer.lease({
				activation: unclaimed,
				operation: 'release',
				reason: 'abandoned',
				readThrough: 0,
			}),
		).toEqual({ stale: 'the lease ended' });
		const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 1 };
		expect(
			await peer.lease({
				activation,
				operation: 'release',
				reason: 'released',
				readThrough: 0,
				usage,
			}),
		).toMatchObject({ ok: {} });
		const leases = (await storedOf(opened.journals, room.name)).filter(
			(entry) => entry.kind === 'lease',
		);
		expect(leases.some((entry) => JSON.stringify(entry).includes(unclaimed))).toBe(false);
		expect(leases).toContainEqual(
			expect.objectContaining({
				body: expect.objectContaining({
					id: activation,
					phase: 'ended',
					reason: 'released',
					usage,
				}),
			}),
		);
	});
});
