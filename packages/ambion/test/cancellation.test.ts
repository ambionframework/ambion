import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	type AgentExecutionContext,
	type AgentPort,
	hostingOf,
	inProcessTransport,
	type RoomProtocol,
	type Wake,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	type Room,
	type Runtime,
	resumeRoom,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import {
	manualClock,
	person,
	protocolOf,
	recordingTransport,
	settledFlag,
	turn,
	worker,
} from './support/core-exchange.ts';
import { deferred, messagesOf, roomName, stateOf, storedOf, waitForRoom } from './support/room.ts';
import { byAgent, isClosing, quiet, scripted, speak } from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { faultyJournals, gatedJournals, memory, sqlite, storages } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes a closing summary.',
	executor: pi({ instructions: 'summarise the discussion', model: 'scripted/assistant' }),
});

const deaf = scripted(() => new Promise<never>(() => {}));

/** A room with one broadcast worker that never answers, stopped when the test ends. */
async function workerRoom(runtime?: Runtime, options: Partial<StartRoomOptions> = {}) {
	return stopAtEnd(
		await startRoom({
			name: roomName('cancel'),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			execution: piExecution({ sessions: 'memory', stream: deaf }),
			...(runtime === undefined ? {} : { runtime }),
			...options,
		}),
	);
}

const workerSpoke = async (room: Room) =>
	(await messagesOf(room)).filter((message) => message.from === worker.name);

const cancels = async (journals: JournalOpener, room: Room) =>
	(await storedOf(journals, room.name)).filter((entry) => entry.kind === 'cancel');

describe('durable cancellation', () => {
	it('fences every old room call while admitting a new activation', async () => {
		const wakes: Wake[] = [];
		const runtime = createRuntime({ transport: recordingTransport(wakes) });
		const room = await workerRoom(runtime);
		const visit = await room.visit(person);
		const first = await visit.send({ text: 'old question' });
		while (wakes.length < 1) await turn();
		const calls = protocolOf(runtime, room.name);
		const activation = wakes[0]?.activation ?? '';
		expect(await calls.lease({ activation, operation: 'claim' })).toMatchObject({ ok: {} });
		const opened = await calls.view(activation);
		if ('stale' in opened) throw new Error('The old activation did not open.');
		await room.abort();

		const stale = { stale: expect.any(String) };
		expect(await calls.view(activation)).toMatchObject(stale);
		expect(await calls.lease({ activation, operation: 'claim' })).toMatchObject(stale);
		expect(await calls.lease({ activation, operation: 'renew' })).toMatchObject(stale);
		expect(
			await calls.commit({
				activation,
				key: 'late-old-speech',
				readThrough: opened.view.through,
				intent: { kind: 'said', text: 'late old speech' },
			}),
		).toMatchObject(stale);
		expect(await workerSpoke(room)).toEqual([]);

		const second = await visit.send({ text: 'new question' });
		while (wakes.length < 2) await turn();
		const fresh = wakes[1]?.activation ?? '';
		expect(fresh).not.toBe(activation);
		expect(await calls.lease({ activation: fresh, operation: 'claim' })).toMatchObject({ ok: {} });
		expect(second.from).toBeGreaterThan(first.from);
	});

	it.each(['hangs', 'throws'] as const)(
		'acknowledges the durable cut when seat termination %s',
		async (failure) => {
			let cuts = 0;
			const started = deferred();
			const cutStarted = deferred();
			const transport = {
				connect(room: RoomProtocol, context: AgentExecutionContext) {
					const port = inProcessTransport().connect(room, context);
					return {
						wake: (wake: Wake) => port.wake(wake),
						steer: (steer: Parameters<AgentPort['steer']>[0]) => port.steer(steer),
						cut: async () => {
							cuts += 1;
							cutStarted.resolve();
							if (failure === 'throws') throw new Error('Cut transport failed.');
							await new Promise<void>(() => {});
						},
					};
				},
			};
			const room = await workerRoom(createRuntime({ transport }), {
				execution: piExecution({
					sessions: 'memory',
					stream: scripted(() => {
						started.resolve();
						return new Promise<never>(() => {});
					}),
				}),
			});
			await (await room.visit(person)).send({ text: 'cut the worker' });
			await started.promise;
			await room.abort();
			await cutStarted.promise;
			expect(cuts).toBe(1);
		},
	);

	it('does not let a stale cancellation cut a newer run', async () => {
		const opened = await openFor(memory);
		const cancelStarted = deferred();
		const releaseCancel = deferred();
		const runtime = createRuntime({
			storage: gatedJournals(opened.storage, (kind) => {
				if (kind !== 'cancel') return undefined;
				cancelStarted.resolve();
				return releaseCancel.promise;
			}),
		});
		const old = await startRoom({
			name: roomName('cancel-fence'),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ sessions: 'memory', stream: deaf }),
		});
		const oldAbort = old.abort();
		await cancelStarted.promise;
		hostingOf(runtime).evict(old.name);
		const next = stopAtEnd(
			await resumeRoom(old.name, {
				agents: [worker],
				runtime: createRuntime({ storage: opened.storage }),
				execution: piExecution({ sessions: 'memory', stream: deaf }),
			}),
		);
		const exchange = await (await next.visit(person)).send({ text: 'new run work' });
		releaseCancel.resolve();
		await expect(oldAbort).rejects.toThrow(/gone|evicted|stopped|interrupted|record moved/i);
		expect(stateOf(next).exchange?.from).toBe(exchange.from);
	});

	it('orders a send behind the cut, which closes the exchange, and the send opens a new one', async () => {
		const opened = await openFor(memory);
		const cancelStarted = deferred();
		const releaseCancel = deferred();
		let gate = true;
		const room = await workerRoom(
			createRuntime({
				storage: gatedJournals(opened.storage, (kind) => {
					if (kind !== 'cancel' || !gate) return undefined;
					gate = false;
					cancelStarted.resolve();
					return releaseCancel.promise;
				}),
			}),
		);
		const visit = await room.visit(person);
		const before = await visit.send({ text: 'before cancellation' });
		const cancellation = room.abort();
		await cancelStarted.promise;
		const after = visit.send({ text: 'ordered after cancellation' });
		const landed = settledFlag(after);
		await turn();
		expect(landed()).toBe(false);
		releaseCancel.resolve();
		await cancellation;
		await room.exchange(before.from)?.waitForClose();
		const firstEnds = new Map<string, number>();
		for (const lease of stateOf(room).leases.values())
			if (lease.phase === 'ended' && lease.reason === 'revoked')
				firstEnds.set(lease.id, lease.until);
		expect(firstEnds.size).toBeGreaterThan(0);

		expect((await after).from).toBeGreaterThan(before.from);
		expect(await workerSpoke(room)).toEqual([]);
		await room.abort();
		for (const [id, until] of firstEnds)
			expect(stateOf(room).leases.get(id)).toMatchObject({ until });
	});

	it('fails an already pending summary without assigning one to the cancelled exchange', async () => {
		const summaryStarted = deferred();
		const room = await workerRoom(undefined, {
			summary: assistant.name,
			agents: [worker, assistant],
			seats: { [worker.name]: 'broadcast', [assistant.name]: 'none' },
			execution: piExecution({
				sessions: 'memory',
				stream: scripted(
					byAgent({
						worker: (_context, _agent, call) => (call === 1 ? speak('answer') : quiet()),
						assistant: (context) => {
							if (!isClosing(context)) return quiet();
							summaryStarted.resolve();
							return new Promise<never>(() => {});
						},
					}),
				),
			}),
		});
		const visit = await room.visit(person);
		const first = await visit.send({ text: 'summarise this' });
		await first.waitForClose();
		await summaryStarted.promise;
		const second = await visit.send({ text: 'a new question' });
		await room.abort();
		await expect(first.waitForSummary()).rejects.toThrow(/interrupted/i);
		await expect(second.waitForSummary()).resolves.toBeUndefined();
		expect((await messagesOf(room)).filter((message) => message.kind === 'summary')).toEqual([]);
	});
});

describe.each(storages)('cancellation storage recovery on $name', (storage) => {
	const faultyRoom = async () => {
		const opened = await openFor(storage);
		const faulty = faultyJournals(opened.storage);
		const room = await workerRoom(createRuntime({ storage: faulty.journals }));
		return { opened, faulty, room, visit: await room.visit(person) };
	};

	it.each(['before', 'after'] as const)(
		'converges after a %s-commit cancellation failure',
		async (phase) => {
			const { faulty, room, visit } = await faultyRoom();
			const exchange = await visit.send({ text: 'cancel me' });
			faulty.fail(phase, 'cancel');
			await expect(room.abort()).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			await room.abort();
			await room.exchange(exchange.from)?.waitForClose();
			expect((await messagesOf(room)).filter((message) => message.kind === 'summary')).toEqual([]);
		},
	);

	it('reuses the uncertain cancellation key after recovery and preserves later work', async () => {
		const { opened, faulty, room, visit } = await faultyRoom();
		const first = await visit.send({ text: 'cancel with an uncertain acknowledgement' });
		faulty.fail('after', 'cancel');
		await expect(room.abort()).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await messagesOf(room);

		const second = await visit.send({ text: 'land after the durable cut' });
		await room.abort();
		expect(await cancels(opened.journals, room)).toHaveLength(1);
		expect(stateOf(room).exchange?.from).toBe(second.from);
		await room.abort();
		expect(await cancels(opened.journals, room)).toHaveLength(2);
		await first.waitForClose();
	});
});

it('does not retry cancelled work after a restart', async () => {
	const opened = await openFor(sqlite);
	const time = manualClock();
	const runtime = createRuntime({ storage: opened.storage, clock: time.clock });
	let calls = 0;
	const started = deferred();
	const stream = scripted(() => {
		calls += 1;
		started.resolve();
		return new Promise<never>(() => {});
	});
	const room = await workerRoom(runtime, {
		execution: piExecution({ sessions: 'memory', stream }),
	});
	const visit = await room.visit(person);
	const exchange = await visit.send({ text: 'do not retry' });
	await visit.send({ text: 'pre-cut steering' });
	await started.promise;
	time.advance(hostingOf(runtime).limits.lease.ttl + 1);
	await room.abort();
	await room.exchange(exchange.from)?.waitForClose();
	expect([...stateOf(room).leases.values()]).toContainEqual(
		expect.objectContaining({ phase: 'ended', reason: 'revoked' }),
	);
	hostingOf(runtime).evict(room.name);
	const resumed = stopAtEnd(
		await resumeRoom(room.name, {
			runtime,
			agents: [worker],
			execution: piExecution({ sessions: 'memory', stream }),
		}),
	);
	await waitForRoom(resumed);
	expect(calls).toBe(1);
});
