/** Recovery checks for Task receipts, delivery, room reconstruction, and settlement. */
import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, readRoom, resumeRoom, startRoom } from '../src/index.ts';
import type { TaskResponse, TaskSeatRoom } from '../src/protocol.ts';
import type { TaskCreateRequest, Transport } from '../src/transport.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { andrei, deferred, roomName } from './support/room.ts';
import {
	type FaultyJournals,
	faultyJournals,
	gatedJournals,
	type Storage,
	storages,
	tappedJournals,
} from './support/storage.ts';

interface Seat {
	calls: TaskSeatRoom;
	activation: string;
	wakes: string[];
}

interface Fixture {
	readonly room: Awaited<ReturnType<typeof startRoom>>;
	readonly runtime: ReturnType<typeof createRuntime>;
	readonly opened: Awaited<ReturnType<Storage['open']>>;
	readonly clock: FakeClock;
	readonly transport: Transport;
	readonly seats: Map<string, Seat>;
	readonly waitSeat: (room: string, seat: string) => Promise<Seat>;
	readonly owner: Seat;
	dispose(): Promise<void>;
}

const agents = ['owner', 'worker', 'other'].map((name) =>
	defineAgent({
		name,
		identity: name,
		instructions: 'Complete assigned work.',
		model: `scripted/${name}`,
	}),
);

function result(response: TaskResponse): Extract<TaskResponse, { task: string }> {
	if ('task' in response && 'room' in response) return response;
	throw new Error(
		`Task operation was refused: ${'refused' in response ? response.refused : 'unknown'}`,
	);
}

async function current(seat: Seat) {
	const response = await seat.calls.view(seat.activation);
	if (!('view' in response)) throw new Error('The activation has no view.');
	return response.view;
}

async function claim(seat: Seat) {
	const response = await seat.calls.lease({ activation: seat.activation, operation: 'claim' });
	expect(response).toHaveProperty('ok');
	return current(seat);
}

async function eventually(check: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (check()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(message);
}

async function setup(
	storage: Storage,
	journal: JournalOpener | undefined = undefined,
	providedOpened?: Awaited<ReturnType<Storage['open']>>,
	progress = false,
): Promise<Fixture> {
	const opened = providedOpened ?? (await storage.open());
	const clock = fakeClock();
	const seats = new Map<string, Seat>();
	const transport: Transport = {
		connect(calls, context) {
			return {
				async wake(wake) {
					const key = `${context.room}/${context.seat}`;
					const prior = seats.get(key);
					seats.set(key, {
						calls: calls as TaskSeatRoom,
						activation: wake.activation,
						wakes: [...(prior?.wakes ?? []), wake.activation],
					});
				},
				async steer() {},
				async cut() {},
			};
		},
	};
	const runtime = createRuntime({
		storage: journal ?? opened.storage,
		clock,
		transport,
		tasks: { progress },
	});
	const room = await startRoom({
		name: roomName('task-recovery'),
		runtime,
		agents,
		seats: { owner: 'broadcast' },
	});
	const visit = await room.visit(andrei);
	await visit.send({ text: 'Delegate durable work.' });
	await room.reconcile();
	await eventually(() => seats.has(`${room.name}/owner`), 'The owner was not woken.');
	const owner = seats.get(`${room.name}/owner`);
	if (owner === undefined) throw new Error('The owner seat is missing.');
	await claim(owner);
	return {
		room,
		runtime,
		opened,
		clock,
		seats,
		transport,
		owner,
		waitSeat: async (child, seat) => {
			await eventually(() => seats.has(`${child}/${seat}`), `The ${seat} seat was not woken.`);
			const found = seats.get(`${child}/${seat}`);
			if (found === undefined) throw new Error(`The ${seat} seat is missing.`);
			return found;
		},
		dispose: async () => {
			await room.stop().catch(() => {});
			await opened.dispose();
		},
	};
}

async function createTask(owner: Seat, key: string, agentsForTask: readonly string[]) {
	const view = await current(owner);
	const request: TaskCreateRequest = {
		activation: owner.activation,
		readThrough: view.through,
		key,
		text: `Complete ${key}.`,
		agents: agentsForTask,
	};
	return { request, created: result(await owner.calls.task(request)) };
}

describe.each(storages)('Task recovery on $name storage', (storage) => {
	it('scopes the same operation key across independent working rooms', async () => {
		const fixture = await setup(storage);
		try {
			const first = await createTask(fixture.owner, 'same-operation', ['worker']);
			const second = await createTask(fixture.owner, 'same-operation-second', ['worker']);
			await fixture.room.reconcile();
			const firstWorker = await fixture.waitSeat(first.created.room, 'worker');
			const secondWorker = await fixture.waitSeat(second.created.room, 'worker');
			const firstView = await claim(firstWorker);
			const secondView = await claim(secondWorker);

			const firstResponse = await firstWorker.calls.taskUpdate({
				activation: firstWorker.activation,
				readThrough: firstView.through,
				key: 'same-update',
				task: first.created.task,
				text: 'First working room finished.',
				status: 'succeeded',
			});
			const secondResponse = await secondWorker.calls.taskUpdate({
				activation: secondWorker.activation,
				readThrough: secondView.through,
				key: 'same-update',
				task: second.created.task,
				text: 'Second working room finished.',
				status: 'succeeded',
			});

			expect(result(firstResponse)).toMatchObject({
				task: first.created.task,
				status: 'succeeded',
			});
			expect(result(secondResponse)).toMatchObject({
				task: second.created.task,
				status: 'succeeded',
			});
			expect(second.created.task).not.toBe(first.created.task);
			const tasks = (await fixture.room.read()).tasks;
			expect(tasks).toHaveLength(2);
			expect(tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded']);
		} finally {
			await fixture.dispose();
		}
	});

	it('replays the original accepted update result after a later state change', async () => {
		const fixture = await setup(storage);
		try {
			const created = (await createTask(fixture.owner, 'retry-result', ['worker'])).created;
			await fixture.room.reconcile();
			const worker = await fixture.waitSeat(created.room, 'worker');
			const before = await claim(worker);
			const original = {
				activation: worker.activation,
				readThrough: before.through,
				key: 'original-update',
				task: created.task,
				text: 'Progress recorded.',
			};
			const accepted = result(await worker.calls.taskUpdate(original));
			expect(accepted).toMatchObject({ task: created.task, room: created.room, status: 'open' });

			const later = await current(worker);
			await worker.calls.taskUpdate({
				activation: worker.activation,
				readThrough: later.through,
				key: 'later-update',
				task: created.task,
				text: 'The later state settled the work.',
				status: 'succeeded',
			});
			const retried = result(await worker.calls.taskUpdate(original));
			expect(retried).toEqual(
				expect.objectContaining({
					task: created.task,
					room: created.room,
					status: 'open',
				}),
			);
			expect((await fixture.room.read()).tasks).toEqual([
				expect.objectContaining({ id: created.task, status: 'succeeded' }),
			]);
		} finally {
			await fixture.dispose();
		}
	});

	it('recovers a durable creation whose assignment acknowledgement was lost', async () => {
		const opened = await storage.open();
		const faulty: FaultyJournals = faultyJournals(opened.storage);
		const fixture = await setup(storage, faulty.journals, opened);
		let recovered: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			faulty.fail('after', 'task');
			const request = {
				activation: fixture.owner.activation,
				readThrough: (await current(fixture.owner)).through,
				key: 'lost-assignment-ack',
				text: 'Recover this assignment.',
				agents: ['worker'],
			} satisfies TaskCreateRequest;
			await expect(fixture.owner.calls.task(request)).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			fixture.runtime.evict(fixture.room.name);

			const recoveredRuntime = createRuntime({
				storage: faulty.journals,
				clock: fixture.clock,
				transport: fixture.transport,
			});
			recovered = await resumeRoom(fixture.room.name, {
				runtime: recoveredRuntime,
				agents,
			});
			await recovered.reconcile();
			const tasks = (await recovered.read()).tasks;
			expect(tasks).toHaveLength(1);
			expect(tasks[0]).toMatchObject({ text: request.text, status: 'open' });
			const task = tasks[0];
			if (task === undefined) throw new Error('The recovered Task is missing.');
			await eventually(
				() => fixture.seats.has(`${task.workingRoom}/worker`),
				'The recovered parent did not dispatch the worker.',
			);
			await recovered.reconcile();
			await recovered.reconcile();
			const child = await readRoom(task.workingRoom, {
				runtime: recoveredRuntime,
			});
			const childMessages = child.messages.filter(
				(message) => message.kind === 'said' && message.taskId === task.id,
			);
			expect(child.initialized).toBe(true);
			expect(childMessages).toHaveLength(1);
		} finally {
			faulty.fail(false);
			await recovered?.stop().catch(() => {});
			await fixture.dispose();
		}
	});

	it('recovers a destination message that landed before its delivery receipt', async () => {
		const opened = await storage.open();
		let origin: string | undefined;
		let failReceipt = false;
		let receiptFailed = false;
		let originTaskWrites = 0;
		const journal = tappedJournals(opened.storage, (id, _n, phase, kind) => {
			if (id === origin && kind === 'task' && phase === 'after') originTaskWrites += 1;
			if (!failReceipt || phase !== 'after' || id !== origin || kind !== 'task') return;
			if (originTaskWrites !== 2) return;
			failReceipt = false;
			receiptFailed = true;
			throw new Error('the delivery receipt acknowledgement was lost');
		});
		const fixture = await setup(storage, journal, opened);
		let resumed: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			origin = fixture.room.name;
			const created = (await createTask(fixture.owner, 'delivery-receipt', ['worker'])).created;
			failReceipt = true;
			await fixture.room.reconcile();
			await eventually(() => receiptFailed, 'The destination receipt failure did not occur.');
			await fixture.waitSeat(created.room, 'worker');
			const before = await readRoom(created.room, { runtime: fixture.runtime });
			expect(
				before.messages.filter(
					(message) => message.kind === 'said' && message.taskId === created.task,
				),
			).toHaveLength(1);

			fixture.runtime.evict(fixture.room.name);
			const recoveredRuntime = createRuntime({
				storage: opened.storage,
				clock: fixture.clock,
				transport: fixture.transport,
			});
			resumed = await resumeRoom(fixture.room.name, { runtime: recoveredRuntime, agents });
			await resumed.reconcile();
			await resumed.reconcile();
			const child = await readRoom(created.room, { runtime: recoveredRuntime });
			expect(
				child.messages.filter(
					(message) => message.kind === 'said' && message.taskId === created.task,
				),
			).toHaveLength(1);
			expect((await resumed.read()).tasks.filter((task) => task.id === created.task)).toHaveLength(
				1,
			);
		} finally {
			await resumed?.stop().catch(() => {});
			await fixture.dispose();
		}
	});

	it('cancels a Task whose creation write was in flight when abort began', async () => {
		const opened = await storage.open();
		let gateNextTask = true;
		const creationStarted = deferred();
		const releaseCreation = deferred();
		const journal = gatedJournals(opened.storage, async (kind) => {
			if (kind !== 'task' || !gateNextTask) return;
			gateNextTask = false;
			creationStarted.resolve();
			await releaseCreation.promise;
		});
		const fixture = await setup(storage, journal, opened);
		try {
			const view = await current(fixture.owner);
			const creating = fixture.owner.calls.task({
				activation: fixture.owner.activation,
				readThrough: view.through,
				key: 'abort-during-creation',
				text: 'This Task must be cancelled.',
				agents: ['worker'],
			});
			await creationStarted.promise;
			const aborting = fixture.room.abort();
			const outcomes = Promise.allSettled([creating, aborting]);
			releaseCreation.resolve();
			const [creation, aborted] = await outcomes;
			expect(creation.status).toBe('fulfilled');
			expect(aborted.status).toBe('fulfilled');
			await fixture.room.reconcile();
			const snapshot = await fixture.room.read();
			expect(snapshot.tasks).toHaveLength(1);
			expect(snapshot.tasks[0]).toMatchObject({ status: 'failed' });
			expect(snapshot.exchange).toBeUndefined();
			expect(snapshot.exchanges.at(-1)).toMatchObject({ status: 'closed' });
		} finally {
			releaseCreation.resolve();
			await fixture.dispose();
		}
	});

	it('replays a source operation that landed before its result receipt', async () => {
		const opened = await storage.open();
		let source: string | undefined;
		let failOperation = false;
		let operationFailed = false;
		let sourceTaskWrites = 0;
		const journal = tappedJournals(opened.storage, (id, _n, phase, kind) => {
			if (id === source && kind === 'task' && phase === 'after') sourceTaskWrites += 1;
			if (!failOperation || phase !== 'after' || id !== source || kind !== 'task') return;
			if (sourceTaskWrites !== 1) return;
			failOperation = false;
			operationFailed = true;
			throw new Error('the source operation receipt acknowledgement was lost');
		});
		const fixture = await setup(storage, journal, opened);
		let resumed: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			const created = (await createTask(fixture.owner, 'source-operation', ['worker'])).created;
			await fixture.room.reconcile();
			const worker = await fixture.waitSeat(created.room, 'worker');
			const before = await claim(worker);
			source = created.room;
			failOperation = true;
			const request = {
				activation: worker.activation,
				readThrough: before.through,
				key: 'source-operation-once',
				task: created.task,
				text: 'The source operation must recover.',
				status: 'succeeded',
			} as const;
			await expect(worker.calls.taskUpdate(request)).rejects.toThrow(/source operation receipt/);
			expect(operationFailed).toBe(true);
			failOperation = false;
			fixture.runtime.evict(fixture.room.name);

			const recoveredRuntime = createRuntime({
				storage: opened.storage,
				clock: fixture.clock,
				transport: fixture.transport,
			});
			resumed = await resumeRoom(fixture.room.name, { runtime: recoveredRuntime, agents });
			for (let attempt = 0; attempt < 10; attempt += 1) {
				await resumed.reconcile();
				if ((await resumed.read()).tasks[0]?.status === 'succeeded') break;
			}
			const task = (await resumed.read()).tasks[0];
			expect(task).toMatchObject({ id: created.task, status: 'succeeded' });
			expect(task?.events.filter((event) => event.type === 'updated')).toHaveLength(1);
		} finally {
			await resumed?.stop().catch(() => {});
			await fixture.dispose();
		}
	});

	it.each([false, true])(
		'uses the progress subscription setting for open updates and always notifies terminal updates (progress=%s)',
		async (progress) => {
			const fixture = await setup(storage, undefined, undefined, progress);
			try {
				const created = (await createTask(fixture.owner, `progress-${progress}`, ['worker']))
					.created;
				await fixture.room.reconcile();
				const worker = await fixture.waitSeat(created.room, 'worker');
				const claimed = await claim(worker);
				await worker.calls.taskUpdate({
					activation: worker.activation,
					readThrough: claimed.through,
					key: 'progress-update',
					task: created.task,
					text: 'Progress is available.',
				});
				await fixture.room.reconcile();
				const afterProgress = (await fixture.room.read()).messages.filter(
					(message) => message.kind === 'said' && message.taskId === created.task,
				);
				expect(afterProgress).toHaveLength(progress ? 1 : 0);
				expect(
					afterProgress.every((message) => message.kind === 'said' && message.to === 'owner'),
				).toBe(true);

				const currentWorker = await current(worker);
				await worker.calls.taskUpdate({
					activation: worker.activation,
					readThrough: currentWorker.through,
					key: 'terminal-update',
					task: created.task,
					text: 'The assignment is complete.',
					status: 'succeeded',
				});
				await fixture.room.reconcile();
				const ownerMessages = (await fixture.room.read()).messages.filter(
					(message) => message.kind === 'said' && message.taskId === created.task,
				);
				expect(ownerMessages).toHaveLength(progress ? 2 : 1);
				expect(
					ownerMessages.every((message) => message.kind === 'said' && message.to === 'owner'),
				).toBe(true);
			} finally {
				await fixture.dispose();
			}
		},
	);

	it('reconstructs the selected child roster after parent eviction without duplicate delivery', async () => {
		const fixture = await setup(storage);
		let resumed: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			const created = (await createTask(fixture.owner, 'selected-roster', ['worker', 'other']))
				.created;
			await fixture.room.reconcile();
			await fixture.waitSeat(created.room, 'worker');
			await fixture.waitSeat(created.room, 'other');
			const beforeParent = (await fixture.room.read()).messages.filter(
				(message) => message.kind === 'said' && message.taskId === created.task,
			);
			const beforeChild = (
				await readRoom(created.room, {
					runtime: fixture.runtime,
				})
			).messages.filter((message) => message.kind === 'said' && message.taskId === created.task);
			fixture.runtime.evict(fixture.room.name);

			const resumedRuntime = createRuntime({
				storage: fixture.opened.storage,
				clock: fixture.clock,
				transport: fixture.transport,
			});
			resumed = await resumeRoom(fixture.room.name, { runtime: resumedRuntime, agents });
			await resumed.reconcile();
			await resumed.reconcile();
			const child = await readRoom(created.room, {
				runtime: resumedRuntime,
			});
			expect(child.participants.map((participant) => participant.name)).toEqual([
				'worker',
				'other',
			]);
			expect((await resumed.read()).tasks.filter((task) => task.id === created.task)).toHaveLength(
				1,
			);
			expect(
				(await resumed.read()).messages.filter(
					(message) => message.kind === 'said' && message.taskId === created.task,
				),
			).toHaveLength(beforeParent.length);
			expect(
				child.messages.filter(
					(message) => message.kind === 'said' && message.taskId === created.task,
				),
			).toHaveLength(beforeChild.length);
		} finally {
			await resumed?.stop().catch(() => {});
			await fixture.dispose();
		}
	});

	it('keeps the first terminal transition and refuses the conflicting transition', async () => {
		const fixture = await setup(storage);
		try {
			const created = (await createTask(fixture.owner, 'first-terminal', ['worker', 'other']))
				.created;
			await fixture.room.reconcile();
			const worker = await fixture.waitSeat(created.room, 'worker');
			const other = await fixture.waitSeat(created.room, 'other');
			const workerView = await claim(worker);
			await claim(other);
			const first = result(
				await worker.calls.taskUpdate({
					activation: worker.activation,
					readThrough: workerView.through,
					key: 'terminal-success',
					task: created.task,
					text: 'The first terminal result won.',
					status: 'succeeded',
				}),
			);
			const otherView = await current(other);
			const conflict = await other.calls.taskUpdate({
				activation: other.activation,
				readThrough: otherView.through,
				key: 'terminal-failure',
				task: created.task,
				text: 'A conflicting failure must be refused.',
				status: 'failed',
			});
			expect(first).toMatchObject({ task: created.task, status: 'succeeded' });
			expect(conflict).toMatchObject({
				refused: expect.stringMatching(/already succeeded/),
				task: expect.objectContaining({ id: created.task, status: 'succeeded' }),
			});
			expect((await fixture.room.read()).tasks).toEqual([
				expect.objectContaining({ id: created.task, status: 'succeeded' }),
			]);
		} finally {
			await fixture.dispose();
		}
	});
});
