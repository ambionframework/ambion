import { describe, expect, it } from 'vitest';
import type {
	CommitRequest,
	LeaseRequest,
	SeatContext,
	SeatRoom,
	Steer,
	Transport,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	isSpoken,
	type Message,
	pi,
	type RoomNotification,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { andrei, participantsOf, roomName } from './support/room.ts';
import { type Storage, storages } from './support/storage.ts';

const agents = ['alpha', 'beta'].map((name) =>
	defineAgent({
		name,
		identity: name,
		executor: pi({ instructions: 'Answer.', model: `scripted/${name}` }),
	}),
);

async function controlled(storage: Storage, mutateSteering = false) {
	const opened = await storage.open();
	const connections = new Map<
		string,
		{ calls: SeatRoom; context: SeatContext; activation: string }
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
	const room = await startRoom({ name: roomName('protocol-ownership'), agents, runtime });
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

async function claim(connection: { calls: SeatRoom; activation: string }) {
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
	it('captures commit and lease requests before awaiting room work', async () => {
		const { opened, room, connection } = await controlled(storage);
		try {
			const { calls, activation } = connection('alpha');
			const lease: LeaseRequest = { activation, operation: 'claim' };
			const claiming = calls.lease(lease);
			lease.activation = 'changed';
			expect(await claiming).toHaveProperty('ok');
			const response = await calls.view(activation);
			if (!('view' in response)) throw new Error('No activation view.');
			const request: CommitRequest = {
				activation,
				key: 'original',
				readThrough: response.view.through,
				intent: { kind: 'said', text: 'Original contribution.' },
			};
			const committing = calls.commit(request);
			request.key = 'changed';
			request.intent = { kind: 'unseated', name: 'beta' };
			expect(await committing).toMatchObject({
				committed: { kind: 'said', key: 'original', text: 'Original contribution.' },
			});
			expect((await participantsOf(room)).some((participant) => participant.name === 'beta')).toBe(
				true,
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('detaches commit results and idempotent replies from recorded facts', async () => {
		const { opened, runtime, room, connection } = await controlled(storage);
		try {
			const agent = connection('alpha');
			const view = await claim(agent);
			const request: CommitRequest = {
				activation: agent.activation,
				key: 'contribution',
				readThrough: view.through,
				intent: { kind: 'said', text: 'Original contribution.' },
			};
			const result = await agent.calls.commit(request);
			if (!('committed' in result)) throw new Error('The contribution was refused.');
			const expected = structuredClone(result);
			tamper([result.committed]);
			expect(await agent.calls.commit(request)).toEqual(expected);
			expect(await readRoom(room.name, { runtime })).toEqual(
				await readRoom(room.name, { runtime: createRuntime({ storage: opened.storage }) }),
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('isolates conflict notifications and missed messages from the room', async () => {
		const { opened, runtime, room, visit, connection } = await controlled(storage);
		const events: RoomNotification[] = [];
		try {
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
			expect(result.missed.filter(isSpoken).map((message) => message.text)).toEqual([
				'New context.',
			]);
			expect(events).toContainEqual({
				type: 'conflict',
				author: 'alpha',
				activation: agent.activation,
				missed: result.missed,
			});
			tamper(result.missed);
			expect(await readRoom(room.name, { runtime })).toEqual(
				await readRoom(room.name, { runtime: createRuntime({ storage: opened.storage }) }),
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('gives each steering recipient an independent message', async () => {
		const { opened, runtime, room, visit, connection, steered } = await controlled(storage, true);
		try {
			await claim(connection('alpha'));
			await claim(connection('beta'));
			await visit.send({ text: 'Original context.' });
			expect(steered).toHaveLength(2);
			expect(steered.map((steer) => steer.message)).toEqual([
				expect.objectContaining({ text: 'Original context.' }),
				expect.objectContaining({ text: 'Original context.' }),
			]);
			expect(await readRoom(room.name, { runtime })).toEqual(
				await readRoom(room.name, { runtime: createRuntime({ storage: opened.storage }) }),
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('detaches the current exchange in live snapshots', async () => {
		const { opened, runtime, room } = await controlled(storage);
		try {
			const snapshot = await readRoom(room.name, { runtime });
			if (snapshot.exchange === undefined) throw new Error('No exchange is open.');
			const original = structuredClone(snapshot.exchange);
			Reflect.set(snapshot.exchange, 'owner', 'intruder');
			expect((await readRoom(room.name, { runtime })).exchange).toEqual(original);
			expect(room.exchange(original.from)?.owner).toBe(andrei.name);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('keeps error diagnostics deliverable when their causes cannot be cloned', async () => {
		const { opened, room, connection } = await controlled(storage);
		const seen: RoomNotification[] = [];
		try {
			const error = new TypeError('Tool failed.', { cause: () => 'private callback' });
			room.subscribe((event) => {
				if ('agent' in event) event.agent = 'changed';
			});
			room.subscribe((event) => seen.push(event));
			const emit = connection('alpha').context.emit;
			emit?.({ type: 'error', agent: 'alpha', activation: 'audit', error });
			emit?.({ type: 'audit_error', agent: 'alpha', activation: 'audit', error });
			emit?.({ type: 'activation_start', agent: 'alpha', activation: 'audit' });
			expect(seen).toContainEqual({ type: 'error', agent: 'alpha', activation: 'audit', error });
			expect(seen.find((event) => event.type === 'error')?.error).toBe(error);
			expect(seen.find((event) => event.type === 'audit_error')).toMatchObject({
				agent: 'alpha',
				activation: 'audit',
			});
			expect(seen.find((event) => event.type === 'audit_error')?.error).toBe(error);
			expect(seen).toContainEqual({
				type: 'activation_start',
				agent: 'alpha',
				activation: 'audit',
			});
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
