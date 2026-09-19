/** Independent checks at the Task protocol boundary. No provider decides the outcome. */
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import type { TaskResponse } from '../src/protocol.ts';
import type { TaskCreateRequest, TaskSeatRoom, Transport } from '../src/transport.ts';
import { andrei, roomName } from './support/room.ts';
import { type Storage, storages } from './support/storage.ts';

interface Seat {
	calls: TaskSeatRoom;
	activation: string;
}

function accepted(response: TaskResponse): Extract<TaskResponse, { room: string }> {
	if ('room' in response && typeof response.room === 'string') return response;
	throw new Error(
		`Task operation was refused: ${'refused' in response ? response.refused : 'unknown error'}`,
	);
}

async function view(seat: Seat) {
	const response = await seat.calls.view(seat.activation);
	if (!('view' in response)) throw new Error('The activation has no view.');
	return response.view;
}

async function claim(seat: Seat) {
	expect(
		await seat.calls.lease({ activation: seat.activation, operation: 'claim' }),
	).toHaveProperty('ok');
	return view(seat);
}

async function setup(storage: Storage) {
	const opened = await storage.open();
	const seats = new Map<string, Seat>();
	const transport: Transport = {
		connect(calls, context) {
			return {
				async wake(wake) {
					seats.set(`${context.room}/${context.seat}`, {
						calls: calls as TaskSeatRoom,
						activation: wake.activation,
					});
				},
				async steer() {},
				async cut() {},
			};
		},
	};
	const name = roomName('task-authority');
	const runtime = createRuntime({ storage: opened.storage, transport });
	const room = await startRoom({
		name,
		runtime,
		agents: ['owner', 'worker', 'other'].map((agent) =>
			defineAgent({
				name: agent,
				identity: agent,
				instructions: 'Complete assigned work.',
				model: `scripted/${agent}`,
			}),
		),
		seats: { owner: 'broadcast' },
	});
	const visit = await room.visit(andrei);
	await visit.send({ text: 'Do parallel work.' });
	await room.reconcile();
	const seat = async (room: string, name: string) => {
		await expect.poll(() => seats.has(`${room}/${name}`)).toBe(true);
		const found = seats.get(`${room}/${name}`);
		if (found === undefined) throw new Error('The room did not dispatch the seat.');
		return found;
	};
	const owner = await seat(name, 'owner');
	await claim(owner);
	const request = async (key: string): Promise<TaskCreateRequest> => ({
		activation: owner.activation,
		readThrough: (await view(owner)).through,
		key,
		text: 'Check the result.',
		agents: ['worker'],
	});
	return {
		room,
		owner,
		seat,
		request,
		async dispose() {
			await room.stop();
			await opened.dispose();
		},
	};
}

describe.each(storages)('Task authority on $name', (storage) => {
	it('returns the original creation result when its operation is retried after completion', async () => {
		const fixture = await setup(storage);
		try {
			const request = await fixture.request('create-once');
			const created = accepted(await fixture.owner.calls.task(request));
			const worker = await fixture.seat(created.room, 'worker');
			const current = await claim(worker);
			await worker.calls.taskUpdate({
				activation: worker.activation,
				readThrough: current.through,
				key: 'complete',
				task: created.task,
				text: 'Checked.',
				status: 'succeeded',
			});
			expect(await fixture.owner.calls.task(request)).toMatchObject({
				task: created.task,
				room: created.room,
				status: created.status,
			});
			expect((await fixture.room.read()).tasks).toHaveLength(1);
		} finally {
			await fixture.dispose();
		}
	});

	it('rejects new mutations from an activation after its lease ends', async () => {
		const fixture = await setup(storage);
		try {
			const created = accepted(await fixture.owner.calls.task(await fixture.request('create')));
			const request = await fixture.request('late-create');
			await fixture.owner.calls.lease({
				activation: fixture.owner.activation,
				operation: 'release',
				reason: 'released',
				readThrough: request.readThrough,
			});
			await expect(fixture.owner.calls.task(request)).rejects.toThrow();
			await expect(
				fixture.owner.calls.taskSay({
					...request,
					task: created.task,
					key: 'late-steer',
				}),
			).rejects.toThrow();
			await expect(
				fixture.owner.calls.taskUpdate({
					...request,
					task: created.task,
					key: 'late-finish',
					status: 'succeeded',
				}),
			).rejects.toThrow();
		} finally {
			await fixture.dispose();
		}
	});

	it('rejects nested Tasks and attaching a Task to the originating room', async () => {
		const fixture = await setup(storage);
		try {
			const request = await fixture.request('create');
			const { agents: _agents, ...attachment } = request;
			await expect(
				fixture.owner.calls.task({ ...attachment, room: fixture.room.name }),
			).rejects.toThrow();
			const created = accepted(await fixture.owner.calls.task(request));
			const worker = await fixture.seat(created.room, 'worker');
			const current = await claim(worker);
			await expect(
				worker.calls.task({
					activation: worker.activation,
					readThrough: current.through,
					key: 'nested',
					text: 'Nested work.',
					agents: ['worker'],
				}),
			).rejects.toThrow();
		} finally {
			await fixture.dispose();
		}
	});

	it('fails outstanding Tasks when the owning exchange is cancelled', async () => {
		const fixture = await setup(storage);
		try {
			await fixture.owner.calls.task(await fixture.request('create'));
			await fixture.room.abort();
			const snapshot = await fixture.room.read();
			expect(snapshot.tasks).toEqual([expect.objectContaining({ status: 'failed' })]);
			expect(snapshot.exchange).toBeUndefined();
		} finally {
			await fixture.dispose();
		}
	});
});
