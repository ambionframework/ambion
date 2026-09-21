import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	type AgentExecutionContext,
	type AgentPort,
	hostingOf,
	inProcessTransport,
	type RoomProtocol,
	runningRoom,
	type Wake,
} from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { deferred, messagesOf, roomName, stateOf, storedOf, waitForRoom } from './support/room.ts';
import { byAgent, isClosing, quiet, scripted, speak } from './support/scripted.ts';
import {
	faultyJournals,
	gatedJournals,
	memory,
	type Storage,
	sqlite,
	storages,
} from './support/storage.ts';

const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const worker = defineAgent({
	name: 'worker',
	identity: 'Works on the question.',
	executor: pi({ instructions: 'answer the question', model: 'scripted/worker' }),
});
const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes a closing summary.',
	executor: pi({ instructions: 'summarise the discussion', model: 'scripted/assistant' }),
});

const deaf = scripted(() => new Promise<never>(() => {}));

async function unsettledAfterTurn<T>(promise: Promise<T>): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return settled;
}

async function closesWithoutSummary(room: Room, from: number): Promise<void> {
	await room.exchange(from)?.waitForClose();
}

describe('durable cancellation', () => {
	it('fences every old room call while admitting a new activation', async () => {
		const oldWake = deferred();
		const newWake = deferred();
		const wakes: Wake[] = [];
		const transport = {
			connect(_room: RoomProtocol, _context: AgentExecutionContext): AgentPort {
				return {
					wake: async (wake) => {
						wakes.push(wake);
						(wakes.length === 1 ? oldWake : newWake).resolve();
					},
					steer: async () => {},
					cut: async () => {},
				};
			},
		};
		const runtime = createRuntime({ transport });
		const room = await startRoom({
			name: roomName('cancel-authority'),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ stream: scripted(() => quiet()) }),
		});
		try {
			const visit = await room.visit(person);
			const first = await visit.send({ text: 'old question' });
			await oldWake.promise;
			const calls = runningRoom(runtime, room.name);
			if (calls === undefined) throw new Error('The room calls are not running.');
			const activation = wakes[0]?.activation;
			if (activation === undefined) throw new Error('The room did not send a wake.');
			const claimed = await calls.lease({ activation, operation: 'claim' });
			expect(claimed).toMatchObject({ ok: {} });
			const opened = await calls.view(activation);
			if ('stale' in opened) throw new Error('The old activation did not open.');
			await room.abort();

			expect(await calls.view(activation)).toMatchObject({ stale: expect.any(String) });
			expect(await calls.lease({ activation, operation: 'claim' })).toMatchObject({
				stale: expect.any(String),
			});
			expect(await calls.lease({ activation, operation: 'renew' })).toMatchObject({
				stale: expect.any(String),
			});
			expect(
				await calls.commit({
					activation,
					key: 'late-old-speech',
					readThrough: opened.view.through,
					intent: { kind: 'said', text: 'late old speech' },
				}),
			).toMatchObject({ stale: expect.any(String) });
			expect((await messagesOf(room)).filter((message) => message.from === worker.name)).toEqual(
				[],
			);

			const second = await visit.send({ text: 'new question' });
			await newWake.promise;
			expect(wakes[1]?.activation).not.toBe(activation);
			expect(
				await calls.lease({ activation: wakes[1]?.activation ?? '', operation: 'claim' }),
			).toMatchObject({
				ok: {},
			});
			expect(second.from).toBeGreaterThan(first.from);
			await room.abort();
		} finally {
			await room.stop();
		}
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
			const runtime = createRuntime({ transport });
			const room = await startRoom({
				name: roomName('cancel-transport'),
				agents: [worker],
				seats: { [worker.name]: 'broadcast' },
				runtime,
				execution: piExecution({
					stream: scripted(() => {
						started.resolve();
						return new Promise<never>(() => {});
					}),
				}),
			});
			try {
				const visit = await room.visit(person);
				await visit.send({ text: 'cut the worker' });
				await started.promise;
				await room.abort();
				await cutStarted.promise;
				expect(cuts).toBe(1);
			} finally {
				await room.stop();
			}
		},
	);

	it('does not let a stale cancellation cut a newer run', async () => {
		const opened = await memory.open();
		const cancelStarted = deferred();
		const releaseCancel = deferred();
		const runtime = createRuntime({
			storage: gatedJournals(opened.storage, (kind) => {
				if (kind === 'cancel') {
					cancelStarted.resolve();
					return releaseCancel.promise;
				}
				return undefined;
			}),
		});
		const name = roomName('cancel-fence');
		const old = await startRoom({
			name,
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ stream: deaf }),
		});
		const oldAbort = old.abort();
		await cancelStarted.promise;
		hostingOf(runtime).evict(name);
		const nextRuntime = createRuntime({ storage: opened.storage });
		const next = await resumeRoom(name, {
			agents: [worker],
			runtime: nextRuntime,
			execution: piExecution({ stream: deaf }),
		});
		try {
			const visit = await next.visit(person);
			const exchange = await visit.send({ text: 'new run work' });
			releaseCancel.resolve();
			await expect(oldAbort).rejects.toThrow(/gone|evicted|stopped|interrupted|record moved/i);
			expect(stateOf(next).exchange?.from).toBe(exchange.from);
			await next.abort();
		} finally {
			releaseCancel.resolve();
			await next.stop();
			await opened.dispose();
		}
	});

	it('cuts the current exchange and lets a later send open a new one', async () => {
		const room = await startRoom({
			name: roomName('cancel-cut'),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			execution: piExecution({ stream: deaf }),
		});
		try {
			const visit = await room.visit(person);
			const before = await visit.send({ text: 'before cancellation' });
			await room.abort();
			await closesWithoutSummary(room, before.from);
			const firstEnds = new Map<string, number>();
			for (const lease of stateOf(room).leases.values()) {
				if (lease.phase === 'ended' && lease.reason === 'revoked')
					firstEnds.set(lease.id, lease.until);
			}

			const after = await visit.send({ text: 'after cancellation' });
			expect(after.from).toBeGreaterThan(before.from);
			expect((await messagesOf(room)).filter((message) => message.from === worker.name)).toEqual(
				[],
			);
			await room.abort();
			for (const [id, until] of firstEnds)
				expect(stateOf(room).leases.get(id)).toMatchObject({ until });
		} finally {
			await room.stop();
		}
	});

	it('orders a send behind the cancellation cut', async () => {
		const opened = await memory.open();
		const cancelStarted = deferred();
		const releaseCancel = deferred();
		const runtime = createRuntime({
			storage: {
				async open(name) {
					const journal = await opened.storage.open(name);
					return {
						read: journal.read.bind(journal),
						async append(entry, expected) {
							if ((entry as { kind?: string }).kind === 'cancel') {
								cancelStarted.resolve();
								await releaseCancel.promise;
							}
							return journal.append(entry, expected);
						},
					};
				},
			},
		});
		const room = await startRoom({
			name: roomName('cancel-order'),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ stream: deaf }),
		});
		try {
			const visit = await room.visit(person);
			const before = await visit.send({ text: 'before cancellation' });
			const cancellation = room.abort();
			await cancelStarted.promise;
			const after = visit.send({ text: 'ordered after cancellation' });
			expect(await unsettledAfterTurn(after)).toBe(false);
			releaseCancel.resolve();
			await cancellation;
			const next = await after;
			expect(next.from).toBeGreaterThan(before.from);
			await room.abort();
		} finally {
			releaseCancel.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('fails an already pending summary without assigning one to the cancelled exchange', async () => {
		const summaryStarted = deferred();
		const room = await startRoom({
			name: roomName('cancel-summary'),
			summary: assistant.name,
			agents: [worker, assistant],
			seats: { [worker.name]: 'broadcast', [assistant.name]: 'none' },
			execution: piExecution({
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
		try {
			const visit = await room.visit(person);
			const first = await visit.send({ text: 'summarise this' });
			await first.waitForClose();
			await summaryStarted.promise;
			const second = await visit.send({ text: 'a new question' });
			await room.abort();
			await expect(first.waitForSummary()).rejects.toThrow(/interrupted/i);
			await expect(second.waitForSummary()).resolves.toBeUndefined();
			expect((await messagesOf(room)).filter((message) => message.kind === 'summary')).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});

describe.each(storages)('cancellation storage recovery (%s)', (storage: Storage) => {
	it.each(['before', 'after'] as const)(
		'converges after a %s-commit cancellation failure',
		async (phase) => {
			const opened = await storage.open();
			const faulty = faultyJournals(opened.storage);
			const runtime = createRuntime({ storage: faulty.journals });
			const room = await startRoom({
				name: roomName(`cancel-${phase}-${storage.name}`),
				agents: [worker],
				seats: { [worker.name]: 'broadcast' },
				runtime,
				execution: piExecution({ stream: deaf }),
			});
			try {
				const visit = await room.visit(person);
				const exchange = await visit.send({ text: 'cancel me' });
				faulty.fail(phase, 'cancel');
				await expect(room.abort()).rejects.toThrow(/disk is full/);
				faulty.fail(false);
				await room.abort();
				await closesWithoutSummary(room, exchange.from);
				expect((await messagesOf(room)).filter((message) => message.kind === 'summary')).toEqual(
					[],
				);
			} finally {
				faulty.fail(false);
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it('reuses the uncertain cancellation key after recovery and preserves later work', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const runtime = createRuntime({ storage: faulty.journals });
		const room = await startRoom({
			name: roomName(`cancel-retry-${storage.name}`),
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
			runtime,
			execution: piExecution({ stream: deaf }),
		});
		try {
			const visit = await room.visit(person);
			const first = await visit.send({ text: 'cancel with an uncertain acknowledgement' });
			faulty.fail('after', 'cancel');
			await expect(room.abort()).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			await messagesOf(room);

			const second = await visit.send({ text: 'land after the durable cut' });
			await room.abort();
			expect(
				(await storedOf(opened.journals, room.name)).filter((entry) => entry.kind === 'cancel'),
			).toHaveLength(1);
			expect(stateOf(room).exchange?.from).toBe(second.from);
			await room.abort();
			expect(
				(await storedOf(opened.journals, room.name)).filter((entry) => entry.kind === 'cancel'),
			).toHaveLength(2);
			await first.waitForClose();
		} finally {
			faulty.fail(false);
			await room.stop();
			await opened.dispose();
		}
	});
});

it('does not retry cancelled work after a restart', async () => {
	const opened = await sqlite.open();
	let now = Date.parse('2026-01-01T09:00:00.000Z');
	const clock = {
		now: () => now,
		alarm: (_at: number, _fire: () => void) => () => {},
	};
	const runtime = createRuntime({ storage: opened.storage, clock });
	let calls = 0;
	const started = deferred();
	const stream = scripted(() => {
		calls += 1;
		started.resolve();
		return new Promise<never>(() => {});
	});
	const name = roomName('cancel-restart');
	const room = await startRoom({
		name,
		agents: [worker],
		seats: { [worker.name]: 'broadcast' },
		runtime,
		execution: piExecution({ stream: stream }),
	});
	const visit = await room.visit(person);
	const exchange = await visit.send({ text: 'do not retry' });
	await visit.send({ text: 'pre-cut steering' });
	await started.promise;
	now += hostingOf(runtime).limits.lease.ttl + 1;
	await room.abort();
	await closesWithoutSummary(room, exchange.from);
	const ended = [...stateOf(room).leases.values()].find(
		(lease) => lease.phase === 'ended' && lease.reason === 'revoked',
	);
	expect(ended).toBeDefined();
	hostingOf(runtime).evict(name);
	const resumed = await resumeRoom(name, {
		runtime,
		agents: [worker],
		execution: piExecution({ stream: stream }),
	});
	try {
		await waitForRoom(resumed);
		expect(calls).toBe(1);
	} finally {
		await resumed.stop();
		await opened.dispose();
	}
});
