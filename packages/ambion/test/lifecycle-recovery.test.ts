import { describe, expect, it } from 'vitest';
import type { JournalOpener } from '@ambionframework/journal';
import { createRuntime, defineHuman, resumeRoom, startRoom } from '../src/index.ts';
import { faultyJournals, gatedJournals, storages, tappedJournals } from './support/storage.ts';
import { roomName } from './support/room.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const reenteredPerson = defineHuman({ name: 'andrei', identity: 'Founder, returned.' });

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Install a rejection observer before a gated operation can run. */
function observed<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => {});
	return promise;
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

function kindOf(entry: unknown): string | undefined {
	if (entry === null || typeof entry !== 'object') return undefined;
	const kind = (entry as { kind?: unknown }).kind;
	return typeof kind === 'string' ? kind : undefined;
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

async function leftMessages(room: { messages(): Promise<readonly { kind: string }[]> }) {
	return (await room.messages()).filter((message) => message.kind === 'left');
}

describe.each(storages)('durable visit recovery on $name storage', (storage) => {
	it('retries a durable departure whose acknowledgement was lost, writing one left', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName(`recovery-lost-ack-${storage.name}`),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const visit = await room.visit(person);
			faulty.fail('after', 'message');
			const firstLeave = observed(visit.leave());
			await expect(firstLeave).rejects.toThrow(/disk is full/);

			faulty.fail(false);
			await visit.leave();
			expect(await leftMessages(room)).toHaveLength(1);
			expect(
				room.participants().find((participant) => participant.name === person.name),
			).toMatchObject({
				presence: 'absent',
			});
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('reentry after a lost departure has a fresh handle while the old handle stays invalid', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName(`recovery-reentry-${storage.name}`),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const oldVisit = await room.visit(person);
			faulty.fail('after', 'message');
			const lostLeave = observed(oldVisit.leave());
			await expect(lostLeave).rejects.toThrow(/disk is full/);
			faulty.fail(false);

			const freshVisit = await room.visit(person);
			await expect(oldVisit.send({ text: 'old handle', key: 'old-handle' })).rejects.toThrow(
				/ended|leaving/,
			);
			const oldRetry = observed(oldVisit.leave());
			await oldRetry;
			expect(
				room.participants().find((participant) => participant.name === person.name),
			).toMatchObject({
				presence: 'present',
			});

			await freshVisit.leave();
			expect(await leftMessages(room)).toHaveLength(2);
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('overlaps a blocked leave with stop and records only one departure', async () => {
		const opened = await storage.open();
		const departureStarted = deferred();
		const releaseDeparture = deferred();
		let hold = false;
		const journal = gatedJournals(opened.storage, (kind) => {
			if (!hold || kind !== 'message') return undefined;
			hold = false;
			departureStarted.resolve();
			return releaseDeparture.promise;
		});
		const room = await startRoom({
			name: roomName(`recovery-stop-race-${storage.name}`),
			runtime: createRuntime({ storage: journal }),
		});
		let leave: Promise<void> | undefined;
		let stop: Promise<void> | undefined;
		try {
			const visit = await room.visit(person);
			hold = true;
			leave = observed(visit.leave());
			await departureStarted.promise;
			stop = observed(room.stop());
			expect(await settlesAfterTurn(stop)).toBe(false);

			releaseDeparture.resolve();
			await Promise.all([leave, stop]);
			expect(await leftMessages(room)).toHaveLength(1);
		} finally {
			hold = false;
			releaseDeparture.resolve();
			await leave?.catch(() => {});
			await stop?.catch(() => {});
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('waits for a failed departure before explicit reentry can arrive', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const departureStarted = deferred();
		const releaseDeparture = deferred();
		let hold = false;
		const journal = gatedJournals(faulty.journals, (kind) => {
			if (!hold || kind !== 'message') return undefined;
			hold = false;
			departureStarted.resolve();
			return releaseDeparture.promise;
		});
		const room = await startRoom({
			name: roomName(`recovery-reentry-order-${storage.name}`),
			runtime: createRuntime({ storage: journal }),
		});
		let reentry: Promise<Awaited<ReturnType<typeof room.visit>>> | undefined;
		try {
			const oldVisit = await room.visit(person);
			faulty.fail('before', 'message');
			const failedLeave = observed(oldVisit.leave());
			await expect(failedLeave).rejects.toThrow(/disk is full/);
			faulty.fail(false);

			hold = true;
			reentry = observed(room.visit(person));
			await departureStarted.promise;
			expect(await settlesAfterTurn(reentry)).toBe(false);

			releaseDeparture.resolve();
			const freshVisit = await reentry;
			expect((await room.messages()).map((message) => message.kind)).toEqual([
				'arrived',
				'left',
				'arrived',
			]);
			await freshVisit.leave();
		} finally {
			faulty.fail(false);
			hold = false;
			releaseDeparture.resolve();
			await reentry?.catch(() => {});
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('retries a failed stop on the same handle and completes the departure', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName(`recovery-stop-retry-${storage.name}`),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			await room.visit(person);
			faulty.fail('before', 'message');
			const failedStop = observed(room.stop());
			await expect(failedStop).rejects.toThrow(/disk is full/);

			faulty.fail(false);
			await room.stop();
			expect(await leftMessages(room)).toHaveLength(1);
			expect(
				room.participants().find((participant) => participant.name === person.name),
			).toMatchObject({
				presence: 'absent',
			});
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('finishes a failed leave after a failed stop once the old handle is retried', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName(`recovery-leave-after-stop-failure-${storage.name}`),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const oldVisit = await room.visit(person);
			faulty.fail('before', 'message');
			const failedLeave = observed(oldVisit.leave());
			await expect(failedLeave).rejects.toThrow(/disk is full/);

			const failedStop = observed(room.stop());
			await expect(failedStop).rejects.toThrow(/disk is full/);
			faulty.fail(false);

			await oldVisit.leave();
			expect(await leftMessages(room)).toHaveLength(1);
			expect(
				room.participants().find((participant) => participant.name === person.name),
			).toMatchObject({
				presence: 'absent',
			});
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('fences a failed old stop after resume so it cannot leave the new run human', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const runtime = createRuntime({ storage: faulty.journals });
		const name = roomName(`recovery-stop-fence-${storage.name}`);
		const oldRoom = await startRoom({ name, runtime });
		let resumed: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			await oldRoom.visit(person);
			faulty.fail('before', 'message');
			const failedStop = observed(oldRoom.stop());
			await expect(failedStop).rejects.toThrow(/disk is full/);
			faulty.fail(false);

			resumed = await resumeRoom(name, { agents: [], runtime });
			const freshVisit = await resumed.visit(person);
			await oldRoom.stop();
			expect(await leftMessages(resumed)).toHaveLength(0);
			expect(
				resumed.participants().find((participant) => participant.name === person.name),
			).toMatchObject({
				presence: 'present',
			});
			await freshVisit.leave();
		} finally {
			faulty.fail(false);
			await resumed?.stop().catch(() => {});
			await oldRoom.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('reacquires a committed keyed send after leave and reentry in the same exchange', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`recovery-keyed-send-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			const firstVisit = await room.visit(person);
			const firstExchange = await firstVisit.send({ text: 'same question', key: 'same-question' });
			await firstVisit.leave();

			const reentered = await room.visit(person);
			const retryExchange = await reentered.send({ text: 'same question', key: 'same-question' });
			expect(retryExchange.from).toBe(firstExchange.from);
			expect(retryExchange.owner).toBe(firstExchange.owner);
			expect(
				(await room.messages()).filter(
					(message) => message.kind === 'said' && message.key === 'same-question',
				),
			).toHaveLength(1);
			await reentered.leave();
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('consults the recovered departure before accepting a new identity on reentry', async () => {
		const opened = await storage.open();
		const faulty = faultyJournals(opened.storage);
		const room = await startRoom({
			name: roomName(`recovery-identity-${storage.name}`),
			runtime: createRuntime({ storage: faulty.journals }),
		});
		try {
			const oldVisit = await room.visit(person);
			faulty.fail('after', 'message');
			const failedLeave = observed(oldVisit.leave());
			await expect(failedLeave).rejects.toThrow(/disk is full/);
			faulty.fail(false);

			const newIdentity = await room.visit(reenteredPerson);
			expect(newIdentity.human).toEqual(reenteredPerson);
			expect(
				(await room.messages()).filter((message) => kindOf(message) === 'arrived'),
			).toHaveLength(2);
			await newIdentity.leave();
		} finally {
			faulty.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('does not duplicate an arrival when its append and recovery read both lose acknowledgement', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let failArrival = false;
		let appendFailed = false;
		const journal = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!failArrival || phase !== 'after' || kind !== 'message') return;
			failArrival = false;
			appendFailed = true;
			unreadable.fail(true);
			throw new Error('disk is full');
		});
		const room = await startRoom({
			name: roomName(`recovery-arrival-read-failure-${storage.name}`),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			failArrival = true;
			const failedArrival = observed(room.visit(person));
			await expect(failedArrival).rejects.toThrow(/disk is full/);
			// Drain the journal's failed recovery read while it is still unreadable.
			await room.messages();
			expect(appendFailed).toBe(true);
			expect(unreadable.readFailures()).toBeGreaterThan(0);

			unreadable.fail(false);
			const recovered = await room.visit(person);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
			await recovered.leave();
		} finally {
			failArrival = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('retries stop after a durable left whose acknowledgement and recovery read were lost', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let failStop = false;
		let appendFailed = false;
		const journal = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!failStop || phase !== 'after' || kind !== 'message') return;
			failStop = false;
			appendFailed = true;
			unreadable.fail(true);
			throw new Error('disk is full');
		});
		const room = await startRoom({
			name: roomName(`recovery-stop-read-failure-${storage.name}`),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			await room.visit(person);
			failStop = true;
			const failedStop = observed(room.stop());
			await expect(failedStop).rejects.toThrow(/disk is full/);
			// The stop's queued recovery read also fails, leaving the folded state present.
			await room.messages();
			expect(appendFailed).toBe(true);
			expect(unreadable.readFailures()).toBeGreaterThan(0);

			unreadable.fail(false);
			await room.stop();
			expect(await leftMessages(room)).toHaveLength(1);
		} finally {
			failStop = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('recovers a lost left before accepting a different reentry identity', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let failLeave = false;
		let appendFailed = false;
		const journal = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!failLeave || phase !== 'after' || kind !== 'message') return;
			failLeave = false;
			appendFailed = true;
			unreadable.fail(true);
			throw new Error('disk is full');
		});
		const room = await startRoom({
			name: roomName(`recovery-identity-read-failure-${storage.name}`),
			runtime: createRuntime({ storage: journal }),
		});
		try {
			const oldVisit = await room.visit(person);
			failLeave = true;
			const failedLeave = observed(oldVisit.leave());
			await expect(failedLeave).rejects.toThrow(/disk is full/);
			// Force the journal's queued recovery read to fail while the cache is stale.
			await room.messages();
			expect(appendFailed).toBe(true);
			expect(unreadable.readFailures()).toBeGreaterThan(0);

			unreadable.fail(false);
			const freshVisit = await room.visit(reenteredPerson);
			expect(await leftMessages(room)).toHaveLength(1);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				2,
			);
			await expect(oldVisit.send({ text: 'stale old handle' })).rejects.toThrow(/ended|leaving/);
			await oldVisit.leave();
			expect(await leftMessages(room)).toHaveLength(1);
			await freshVisit.leave();
		} finally {
			failLeave = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});
