import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { hostingOf, runningRoom, type SeatPort, type Wake } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	pi,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import {
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	stateOf,
	storedOf,
	waitForRoom,
} from './support/room.ts';
import { isClosing, quiet, scripted, speak } from './support/scripted.ts';
import {
	faultyJournals,
	gatedJournals,
	sqlite,
	storages,
	tappedJournals,
} from './support/storage.ts';

const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const worker = defineAgent({
	name: 'worker',
	identity: 'Works on the question.',
	executor: pi({ instructions: 'answer the question', model: 'scripted/worker' }),
});
const other = defineAgent({
	name: 'other',
	identity: 'Works on newer questions.',
	executor: pi({ instructions: 'answer the question', model: 'scripted/other' }),
});

describe.each(storages)('stop recovery after an unread claim on $name storage', (storage) => {
	it('waits for the unread claim before acknowledging stop', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let loseClaim = false;
		const journal = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!loseClaim || phase !== 'after' || kind !== 'lease') return;
			loseClaim = false;
			unreadable.fail(true);
			throw new Error('disk is full');
		});
		const wakes: Wake[] = [];
		const runtime = createRuntime({
			storage: journal,
			transport: {
				connect(): SeatPort {
					return {
						wake: async (wake) => {
							wakes.push(wake);
						},
						steer: async () => {},
						cut: async () => {},
					};
				},
			},
		});
		const name = roomName(`stop-unread-claim-${storage.name}`);
		const room = await startRoom({
			name,
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			streamFn: scripted(() => quiet()),
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'claim this work' });
			await new Promise<void>((resolve) => setImmediate(resolve));
			const wake = wakes[0];
			if (wake === undefined) throw new Error('The room did not send a wake.');
			const calls = runningRoom(runtime, name);
			if (calls === undefined) throw new Error('The room calls are not running.');
			loseClaim = true;
			await expect(
				calls.lease({ activation: wake.activation, operation: 'claim' }),
			).rejects.toThrow(/disk is full/);
			await expect(room.stop()).rejects.toThrow(/unreadable/);
			unreadable.fail(false);
			await room.stop();

			const resumed = await resumeRoom(name, {
				runtime,
				agents: [worker],
				streamFn: scripted(() => quiet()),
			});
			try {
				await resumed.reconcile();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(wakes).toHaveLength(1);
				expect(
					[...stateOf(resumed).leases.values()].some(
						(lease) => lease.phase === 'ended' && lease.reason === 'revoked',
					),
				).toBe(true);
			} finally {
				await resumed.stop();
			}
		} finally {
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});

function noOpClock(start = Date.parse('2026-01-01T09:00:00.000Z')) {
	let now = start;
	return {
		clock: {
			now: () => now,
			alarm: (_at: number, _fire: () => void) => () => {},
		},
		advance(ms: number) {
			now += ms;
		},
	};
}

function unreadableOpener(source: JournalOpener) {
	let unreadable = false;
	let failedReads = 0;
	return {
		storage: {
			async open(name: string) {
				const opened = await source.open(name);
				return {
					append: opened.append.bind(opened),
					async read(after: number) {
						if (unreadable) {
							failedReads += 1;
							throw new Error('the storage is unreadable');
						}
						return opened.read(after);
					},
				};
			},
		},
		fail(value: boolean) {
			unreadable = value;
		},
		readFailures() {
			return failedReads;
		},
	};
}

it('does not retry an expired activation after an acknowledged stop and resume', async () => {
	const opened = await sqlite.open();
	const time = noOpClock();
	let calls = 0;
	const started = deferred();
	const release = deferred();
	const stream = scripted(() => {
		calls += 1;
		started.resolve();
		return calls === 1 ? release.promise.then(() => quiet()) : quiet();
	});
	const runtime = createRuntime({
		storage: opened.storage,
		clock: time.clock,
		retry: { backoff: () => 0 },
	});
	const name = roomName('stop-expired');
	const room = await startRoom({
		name,
		agents: [worker],
		seats: { [worker.name]: 'named' },
		runtime,
		streamFn: stream,
	});
	try {
		const visit = await room.visit(person);
		await visit.send({ to: worker.name, text: 'hold this work' });
		await started.promise;
		time.advance(hostingOf(runtime).wake.expiry + 1);
		await room.stop();

		const resumed = await resumeRoom(name, { runtime, agents: [worker], streamFn: stream });
		try {
			await resumed.reconcile();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(calls).toBe(1);
			const leases = (await storedOf(opened.journals, name)).filter(
				(entry) => entry.kind === 'lease',
			);
			expect(
				leases.some(
					(entry) =>
						(entry.body as { phase?: string; reason?: string }).phase === 'ended' &&
						(entry.body as { phase?: string; reason?: string }).reason === 'revoked',
				),
			).toBe(true);
		} finally {
			await resumed.stop();
		}
	} finally {
		release.resolve();
		await room.stop().catch(() => {});
		await opened.dispose();
	}
});

describe.each(storages)('stop revocation recovery on $name storage', (storage) => {
	it.each(['before', 'after'] as const)(
		'retries a %s-commit revocation and leaves no old activation for resume',
		async (phase) => {
			const opened = await storage.open();
			const faulty = faultyJournals(opened.storage);
			const time = noOpClock();
			const started = deferred();
			const release = deferred();
			let calls = 0;
			const stream = scripted(() => {
				calls += 1;
				started.resolve();
				return release.promise.then(() => quiet());
			});
			const runtime = createRuntime({
				storage: faulty.journals,
				clock: time.clock,
				retry: { backoff: () => 0 },
			});
			const name = roomName(`stop-revocation-${phase}-${storage.name}`);
			const room = await startRoom({
				name,
				agents: [worker],
				seats: { [worker.name]: 'named' },
				runtime,
				streamFn: stream,
			});
			try {
				const visit = await room.visit(person);
				await visit.send({ to: worker.name, text: 'hold this activation' });
				await started.promise;
				faulty.fail(phase, 'lease');
				await expect(room.stop()).rejects.toThrow(/disk is full/);
				faulty.fail(false);
				await room.stop();

				const resumed = await resumeRoom(name, { runtime, agents: [worker], streamFn: stream });
				try {
					await resumed.reconcile();
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(calls).toBe(1);
				} finally {
					await resumed.stop();
				}
			} finally {
				faulty.fail(false);
				release.resolve();
				await room.stop().catch(() => {});
				await opened.dispose();
			}
		},
	);
});

it('takes up unread steering work after a stop and resume', async () => {
	const opened = await sqlite.open();
	const unreadable = unreadableOpener(opened.storage);
	let failSteer = false;
	const journal = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
		if (!failSteer || phase !== 'after' || kind !== 'message') return;
		failSteer = false;
		unreadable.fail(true);
		throw new Error('disk is full');
	});
	let calls = 0;
	const started = deferred();
	const release = deferred();
	const stream = scripted(() => {
		calls += 1;
		started.resolve();
		return release.promise.then(() => quiet());
	});
	const runtime = createRuntime({
		storage: journal,
		retry: { backoff: () => 0 },
	});
	const name = roomName('stop-unread-steer');
	const room = await startRoom({
		name,
		agents: [worker],
		seats: { [worker.name]: 'named' },
		runtime,
		streamFn: stream,
	});
	try {
		const visit = await room.visit(person);
		await visit.send({ to: worker.name, text: 'start work' });
		await started.promise;
		failSteer = true;
		await expect(visit.send({ to: worker.name, text: 'steer this work' })).rejects.toThrow(
			/disk is full/,
		);
		await messagesOf(room);
		expect(unreadable.readFailures()).toBeGreaterThan(0);
		// The first stop revokes the running lease before the read fails.
		await expect(room.stop()).rejects.toThrow(/unreadable/);
		unreadable.fail(false);
		await room.stop();

		const resumed = await resumeRoom(name, { runtime, agents: [worker], streamFn: stream });
		try {
			// The steering message never claimed a lease, so the resumed room wakes
			// the seat for it. A planned stop keeps unclaimed work.
			for (let attempt = 0; attempt < 100 && calls < 2; attempt += 1) {
				await resumed.reconcile();
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(calls).toBe(2);
			const messages = await messagesOf(resumed);
			const original = messages.find(
				(message) => message.kind === 'said' && message.text === 'start work',
			);
			const steering = messages.find(
				(message) => message.kind === 'said' && message.text === 'steer this work',
			);
			if (original === undefined || steering === undefined)
				throw new Error('The resumed room lost the steering messages.');
			const leases = stateOf(resumed).leases;
			const oldLease = [...leases].find(([id]) =>
				id.startsWith(`message:${original.seq}:worker:`),
			)?.[1];
			const steeringLease = [...leases].find(([id]) =>
				id.startsWith(`message:${steering.seq}:worker:`),
			)?.[1];
			// The interrupted running attempt stays revoked; the unclaimed steering
			// work runs again in the new run.
			expect(oldLease).toMatchObject({ phase: 'ended', reason: 'revoked', readThrough: 0 });
			expect(steeringLease).toMatchObject({ phase: 'running' });
		} finally {
			await resumed.stop();
		}
	} finally {
		unreadable.fail(false);
		release.resolve();
		await room.stop().catch(() => {});
		await opened.dispose();
	}
});

const summary = defineAgent({
	name: 'summary',
	identity: 'Writes the closing summary.',
	executor: pi({ instructions: 'summarise the exchange', model: 'scripted/summary' }),
});

describe.each(storages)('stopped summary recovery on $name storage', (storage) => {
	it('revokes an expired pending summary lease before resume', async () => {
		const opened = await storage.open();
		const time = noOpClock();
		const drafted = deferred();
		const release = deferred();
		let summaryCalls = 0;
		const stream = scripted((context, agent, call) => {
			if (agent === worker.name) return call === 1 ? speak('answer') : quiet();
			if (!isClosing(context)) return quiet();
			summaryCalls += 1;
			drafted.resolve();
			return release.promise.then(() => quiet());
		});
		const runtime = createRuntime({
			storage: opened.storage,
			clock: time.clock,
			retry: { backoff: () => 0 },
		});
		const name = roomName(`stop-summary-${storage.name}`);
		const room = await startRoom({
			name,
			summary: summary.name,
			agents: [worker, summary],
			seats: { [worker.name]: 'named', [summary.name]: 'none' },
			runtime,
			streamFn: stream,
		});
		try {
			const visit = await room.visit(person);
			const exchange = await visit.send({ to: worker.name, text: 'summarise this' });
			await drafted.promise;
			time.advance(hostingOf(runtime).wake.expiry + 1);
			await room.stop();

			const resumed = await resumeRoom(name, {
				runtime,
				agents: [worker, summary],
				streamFn: stream,
			});
			try {
				await resumed.reconcile();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(summaryCalls).toBe(1);
				expect(stateOf(resumed).closes.some((close) => close.from === exchange.from)).toBe(true);
				const recovered = resumed.exchange(exchange.from);
				if (recovered === undefined) throw new Error('The resumed exchange is missing.');
				await expect(recovered.waitForSummary()).rejects.toThrow(/interrupted/);
			} finally {
				await resumed.stop();
			}
		} finally {
			release.resolve();
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});

describe.each(storages)('stop recovery with an empty cache on $name storage', (storage) => {
	it('does not acknowledge stop while a durable arrival is unreadable', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let loseArrival = false;
		const journal = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!loseArrival || phase !== 'after' || kind !== 'message') return;
			loseArrival = false;
			unreadable.fail(true);
			throw new Error('disk is full');
		});
		const runtime = createRuntime({ storage: journal });
		const name = roomName(`stop-empty-cache-${storage.name}`);
		const room = await startRoom({ name, runtime });
		try {
			loseArrival = true;
			await expect(room.visit(person)).rejects.toThrow(/disk is full/);
			await expect(room.stop()).rejects.toThrow(/unreadable/);
			unreadable.fail(false);
			await room.stop();
			expect(
				(await storedOf(opened.journals, name)).some(
					(entry) =>
						entry.kind === 'message' &&
						(entry.body as { kind?: string; subject?: string }).kind === 'left' &&
						(entry.body as { kind?: string; subject?: string }).subject === person.name,
				),
			).toBe(true);

			const resumed = await resumeRoom(name, { runtime, agents: [] });
			try {
				expect(
					(await participantsOf(resumed)).find((participant) => participant.name === person.name),
				).toMatchObject({
					presence: 'absent',
				});
			} finally {
				await resumed.stop();
			}
		} finally {
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});

describe.each(storages)('durable stop state on $name storage', (storage) => {
	it('preserves an open exchange while the room is stopped', async () => {
		const opened = await storage.open();
		const time = noOpClock();
		const started = deferred();
		const release = deferred();
		const runtime = createRuntime({ storage: opened.storage, clock: time.clock });
		const name = roomName(`stop-open-exchange-${storage.name}`);
		const room = await startRoom({
			name,
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			streamFn: scripted(() => {
				started.resolve();
				return release.promise.then(() => quiet());
			}),
		});
		try {
			const visit = await room.visit(person);
			const exchange = await visit.send({ to: worker.name, text: 'keep this exchange open' });
			await started.promise;
			await room.stop();
			expect(stateOf(room).exchange?.from).toBe(exchange.from);
			expect(stateOf(room).closes.some((close) => close.from === exchange.from)).toBe(false);
		} finally {
			release.resolve();
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});

describe.each(storages)('graceful stop keeps unclaimed work on $name storage', (storage) => {
	it('answers a woken but unclaimed question after a resume', async () => {
		const opened = await storage.open();
		// This runtime only wakes the seat and never claims, so the question is
		// due but no lease covers it when the room stops.
		const wakes: Wake[] = [];
		const capturing = createRuntime({
			storage: opened.storage,
			transport: {
				connect(): SeatPort {
					return {
						wake: async (wake) => {
							wakes.push(wake);
						},
						steer: async () => {},
						cut: async () => {},
					};
				},
			},
		});
		const name = roomName(`stop-unclaimed-${storage.name}`);
		const room = await startRoom({
			name,
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime: capturing,
			streamFn: scripted(() => quiet()),
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ to: worker.name, text: 'answer me after the restart' });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(wakes.length).toBeGreaterThan(0);
			await room.stop();

			// A planned stop writes no revocation for an activation that never claimed.
			const revocations = (await storedOf(opened.journals, name)).filter(
				(entry) =>
					entry.kind === 'lease' &&
					(entry.body as { phase?: string; reason?: string }).phase === 'ended' &&
					(entry.body as { phase?: string; reason?: string }).reason === 'revoked',
			);
			expect(revocations).toHaveLength(0);

			// A second run over the same record wakes the seat and answers.
			const resumed = await resumeRoom(name, {
				runtime: createRuntime({ storage: opened.storage }),
				agents: [worker],
				streamFn: scripted((_context, agent, call) =>
					agent === worker.name && call === 1 ? speak('the answer') : quiet(),
				),
			});
			try {
				await waitForRoom(resumed, 'quiet');
				const messages = await messagesOf(resumed);
				expect(
					messages.some(
						(message) =>
							message.kind === 'said' &&
							message.from === worker.name &&
							message.text === 'the answer',
					),
				).toBe(true);
			} finally {
				await resumed.stop();
			}
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});

it('fences a delayed old stop from revoking work in a newer run', async () => {
	const opened = await sqlite.open();
	const revocationStarted = deferred();
	const releaseRevocation = deferred();
	let holdRevocation = false;
	const storage = gatedJournals(opened.storage, (kind, entry) => {
		if (!holdRevocation || kind !== 'lease') return;
		const body = (entry as { body?: { phase?: string; reason?: string } }).body;
		if (body?.phase !== 'ended' || body.reason !== 'revoked') return;
		holdRevocation = false;
		revocationStarted.resolve();
		return releaseRevocation.promise;
	});
	const oldStarted = deferred();
	const newStarted = deferred();
	const oldRelease = deferred();
	const newRelease = deferred();
	const runtime = createRuntime({
		storage,
		stream: scripted((_context, agent) => {
			if (agent === worker.name) {
				oldStarted.resolve();
				return oldRelease.promise.then(() => quiet());
			}
			newStarted.resolve();
			return newRelease.promise.then(() => quiet());
		}),
		clock: noOpClock().clock,
	});
	const name = roomName('stop-newer-run');
	const old = await startRoom({
		name,
		agents: [worker, other],
		seats: { [worker.name]: 'named', [other.name]: 'named' },
		runtime,
	});
	try {
		const oldVisit = await old.visit(person);
		await oldVisit.send({ to: worker.name, text: 'old work' });
		await oldStarted.promise;
		holdRevocation = true;
		const stopping = old.stop();
		await revocationStarted.promise;
		hostingOf(runtime).evict(name);

		const newer = await resumeRoom(name, {
			runtime,
			agents: [worker, other],
			streamFn: scripted((_context, agent) => {
				if (agent === other.name) {
					newStarted.resolve();
					return newRelease.promise.then(() => quiet());
				}
				return quiet();
			}),
		});
		try {
			const visit = await newer.visit(person);
			await visit.send({ to: other.name, text: 'newer run work' });
			await newStarted.promise;
			releaseRevocation.resolve();
			await stopping;
			const newerLease = [...stateOf(newer).leases].find(([id]) => id.endsWith(':other:1'))?.[1];
			expect(newerLease).toMatchObject({ phase: 'running' });
		} finally {
			releaseRevocation.resolve();
			newRelease.resolve();
			await newer.stop();
		}
	} finally {
		releaseRevocation.resolve();
		oldRelease.resolve();
		await old.stop().catch(() => {});
		await opened.dispose();
	}
});
