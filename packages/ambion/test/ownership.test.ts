/**
 * The room owns every value it records. A caller that changes a value it
 * passed in, or a value the room handed out, changes nothing on the record,
 * in a replay, or in what another caller reads. The tests hold for the room
 * API and for the protocol a seat calls over the wire.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import type {
	AgentExecutionContext,
	CommitRequest,
	LeaseRequest,
	RoomProtocol,
	Steer,
	Transport,
} from '../src/hosting.ts';
import {
	createRuntime,
	isSpoken,
	type Message,
	type Room,
	type RoomNotification,
	type Runtime,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { andrei, messagesOf, participantsOf, roomName, scriptedAgent } from './support/room.ts';
import { isClosing, quiet, scripted, speak } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { type OpenedStorage, type Storage, storages } from './support/storage.ts';

function changeMessage(message: Message): void {
	Reflect.set(message, 'from', 'intruder');
	Reflect.set(message, 'text', 'Changed outside the journal.');
	message.wakes?.push('intruder');
	if (message.kind === 'summary') message.covers.through = -1;
}

/** The live read of the room equals a replay of its record by a second runtime. */
async function expectReplayed(room: Room, runtime: Runtime, opened: OpenedStorage) {
	expect(await readRoom(room.name, { runtime })).toEqual(
		await readRoom(room.name, { runtime: createRuntime({ storage: opened.storage }) }),
	);
}

describe.each(storages)('room value ownership on $name', (storage) => {
	const writer = scriptedAgent('writer');

	async function open(options: Omit<Parameters<typeof startRoom>[0], 'name' | 'runtime'> = {}) {
		const opened = await openFor(storage);
		const runtime = createRuntime({ storage: opened.storage });
		const room = stopAtEnd(await startRoom({ name: roomName('owned'), runtime, ...options }));
		return { opened, runtime, room };
	}

	it.each(['messages', 'snapshot', 'exchange'] as const)(
		'detaches %s reads from the room and its replay',
		async (source) => {
			const { opened, runtime, room } = await open();
			const exchange = await (await room.visit(andrei)).send({ text: 'Original question.' });
			await exchange.waitForClose();
			const expected = await readRoom(room.name, {
				runtime: createRuntime({ storage: opened.storage }),
			});
			const messages =
				source === 'messages'
					? await messagesOf(room)
					: source === 'snapshot'
						? (await readRoom(room.name, { runtime })).messages
						: await exchange.waitForClose();
			const question = messages.find(isSpoken);
			if (question === undefined) throw new Error('No question was read.');
			changeMessage(question);
			expect(await messagesOf(room)).toEqual(expected.messages);
			expect(await readRoom(room.name, { runtime })).toEqual(expected);
			expect(await exchange.waitForClose()).toEqual(
				expected.messages.filter((message) => message.seq >= exchange.from),
			);
		},
	);

	it('captures read filters and seating options when the caller invokes them', async () => {
		const { opened, room } = await open({
			agents: [writer],
			seats: {},
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		const exchange = await (await room.visit(andrei)).send({ text: 'Original question.' });
		await exchange.waitForClose();
		const liveOptions = { messages: { since: 0 } };
		const recordedOptions = {
			runtime: createRuntime({ storage: opened.storage }),
			messages: { since: 0 },
		};
		const readings = [room.read(liveOptions), readRoom(room.name, recordedOptions)];
		liveOptions.messages.since = Number.MAX_SAFE_INTEGER;
		recordedOptions.messages.since = Number.MAX_SAFE_INTEGER;
		liveOptions.messages = { since: Number.MAX_SAFE_INTEGER };
		recordedOptions.messages = { since: Number.MAX_SAFE_INTEGER };
		for (const snapshot of await Promise.all(readings)) {
			expect(snapshot.messages.filter(isSpoken).map((message) => message.text)).toEqual([
				'Original question.',
			]);
		}
		const options: { attention: 'none' | 'broadcast' } = { attention: 'none' };
		const seating = room.seat(writer.name, options);
		options.attention = 'broadcast';
		await seating;
		expect(await participantsOf(room)).toContainEqual(
			expect.objectContaining({ name: writer.name, attention: 'none' }),
		);
	});

	it('detaches each summary response and its nested source range', async () => {
		const { room } = await open({
			agents: [writer],
			seats: { writer: 'none' },
			summary: writer.name,
			execution: piExecution({
				stream: scripted((context) => (isClosing(context) ? speak('Original result.') : quiet())),
			}),
		});
		const exchange = await (await room.visit(andrei)).send({ text: 'Question?' });
		const response = await exchange.waitForSummary();
		if (response === undefined) throw new Error('No summary was written.');
		const expected = structuredClone(response);
		changeMessage(response);
		expect(await exchange.waitForSummary()).toEqual(expected);
		expect((await messagesOf(room)).find((message) => message.kind === 'summary')).toEqual(
			expected,
		);
	});

	it('isolates notification listeners from each other and the room', async () => {
		const { opened, runtime, room } = await open();
		const seen: RoomNotification[] = [];
		const visit = await room.visit(andrei);
		room.subscribe((event) => {
			if (event.type === 'message') changeMessage(event.message);
			if (event.type === 'exchange_opened') Reflect.set(event.exchange, 'owner', 'intruder');
		});
		room.subscribe((event) => seen.push(event));
		const exchange = await visit.send({ text: 'Original question.' });
		await exchange.waitForClose();
		expect(seen).toContainEqual({
			type: 'message',
			message: expect.objectContaining({ from: andrei.name, text: 'Original question.' }),
		});
		expect(seen).toContainEqual({
			type: 'exchange_opened',
			exchange: expect.objectContaining({ owner: andrei.name }),
		});
		expect(exchange.owner).toBe(andrei.name);
		await expectReplayed(room, runtime, opened);
	});
});

/** A room whose seats the test answers itself, through the protocol the transport hands it. */
async function controlled(storage: Storage, mutateSteering = false) {
	const opened = await openFor(storage);
	const connections = new Map<
		string,
		{ calls: RoomProtocol; context: AgentExecutionContext; activation: string }
	>();
	const steered: Steer[] = [];
	const transport: Transport = {
		connect(calls, context) {
			return {
				async wake(wake) {
					connections.set(context.seat, { calls, context, activation: wake.activation });
				},
				async steer(steer) {
					steered.push(structuredClone(steer));
					if (mutateSteering) {
						Reflect.set(steer.message, 'text', 'Transport mutation.');
						steer.message.wakes?.push('intruder');
					}
				},
				async cut() {},
			};
		},
	};
	const runtime = createRuntime({ storage: opened.storage, transport });
	const agents = [scriptedAgent('alpha'), scriptedAgent('beta')];
	const room = stopAtEnd(await startRoom({ name: roomName('protocol'), agents, runtime }));
	const visit = await room.visit(andrei);
	await visit.send({ text: 'Initial question.' });
	await room.reconcile();
	const connection = (seat: string) => {
		const found = connections.get(seat);
		if (found === undefined) throw new Error(`No activation for ${seat}.`);
		return found;
	};
	return { opened, runtime, room, visit, connection, steered };
}

async function claim(connection: { calls: RoomProtocol; activation: string }) {
	expect(
		await connection.calls.lease({ activation: connection.activation, operation: 'claim' }),
	).toHaveProperty('ok');
	const response = await connection.calls.view(connection.activation);
	if (!('view' in response)) throw new Error('No activation view.');
	return response.view;
}

function tamper(messages: Message[]): void {
	for (const message of messages) {
		Reflect.set(message, 'text', 'Protocol mutation.');
		message.wakes?.push('intruder');
	}
}

describe.each(storages)('protocol value ownership on $name', (storage) => {
	it('captures requests before awaiting room work, and detaches results, replies, and snapshots', async () => {
		const { opened, runtime, room, connection } = await controlled(storage);
		const { calls, activation } = connection('alpha');
		const lease: LeaseRequest = { activation, operation: 'claim' };
		const claiming = calls.lease(lease);
		lease.activation = 'changed';
		expect(await claiming).toHaveProperty('ok');
		const response = await calls.view(activation);
		if (!('view' in response)) throw new Error('No activation view.');
		const original: CommitRequest = {
			activation,
			key: 'original',
			readThrough: response.view.through,
			intent: { kind: 'said', text: 'Original contribution.' },
		};
		const request = structuredClone(original);
		const committing = calls.commit(request);
		request.key = 'changed';
		request.intent = { kind: 'unseated', name: 'beta' };
		const result = await committing;
		expect(result).toMatchObject({
			committed: { kind: 'said', key: 'original', text: 'Original contribution.' },
		});
		expect((await participantsOf(room)).some((participant) => participant.name === 'beta')).toBe(
			true,
		);

		// the result and the idempotent reply to the same request are copies
		if (!('committed' in result)) throw new Error('The contribution was refused.');
		const expected = structuredClone(result);
		tamper([result.committed]);
		expect(await calls.commit(original)).toEqual(expected);

		// so is the current exchange in a live snapshot
		const snapshot = await readRoom(room.name, { runtime });
		if (snapshot.exchange === undefined) throw new Error('No exchange is open.');
		const exchange = structuredClone(snapshot.exchange);
		Reflect.set(snapshot.exchange, 'owner', 'intruder');
		expect((await readRoom(room.name, { runtime })).exchange).toEqual(exchange);
		expect(room.exchange(exchange.from)?.owner).toBe(andrei.name);
		await expectReplayed(room, runtime, opened);
	});

	it('isolates conflict notifications and missed messages from the room', async () => {
		const { opened, runtime, room, visit, connection } = await controlled(storage);
		const events: RoomNotification[] = [];
		const agent = connection('alpha');
		const view = await claim(agent);
		await visit.send({ text: 'New context.' });
		room.subscribe((event) => {
			if (event.type === 'conflict') tamper(event.missed);
		});
		room.subscribe((event) => events.push(event));
		const result = await agent.calls.commit({
			activation: agent.activation,
			key: 'stale-contribution',
			readThrough: view.through,
			intent: { kind: 'said', text: 'A stale answer.' },
		});
		if (!('missed' in result)) throw new Error('The stale contribution was accepted.');
		expect(result.missed.filter(isSpoken).map((message) => message.text)).toEqual(['New context.']);
		expect(events).toContainEqual({
			type: 'conflict',
			author: 'alpha',
			activation: agent.activation,
			missed: result.missed,
		});
		tamper(result.missed);
		await expectReplayed(room, runtime, opened);
	});

	it('gives each steering recipient an independent message', async () => {
		const { opened, runtime, room, visit, connection, steered } = await controlled(storage, true);
		await claim(connection('alpha'));
		await claim(connection('beta'));
		await visit.send({ text: 'Original context.' });
		expect(steered.map((steer) => steer.message)).toEqual([
			expect.objectContaining({ text: 'Original context.' }),
			expect.objectContaining({ text: 'Original context.' }),
		]);
		await expectReplayed(room, runtime, opened);
	});

	it('keeps error diagnostics deliverable when their causes cannot be cloned', async () => {
		const { room, connection } = await controlled(storage);
		const seen: RoomNotification[] = [];
		const error = new TypeError('Tool failed.', { cause: () => 'private callback' });
		room.subscribe((event) => {
			if ('agent' in event) event.agent = 'changed';
		});
		room.subscribe((event) => seen.push(event));
		const emit = connection('alpha').context.emit;
		emit?.({ type: 'error', agent: 'alpha', activation: 'audit', error });
		emit?.({ type: 'activation_start', agent: 'alpha', activation: 'audit' });
		expect(seen).toContainEqual({ type: 'error', agent: 'alpha', activation: 'audit', error });
		expect(seen.find((event) => event.type === 'error')?.error).toBe(error);
		expect(seen).toContainEqual({ type: 'activation_start', agent: 'alpha', activation: 'audit' });
	});
});
