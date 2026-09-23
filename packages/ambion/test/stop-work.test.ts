import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { hostingOf, type Wake } from '../src/hosting.ts';
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
	turn,
	worker,
} from './support/core-exchange.ts';
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
import { openFor, stopAtEnd } from './support/stop.ts';
import {
	faultyJournals,
	gatedJournals,
	sqlite,
	storages,
	tappedJournals,
} from './support/storage.ts';

type Stream = ReturnType<typeof scripted>;

/** A room with one worker seated `named`, stopped when the test ends. */
async function workerRoom(
	runtime: Runtime,
	stream: Stream,
	options: Partial<StartRoomOptions> = {},
) {
	return stopAtEnd(
		await startRoom({
			name: roomName('stop'),
			agents: [worker],
			seats: { [worker.name]: 'named' },
			runtime,
			execution: piExecution({ stream }),
			...options,
		}),
	);
}

const resume = async (room: Room, runtime: Runtime, stream: Stream, agents = [worker]) =>
	stopAtEnd(await resumeRoom(room.name, { runtime, agents, execution: piExecution({ stream }) }));

/** A stream whose activations of the named seat wait for the test to release them. */
function holding(seat = worker.name) {
	const started = deferred();
	const release = deferred();
	let calls = 0;
	const stream = scripted((_context, agent) => {
		if (agent !== seat) return quiet();
		calls += 1;
		started.resolve();
		return release.promise.then(() => quiet());
	});
	return { stream, started: started.promise, calls: () => calls };
}

/**
 * A storage that loses the acknowledgement of one append of the named kind
 * once armed, and then fails every read until the test heals it.
 */
function losing(source: JournalOpener, kind: string) {
	let armed = false;
	let unreadable = false;
	let failedReads = 0;
	const reading: JournalOpener = {
		async open(name) {
			const opened = await source.open(name);
			return {
				append: opened.append.bind(opened),
				async read(after) {
					if (!unreadable) return opened.read(after);
					failedReads += 1;
					throw new Error('the storage is unreadable');
				},
			};
		},
	};
	const journals = tappedJournals(reading, (_id, _n, phase, entryKind) => {
		if (!armed || phase !== 'after' || entryKind !== kind) return;
		armed = false;
		unreadable = true;
		throw new Error('disk is full');
	});
	return {
		journals,
		arm: () => {
			armed = true;
		},
		heal: () => {
			unreadable = false;
		},
		failedReads: () => failedReads,
	};
}

const revoked = expect.objectContaining({
	kind: 'lease',
	body: expect.objectContaining({ phase: 'ended', reason: 'revoked' }),
});

describe.each(storages)('stop on $name storage', (storage) => {
	it.each([
		['an expired activation', undefined],
		['an activation whose revocation fails before commit', 'before'],
		['an activation whose revocation fails after commit', 'after'],
	] as const)(
		'revokes %s, keeps the exchange open, and a resume does not retry it',
		async (_case, fault) => {
			const opened = await openFor(storage);
			const faulty = faultyJournals(opened.storage);
			const time = manualClock();
			const work = holding();
			const runtime = createRuntime({
				storage: faulty.journals,
				clock: time.clock,
				limits: { activation: { backoff: () => 0 } },
			});
			const room = await workerRoom(runtime, work.stream);
			const visit = await room.visit(person);
			const exchange = await visit.send({ to: worker.name, text: 'hold this work' });
			await work.started;
			if (fault === undefined) time.advance(hostingOf(runtime).limits.lease.ttl + 1);
			else {
				faulty.fail(fault, 'lease');
				await expect(room.stop()).rejects.toThrow(/disk is full/);
				faulty.fail(false);
			}
			await room.stop();
			expect(stateOf(room).exchange?.from).toBe(exchange.from);
			expect(stateOf(room).closes.some((close) => close.from === exchange.from)).toBe(false);
			expect(await storedOf(opened.journals, room.name)).toContainEqual(revoked);

			const resumed = await resume(room, runtime, work.stream);
			await resumed.reconcile();
			await turn();
			expect(work.calls()).toBe(1);
		},
	);

	it('waits for an unread claim before acknowledging stop', async () => {
		const opened = await openFor(storage);
		const lost = losing(opened.storage, 'lease');
		const wakes: Wake[] = [];
		const runtime = createRuntime({
			storage: lost.journals,
			transport: recordingTransport(wakes),
		});
		const quietly = scripted(() => quiet());
		const room = await workerRoom(runtime, quietly);
		await (await room.visit(person)).send({ to: worker.name, text: 'claim this work' });
		await turn();
		const activation = wakes[0]?.activation ?? '';
		lost.arm();
		await expect(
			protocolOf(runtime, room.name).lease({ activation, operation: 'claim' }),
		).rejects.toThrow(/disk is full/);
		await expect(room.stop()).rejects.toThrow(/unreadable/);
		lost.heal();
		await room.stop();

		const resumed = await resume(room, runtime, quietly);
		await resumed.reconcile();
		await turn();
		expect(wakes).toHaveLength(1);
		expect([...stateOf(resumed).leases.values()]).toContainEqual(
			expect.objectContaining({ phase: 'ended', reason: 'revoked' }),
		);
	});

	it('does not acknowledge stop while a durable arrival is unreadable', async () => {
		const opened = await openFor(storage);
		const lost = losing(opened.storage, 'message');
		const runtime = createRuntime({ storage: lost.journals });
		const room = stopAtEnd(await startRoom({ name: roomName('stop-empty-cache'), runtime }));
		lost.arm();
		await expect(room.visit(person)).rejects.toThrow(/disk is full/);
		await expect(room.stop()).rejects.toThrow(/unreadable/);
		lost.heal();
		await room.stop();
		expect(await storedOf(opened.journals, room.name)).toContainEqual(
			expect.objectContaining({
				kind: 'message',
				body: expect.objectContaining({ kind: 'left', subject: person.name }),
			}),
		);
		const resumed = stopAtEnd(await resumeRoom(room.name, { runtime, agents: [] }));
		expect(
			(await participantsOf(resumed)).find((participant) => participant.name === person.name),
		).toMatchObject({ presence: 'absent' });
	});

	it('revokes an expired pending summary lease before resume', async () => {
		const opened = await openFor(storage);
		const time = manualClock();
		const drafted = deferred();
		let summaryCalls = 0;
		const stream = scripted((context, agent, call) => {
			if (agent === worker.name) return call === 1 ? speak('answer') : quiet();
			if (!isClosing(context)) return quiet();
			summaryCalls += 1;
			drafted.resolve();
			return new Promise<never>(() => {});
		});
		const runtime = createRuntime({
			storage: opened.storage,
			clock: time.clock,
			limits: { activation: { backoff: () => 0 } },
		});
		const summary = defineAgent({
			name: 'summary',
			identity: 'Writes the closing summary.',
			executor: pi({ instructions: 'summarise the exchange', model: 'scripted/summary' }),
		});
		const room = await workerRoom(runtime, stream, {
			summary: summary.name,
			agents: [worker, summary],
			seats: { [worker.name]: 'named', [summary.name]: 'none' },
		});
		const exchange = await (
			await room.visit(person)
		).send({
			to: worker.name,
			text: 'summarise this',
		});
		await drafted.promise;
		time.advance(hostingOf(runtime).limits.lease.ttl + 1);
		await room.stop();

		const resumed = await resume(room, runtime, stream, [worker, summary]);
		await resumed.reconcile();
		await turn();
		expect(summaryCalls).toBe(1);
		expect(stateOf(resumed).closes.some((close) => close.from === exchange.from)).toBe(true);
		await expect(resumed.exchange(exchange.from)?.waitForSummary()).rejects.toThrow(/interrupted/);
	});

	it('answers a woken but unclaimed question after a resume', async () => {
		const opened = await openFor(storage);
		// This runtime only wakes the seat and never claims, so the question is
		// due but no lease covers it when the room stops.
		const wakes: Wake[] = [];
		const runtime = createRuntime({
			storage: opened.storage,
			transport: recordingTransport(wakes),
		});
		const room = await workerRoom(
			runtime,
			scripted(() => quiet()),
		);
		await (await room.visit(person)).send({ to: worker.name, text: 'answer me after the restart' });
		await turn();
		expect(wakes.length).toBeGreaterThan(0);
		await room.stop();
		// A planned stop writes no revocation for an activation that never claimed.
		expect(await storedOf(opened.journals, room.name)).not.toContainEqual(revoked);

		const resumed = await resume(
			room,
			createRuntime({ storage: opened.storage }),
			scripted((_context, _agent, call) => (call === 1 ? speak('the answer') : quiet())),
		);
		await waitForRoom(resumed, 'quiet');
		expect(await messagesOf(resumed)).toContainEqual(
			expect.objectContaining({ kind: 'said', from: worker.name, text: 'the answer' }),
		);
	});
});

it('takes up unread steering work after a stop and resume', async () => {
	const opened = await openFor(sqlite);
	const lost = losing(opened.storage, 'message');
	const work = holding();
	const runtime = createRuntime({
		storage: lost.journals,
		limits: { activation: { backoff: () => 0 } },
	});
	const room = await workerRoom(runtime, work.stream);
	const visit = await room.visit(person);
	const original = await visit.send({ to: worker.name, text: 'start work' });
	await work.started;
	lost.arm();
	await expect(visit.send({ to: worker.name, text: 'steer this work' })).rejects.toThrow(
		/disk is full/,
	);
	await messagesOf(room);
	expect(lost.failedReads()).toBeGreaterThan(0);
	// The first stop revokes the running lease before the read fails.
	await expect(room.stop()).rejects.toThrow(/unreadable/);
	lost.heal();
	await room.stop();

	// The steering message never claimed a lease, so the resumed room wakes
	// the seat for it. A planned stop keeps unclaimed work.
	const resumed = await resume(room, runtime, work.stream);
	for (let attempt = 0; attempt < 100 && work.calls() < 2; attempt += 1) {
		await resumed.reconcile();
		await turn();
	}
	expect(work.calls()).toBe(2);
	const steering = (await messagesOf(resumed)).find(
		(message) => message.kind === 'said' && message.text === 'steer this work',
	);
	const leaseOf = (seq: number | undefined) =>
		[...stateOf(resumed).leases].find(([id]) => id.startsWith(`message:${seq}:worker:`))?.[1];
	// The interrupted running attempt stays revoked; the unclaimed steering
	// work runs again in the new run.
	expect(leaseOf(original.from)).toMatchObject({
		phase: 'ended',
		reason: 'revoked',
		readThrough: 0,
	});
	expect(leaseOf(steering?.seq)).toMatchObject({ phase: 'running' });
});

it('fences a delayed old stop from revoking work in a newer run', async () => {
	const opened = await openFor(sqlite);
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
	const other = defineAgent({
		name: 'other',
		identity: 'Works on newer questions.',
		executor: pi({ instructions: 'answer the question', model: 'scripted/other' }),
	});
	const oldWork = holding();
	const newWork = holding(other.name);
	const runtime = createRuntime({ storage, clock: manualClock().clock });
	const agents = [worker, other];
	const seats = { [worker.name]: 'named', [other.name]: 'named' } as const;
	const old = await workerRoom(runtime, oldWork.stream, { agents, seats });
	await (await old.visit(person)).send({ to: worker.name, text: 'old work' });
	await oldWork.started;
	holdRevocation = true;
	const stopping = old.stop();
	await revocationStarted.promise;
	hostingOf(runtime).evict(old.name);

	const newer = await resume(old, runtime, newWork.stream, agents);
	await (await newer.visit(person)).send({ to: other.name, text: 'newer run work' });
	await newWork.started;
	releaseRevocation.resolve();
	await stopping;
	const newerLease = [...stateOf(newer).leases].find(([id]) => id.endsWith(':other:1'))?.[1];
	expect(newerLease).toMatchObject({ phase: 'running' });
});
