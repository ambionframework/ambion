/**
 * Visits and seatings are durable writes. A write that is held, fails before
 * it lands, or lands without an acknowledgement resolves to one entry on the
 * record, and a stale handle never changes the visit that replaced it.
 */
import type { JournalOpener } from '@ambionframework/journal';
import { Type } from 'typebox';
import { describe, expect, it, onTestFinished } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	type Room,
	resumeRoom,
	type StartRoomOptions,
	startRoom,
	type Visit,
} from '../src/index.ts';
import { refusal } from './support/errors.ts';
import { deferred, messagesOf, participantsOf, roomName, waitForRoom } from './support/room.ts';
import { callTool, quiet, scripted, toolNames } from './support/scripted.ts';
import {
	faultyJournals,
	gatedJournals,
	type Storage,
	storages,
	tappedJournals,
} from './support/storage.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const otherPerson = defineHuman({ name: 'andrei', identity: 'Founder, returned.' });

type Options = Omit<StartRoomOptions, 'name' | 'runtime'>;

async function settlesAfterTurn(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	const done = () => {
		settled = true;
	};
	void promise.then(done, done);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return settled;
}

const kinds = async (room: Pick<Room, 'read'>, kind: string) =>
	(await messagesOf(room)).filter((message) => message.kind === kind);

const presenceOf = async (room: Pick<Room, 'read'>) =>
	(await participantsOf(room)).find((entry) => entry.name === person.name);

/** Open a storage, wrap it, and start a room on it that the test end stops and disposes. */
async function roomOver(
	storage: Storage,
	wrap: (journals: JournalOpener) => JournalOpener,
	options: Options = {},
	cleanup = () => {},
) {
	const opened = await storage.open();
	const runtime = createRuntime({ storage: wrap(opened.storage) });
	const name = roomName(`lifecycle-${storage.name}`);
	const room = await startRoom({ name, runtime, ...options });
	onTestFinished(async () => {
		cleanup();
		await room.stop().catch(() => {});
		await opened.dispose();
	});
	return { room, runtime, name };
}

/** A room whose appends of one message kind wait until the test releases them. */
async function heldRoom(storage: Storage, held: 'arrived' | 'left', reject = false) {
	const started = deferred();
	const release = deferred();
	const hold = async (_kind: string | undefined, entry: unknown) => {
		if ((entry as { body?: { kind?: string } }).body?.kind !== held) return;
		started.resolve();
		await release.promise;
		if (reject) throw new Error('arrival failed');
	};
	const opened = await roomOver(
		storage,
		(journals) => gatedJournals(journals, hold),
		{},
		release.resolve,
	);
	return { ...opened, started: started.promise, release: release.resolve };
}

async function faultyRoom(storage: Storage, options: Options = {}) {
	let faulty: ReturnType<typeof faultyJournals> | undefined;
	const opened = await roomOver(
		storage,
		(journals) => {
			faulty = faultyJournals(journals);
			return faulty.journals;
		},
		options,
		() => faulty?.fail(false),
	);
	if (faulty === undefined) throw new Error('The storage was not wrapped.');
	return { ...opened, faulty };
}

/** Make the journal's recovery read fail independently of its append hook. */
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
						if (!unreadable) return opened.read(after);
						failedReads += 1;
						throw new Error('the storage is unreadable');
					},
				};
			},
		},
		fail(value: boolean) {
			unreadable = value;
		},
		readFailures: () => failedReads,
	};
}

/**
 * A room whose next message append, once armed, fails at `phase` and makes
 * every read fail too, so the recovery read loses the outcome as well.
 */
async function unreadableRoom(
	storage: Storage,
	options: Options = {},
	phase: 'before' | 'after' = 'after',
) {
	let unreadable: ReturnType<typeof unreadableOpener> | undefined;
	let armed = false;
	const opened = await roomOver(
		storage,
		(journals) => {
			const reads = unreadableOpener(journals);
			unreadable = reads;
			return tappedJournals(reads.storage, (_id, _n, at, kind) => {
				if (!armed || at !== phase || kind !== 'message') return;
				armed = false;
				reads.fail(true);
				throw new Error('the disk is full');
			});
		},
		options,
		() => unreadable?.fail(false),
	);
	if (unreadable === undefined) throw new Error('The storage was not wrapped.');
	const reads = unreadable;
	return {
		...opened,
		arm: () => {
			armed = true;
		},
		/** Drain the failed recovery read, check that it failed, and make the storage readable. */
		async recover() {
			await messagesOf(opened.room);
			expect(reads.readFailures()).toBeGreaterThan(0);
			reads.fail(false);
		},
		readable: () => reads.fail(false),
	};
}

describe.each(storages)('durable visits on $name storage', (storage) => {
	it('coalesces concurrent visits under one identity into one arrival, and refuses another identity', async () => {
		const { room, started, release } = await heldRoom(storage, 'arrived');
		const first = room.visit(person);
		await started;
		const second = room.visit(person);
		const other = room.visit(otherPerson);
		void other.catch(() => {});
		expect(await settlesAfterTurn(second)).toBe(false);

		release();
		const [one, two] = await Promise.all([first, second]);
		expect(one.human).toEqual(two.human);
		await expect(other).rejects.toThrow(/different identity/);
		await expect(room.visit(otherPerson)).rejects.toEqual(refusal('duplicate_name'));
		expect(await kinds(room, 'arrived')).toHaveLength(1);
	});

	it('does not let a rejected arrival lend a usable visit to a concurrent caller', async () => {
		const { room, started, release } = await heldRoom(storage, 'arrived', true);
		const first = room.visit(person);
		void first.catch(() => {});
		await started;
		const second = room.visit(person);
		expect(await settlesAfterTurn(second)).toBe(false);
		const secondSend = second.then((visit) => visit.send({ text: 'orphan?' }));
		void secondSend.catch(() => {});
		release();
		await expect(first).rejects.toThrow('arrival failed');
		await expect(second).rejects.toThrow('arrival failed');
		await expect(secondSend).rejects.toThrow('arrival failed');
		expect(await kinds(room, 'said')).toHaveLength(0);
	});

	it('closes admission while an arrival is blocked behind stop', async () => {
		const { room, started, release } = await heldRoom(storage, 'arrived');
		const arrival = room.visit(person);
		void arrival.catch(() => {});
		await started;
		const stop = room.stop();
		void stop.catch(() => {});

		await expect(room.visit(person)).rejects.toThrow(/stopped/);
		await expect(room.visit(person)).rejects.toEqual(refusal('room_stopped'));
		expect(await settlesAfterTurn(stop)).toBe(false);

		release();
		await expect(arrival).rejects.toThrow(/stopped/);
		await stop;
		expect(await presenceOf(room)).toMatchObject({ presence: 'absent' });
	});

	it.each([
		['leave', (_room: Room, visit: Visit) => visit.leave()],
		['stop', (room: Room) => room.stop()],
	] as const)('shares a blocked %s acknowledgement with concurrent callers', async (_, act) => {
		const { room, started, release } = await heldRoom(storage, 'left');
		const visit = await room.visit(person);
		const first = act(room, visit);
		await started;
		const second = act(room, visit);
		expect(await settlesAfterTurn(second)).toBe(false);
		release();
		await Promise.all([first, second]);
		expect(await kinds(room, 'left')).toHaveLength(1);
		expect(await presenceOf(room)).toMatchObject({ presence: 'absent' });
	});

	it('overlaps a blocked leave with stop, writes one left, and keeps the old handle from the next run', async () => {
		const { room, runtime, name, started, release } = await heldRoom(storage, 'left');
		const oldVisit = await room.visit(person);
		const leave = oldVisit.leave();
		await started;
		const stop = room.stop();
		expect(await settlesAfterTurn(stop)).toBe(false);
		release();
		await Promise.all([leave, stop]);
		expect(await kinds(room, 'left')).toHaveLength(1);

		const resumed = await startRoom({ name, runtime });
		onTestFinished(() => resumed.stop());
		const freshVisit = await resumed.visit(person);
		await oldVisit.leave();
		expect(await presenceOf(resumed)).toMatchObject({ presence: 'present' });
		await freshVisit.leave();
	});

	it.each(['before', 'after'] as const)(
		'retries a departure that failed %s its append, and writes one left',
		async (phase) => {
			const { room, faulty } = await faultyRoom(storage);
			const visit = await room.visit(person);
			faulty.fail(phase, 'message');
			await expect(visit.leave()).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			await visit.leave();
			expect(await presenceOf(room)).toMatchObject({ kind: 'human', presence: 'absent' });
			expect(await kinds(room, 'left')).toHaveLength(1);
		},
	);

	it.each([
		['the same identity', person],
		['a new identity', otherPerson],
	])('lets %s reenter after a lost departure, and keeps the old handle ended', async (_, who) => {
		const { room, faulty } = await faultyRoom(storage);
		const oldVisit = await room.visit(person);
		faulty.fail('after', 'message');
		await expect(oldVisit.leave()).rejects.toThrow(/disk is full/);
		faulty.fail(false);

		const freshVisit = await room.visit(who);
		expect(freshVisit.human).toEqual(who);
		expect(await kinds(room, 'arrived')).toHaveLength(2);
		await expect(oldVisit.send({ text: 'old handle', key: 'old-handle' })).rejects.toThrow(
			/ended|leaving/,
		);
		await oldVisit.leave();
		expect(await presenceOf(room)).toMatchObject({ identity: who.identity, presence: 'present' });
		await freshVisit.leave();
		expect(await kinds(room, 'left')).toHaveLength(2);
	});

	it('waits for a failed departure before explicit reentry can arrive', async () => {
		const departureStarted = deferred();
		const releaseDeparture = deferred();
		let hold = false;
		let faulty: ReturnType<typeof faultyJournals> | undefined;
		const { room } = await roomOver(
			storage,
			(journals) => {
				faulty = faultyJournals(journals);
				return gatedJournals(faulty.journals, (kind) => {
					if (!hold || kind !== 'message') return undefined;
					hold = false;
					departureStarted.resolve();
					return releaseDeparture.promise;
				});
			},
			{},
			releaseDeparture.resolve,
		);
		const oldVisit = await room.visit(person);
		faulty?.fail('before', 'message');
		await expect(oldVisit.leave()).rejects.toThrow(/disk is full/);
		faulty?.fail(false);

		hold = true;
		const reentry = room.visit(person);
		void reentry.catch(() => {});
		await departureStarted.promise;
		expect(await settlesAfterTurn(reentry)).toBe(false);

		releaseDeparture.resolve();
		const freshVisit = await reentry;
		expect((await messagesOf(room)).map((message) => message.kind)).toEqual([
			'arrived',
			'left',
			'arrived',
		]);
		await freshVisit.leave();
	});

	it.each(['stop', 'leave'] as const)(
		'completes the departure when a %s retries after a failed stop',
		async (retry) => {
			const { room, faulty } = await faultyRoom(storage);
			const visit = await room.visit(person);
			faulty.fail('before', 'message');
			if (retry === 'leave') await expect(visit.leave()).rejects.toThrow(/disk is full/);
			await expect(room.stop()).rejects.toThrow(/disk is full/);
			faulty.fail(false);

			await (retry === 'stop' ? room.stop() : visit.leave());
			expect(await kinds(room, 'left')).toHaveLength(1);
			expect(await presenceOf(room)).toMatchObject({ presence: 'absent' });
		},
	);

	it('fences a failed old stop after resume so it cannot leave the new run human', async () => {
		const { room: oldRoom, faulty, runtime, name } = await faultyRoom(storage);
		await oldRoom.visit(person);
		faulty.fail('before', 'message');
		await expect(oldRoom.stop()).rejects.toThrow(/disk is full/);
		faulty.fail(false);

		const resumed = await resumeRoom(name, { agents: [], runtime });
		onTestFinished(() => resumed.stop());
		const freshVisit = await resumed.visit(person);
		await oldRoom.stop();
		expect(await kinds(resumed, 'left')).toHaveLength(0);
		expect(await presenceOf(resumed)).toMatchObject({ presence: 'present' });
		await freshVisit.leave();
	});

	it('reacquires a committed keyed send after leave and reentry in the same exchange', async () => {
		const { room } = await roomOver(storage, (journals) => journals);
		const firstVisit = await room.visit(person);
		const firstExchange = await firstVisit.send({ text: 'same question', key: 'same-question' });
		await firstVisit.leave();

		const reentered = await room.visit(person);
		const retryExchange = await reentered.send({ text: 'same question', key: 'same-question' });
		expect(retryExchange.from).toBe(firstExchange.from);
		expect(retryExchange.owner).toBe(firstExchange.owner);
		expect(
			(await kinds(room, 'said')).filter((message) => message.key === 'same-question'),
		).toHaveLength(1);
		await reentered.leave();
	});

	it('does not duplicate an arrival when its append and recovery read both lose acknowledgement', async () => {
		const { room, arm, recover } = await unreadableRoom(storage);
		arm();
		await expect(room.visit(person)).rejects.toThrow(/disk is full/);
		await recover();
		const recovered = await room.visit(person);
		expect(await kinds(room, 'arrived')).toHaveLength(1);
		await recovered.leave();
	});

	it('retries stop after a durable left whose acknowledgement and recovery read were lost', async () => {
		const { room, arm, recover } = await unreadableRoom(storage);
		await room.visit(person);
		arm();
		await expect(room.stop()).rejects.toThrow(/disk is full/);
		await recover();
		await room.stop();
		expect(await kinds(room, 'left')).toHaveLength(1);
	});

	it('recovers a lost left with a lost recovery read before accepting a new identity', async () => {
		const { room, arm, recover } = await unreadableRoom(storage);
		const oldVisit = await room.visit(person);
		arm();
		await expect(oldVisit.leave()).rejects.toThrow(/disk is full/);
		await recover();
		const freshVisit = await room.visit(otherPerson);
		expect(await kinds(room, 'left')).toHaveLength(1);
		expect(await kinds(room, 'arrived')).toHaveLength(2);
		await expect(oldVisit.send({ text: 'stale old handle' })).rejects.toThrow(/ended|leaving/);
		await oldVisit.leave();
		expect(await kinds(room, 'left')).toHaveLength(1);
		await freshVisit.leave();
	});
});

/** An agent with one tool that records each call, on the scripted model that calls it once. */
function toolAgent(calls: string[]): Options {
	const chosen = defineAgent({
		name: 'analyst',
		identity: 'analyst',
		executor: pi({
			instructions: 'analyst',
			model: 'scripted/analyst',
			tools: [
				defineTool({
					name: 'chosen',
					description: 'chosen',
					parameters: Type.Object({}),
					execute: () => {
						calls.push('chosen');
						return 'chosen';
					},
				}),
			],
		}),
	});
	return {
		agents: [chosen],
		seats: {},
		execution: piExecution({
			sessions: 'memory',
			stream: scripted((context, _agent, call) =>
				call === 1 && toolNames(context).includes('chosen') ? callTool('chosen', {}) : quiet(),
			),
		}),
	};
}

describe.each(storages)('durable seatings on $name storage', (storage) => {
	it('commits one seating when callers race for the same registered name', async () => {
		const { room } = await roomOver(storage, (journals) => journals, toolAgent([]));
		const results = await Promise.allSettled([room.seat('analyst'), room.seat('analyst')]);
		expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
		expect(await kinds(room, 'seated')).toHaveLength(1);
	});

	it('rejects unknown definitions while a registered membership write waits', async () => {
		const gate = deferred();
		const entered = deferred();
		let hold = true;
		const calls: string[] = [];
		const { room } = await roomOver(
			storage,
			(journals) =>
				gatedJournals(journals, (kind) => {
					if (!hold || kind !== 'message') return undefined;
					entered.resolve();
					return gate.promise;
				}),
			toolAgent(calls),
			gate.resolve,
		);
		const seating = room.seat('analyst');
		await entered.promise;
		await expect(room.seat('unknown')).rejects.toThrow();
		hold = false;
		gate.resolve();
		await seating;
		await waitForRoom(room);
		expect(calls).toEqual(['chosen']);
	});

	it('recovers an unconfirmed seating without changing its executable definition', async () => {
		const calls: string[] = [];
		const { room, faulty } = await faultyRoom(storage, toolAgent(calls));
		faulty.fail('after', 'message');
		await expect(room.seat('analyst')).rejects.toThrow(/disk is full/);
		faulty.fail(false);
		await waitForRoom(room);
		expect((await participantsOf(room)).map((participant) => participant.name)).toContain(
			'analyst',
		);
		expect(calls).toEqual(['chosen']);
		expect(await kinds(room, 'seated')).toHaveLength(1);
	});

	it.each(['before', 'after'] as const)(
		'recovers a membership write that failed %s append while reads also failed',
		async (phase) => {
			const calls: string[] = [];
			const { room, arm, readable } = await unreadableRoom(storage, toolAgent(calls), phase);
			arm();
			await expect(room.seat('analyst')).rejects.toThrow(/disk is full/);
			readable();
			await room.seat('analyst');
			await waitForRoom(room);
			expect(calls).toEqual(['chosen']);
			expect(await kinds(room, 'seated')).toHaveLength(1);
		},
	);
});
