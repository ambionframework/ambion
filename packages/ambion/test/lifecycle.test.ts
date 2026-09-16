import { describe, expect, it } from 'vitest';
import { createRuntime, defineHuman, startRoom } from '../src/index.ts';
import { gatedJournals, faultyJournals, storages } from './support/storage.ts';
import { roomName } from './support/room.ts';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function settlesAfterTurn<T>(promise: Promise<T>): Promise<boolean> {
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

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const differentPerson = defineHuman({ name: 'andrei', identity: 'Impostor.' });

function bodyOf(entry: unknown): { kind?: string } | undefined {
	if (entry === null || typeof entry !== 'object') return undefined;
	const body = (entry as { body?: unknown }).body;
	return body !== null && typeof body === 'object' ? (body as { kind?: string }) : undefined;
}

describe.each(storages)('durable lifecycle acknowledgements (%s)', (storage) => {
	it('coalesces concurrent visits until the one arrival is durable', async () => {
		const opened = await storage.open();
		const arrivalStarted = deferred();
		const releaseArrival = deferred();
		const journal = gatedJournals(opened.storage, (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'arrived') return;
			arrivalStarted.resolve();
			return releaseArrival.promise;
		});
		const room = await startRoom({
			name: roomName('join-race'),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			const first = room.visit(person);
			void first.catch(() => {});
			await arrivalStarted.promise;
			const second = room.visit(person);
			expect(await settlesAfterTurn(second)).toBe(false);

			releaseArrival.resolve();
			const [one, two] = await Promise.all([first, second]);
			expect(one.human).toEqual(two.human);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
		} finally {
			releaseArrival.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('recovers a lost departure acknowledgement and keeps the old handle from a reentry', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName('leave-lost-ack'),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const oldVisit = await room.visit(person);
			faulty.fail('after', 'message');
			await expect(oldVisit.leave()).rejects.toThrow('disk is full');
			faulty.fail(false);

			const freshVisit = await room.visit(person);
			await expect(oldVisit.send({ text: 'old handle' })).rejects.toThrow(/ended|leaving/);
			await oldVisit.leave();
			expect(room.participants().find((entry) => entry.name === person.name)).toMatchObject({
				presence: 'present',
			});
			await freshVisit.leave();
			expect((await room.messages()).filter((message) => message.kind === 'left')).toHaveLength(2);
		} finally {
			faulty.fail(false);
			await room.stop();
			await opened.dispose();
		}
	});

	it('does not let a pending leave retry affect a new visit after stop', async () => {
		const opened = await storage.open();
		const departureStarted = deferred();
		const releaseDeparture = deferred();
		const journal = gatedJournals(opened.storage, (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'left') return;
			departureStarted.resolve();
			return releaseDeparture.promise;
		});
		const runtime = createRuntime({ storage: journal });
		const name = roomName('leave-stop-reentry');
		const room = await startRoom({ name, runtime });
		try {
			const oldVisit = await room.visit(person);
			const leave = oldVisit.leave();
			await departureStarted.promise;
			const stop = room.stop();
			releaseDeparture.resolve();
			await Promise.all([leave, stop]);

			const resumed = await startRoom({ name, runtime });
			try {
				const freshVisit = await resumed.visit(person);
				await oldVisit.leave();
				expect(resumed.participants().find((entry) => entry.name === person.name)).toMatchObject({
					presence: 'present',
				});
				await freshVisit.leave();
			} finally {
				await resumed.stop();
			}
		} finally {
			releaseDeparture.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('does not let a rejected arrival lend a usable visit to a concurrent caller', async () => {
		const opened = await storage.open();
		const arrivalStarted = deferred();
		const rejectArrival = deferred();
		const journal = gatedJournals(opened.storage, async (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'arrived') return;
			arrivalStarted.resolve();
			await rejectArrival.promise;
			throw new Error('arrival failed');
		});
		const room = await startRoom({
			name: roomName('join-failure'),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			const first = room.visit(person);
			void first.catch(() => {});
			await arrivalStarted.promise;
			const second = room.visit(person);
			expect(await settlesAfterTurn(second)).toBe(false);
			const secondSend = second.then((visit) => visit.send({ text: 'orphan?' }));
			void secondSend.catch(() => {});
			rejectArrival.resolve();
			await expect(first).rejects.toThrow('arrival failed');
			await expect(second).rejects.toThrow('arrival failed');
			await expect(secondSend).rejects.toThrow('arrival failed');
			expect((await room.messages()).some((message) => message.kind === 'said')).toBe(false);
		} finally {
			rejectArrival.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('does not piggyback a pending arrival under another identity', async () => {
		const opened = await storage.open();
		const arrivalStarted = deferred();
		const releaseArrival = deferred();
		const journal = gatedJournals(opened.storage, (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'arrived') return;
			arrivalStarted.resolve();
			return releaseArrival.promise;
		});
		const room = await startRoom({
			name: roomName('identity-race'),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			const first = room.visit(person);
			await arrivalStarted.promise;
			const second = room.visit(differentPerson);
			releaseArrival.resolve();
			await first;
			await expect(second).rejects.toThrow(/different identity/);
		} finally {
			releaseArrival.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('retries a failed departure instead of resolving a still-present visit', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName('leave-failure'),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const visit = await room.visit(person);
			faulty.fail('before', 'message');
			await expect(visit.leave()).rejects.toThrow('disk is full');
			faulty.fail(false);
			await visit.leave();
			const participant = room.participants().find((entry) => entry.name === person.name);
			expect(participant).toMatchObject({ kind: 'human', presence: 'absent' });
			expect((await room.messages()).filter((message) => message.kind === 'left')).toHaveLength(1);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('shares a blocked leave acknowledgement with concurrent callers', async () => {
		const opened = await storage.open();
		const departureStarted = deferred();
		const releaseDeparture = deferred();
		const journal = gatedJournals(opened.storage, (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'left') return;
			departureStarted.resolve();
			return releaseDeparture.promise;
		});
		const room = await startRoom({
			name: roomName('leave-race'),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			const visit = await room.visit(person);
			const first = visit.leave();
			await departureStarted.promise;
			const second = visit.leave();
			expect(await settlesAfterTurn(second)).toBe(false);
			releaseDeparture.resolve();
			await Promise.all([first, second]);
			expect((await room.messages()).filter((message) => message.kind === 'left')).toHaveLength(1);
		} finally {
			releaseDeparture.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('shares a blocked stop acknowledgement with concurrent callers', async () => {
		const opened = await storage.open();
		const departureStarted = deferred();
		const releaseDeparture = deferred();
		const journal = gatedJournals(opened.storage, (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'left') return;
			departureStarted.resolve();
			return releaseDeparture.promise;
		});
		const room = await startRoom({
			name: roomName('stop-race'),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			await room.visit(person);
			const first = room.stop();
			await departureStarted.promise;
			const second = room.stop();
			expect(await settlesAfterTurn(second)).toBe(false);
			releaseDeparture.resolve();
			await Promise.all([first, second]);
			expect(room.participants().find((entry) => entry.name === person.name)).toMatchObject({
				presence: 'absent',
			});
		} finally {
			releaseDeparture.resolve();
			// stop is idempotent once the gate has been released.
			await room.stop();
			await opened.dispose();
		}
	});

	it('closes admission while an arrival is blocked behind stop', async () => {
		const opened = await storage.open();
		const arrivalStarted = deferred();
		const releaseArrival = deferred();
		const journal = gatedJournals(opened.storage, (_kind, entry) => {
			if (bodyOf(entry)?.kind !== 'arrived') return;
			arrivalStarted.resolve();
			return releaseArrival.promise;
		});
		const room = await startRoom({
			name: roomName('join-stop-race'),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			const arrival = room.visit(person);
			void arrival.catch(() => {});
			await arrivalStarted.promise;
			const stop = room.stop();
			void stop.catch(() => {});

			await expect(room.visit(person)).rejects.toThrow(/stopped/);
			expect(await settlesAfterTurn(stop)).toBe(false);

			releaseArrival.resolve();
			await expect(arrival).rejects.toThrow(/stopped/);
			await stop;
			expect(room.participants().find((entry) => entry.name === person.name)).toMatchObject({
				presence: 'absent',
			});
		} finally {
			releaseArrival.resolve();
			await room.stop();
			await opened.dispose();
		}
	});
});
