import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
	type Visit,
} from '../src/index.ts';
import { roomName } from './support/room.ts';
import { gatedJournals, storages, tappedJournals } from './support/storage.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const returnedPerson = defineHuman({ name: 'andrei', identity: 'Founder, returned.' });

it('keeps absence explicit in inferred visit types', () => {
	const checkTypes = (room: Room, arrive: boolean) => {
		expectTypeOf(room.visit(person)).toEqualTypeOf<Promise<Visit>>();
		expectTypeOf(room.visit(person, { arrive: true })).toEqualTypeOf<Promise<Visit>>();
		expectTypeOf(room.visit(person, { arrive: false })).toEqualTypeOf<Promise<Visit | undefined>>();
		expectTypeOf(room.visit(person, { arrive })).toEqualTypeOf<Promise<Visit | undefined>>();
	};
	expectTypeOf(checkTypes).returns.toBeVoid();
});

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

function bodyKind(entry: unknown): string | undefined {
	if (entry === null || typeof entry !== 'object') return undefined;
	const body = (entry as { body?: unknown }).body;
	if (body === null || typeof body !== 'object') return undefined;
	const kind = (body as { kind?: unknown }).kind;
	return typeof kind === 'string' ? kind : undefined;
}

function unreadableOpener(source: JournalOpener) {
	let failing = false;
	let failures = 0;
	return {
		storage: {
			async open(name: string) {
				const opened = await source.open(name);
				return {
					append: opened.append.bind(opened),
					async read(after: number) {
						if (failing) {
							failures += 1;
							throw new Error('the storage is unreadable');
						}
						return opened.read(after);
					},
				};
			},
		},
		fail(value: boolean) {
			failing = value;
		},
		readFailures() {
			return failures;
		},
	};
}

describe.each(storages)('existing-only visits on $name storage', (storage) => {
	it('returns undefined without writing an arrival when the person is absent', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`existing-only-absent-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			await expect(room.visit(person, { arrive: false })).resolves.toBeUndefined();
			expect(room.participants().some((participant) => participant.name === person.name)).toBe(
				false,
			);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				0,
			);
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('returns the existing identity without appending a second arrival', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`existing-only-present-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			const first = await room.visit(person);
			const existing = await room.visit(person, { arrive: false });
			expect(existing).toBeDefined();
			expect(existing?.human).toEqual(person);
			expect(existing?.since).toBe(first.since);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
			await existing?.leave();
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('rejects a different identity instead of treating it as absent', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`existing-only-identity-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			await room.visit(person);
			const mismatch = observed(room.visit(returnedPerson, { arrive: false }));
			await expect(mismatch).rejects.toThrow(/different identity/);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('does not turn an existing-only check into a pending ordinary arrival', async () => {
		const opened = await storage.open();
		let arrivalStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			arrivalStarted = resolve;
		});
		let releaseArrival!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseArrival = resolve;
		});
		const journals = gatedJournals(opened.storage, async (kind, entry) => {
			if (kind !== 'message' || bodyKind(entry) !== 'arrived') return;
			arrivalStarted();
			await release;
		});
		const room = await startRoom({
			name: roomName(`existing-only-race-${storage.name}`),
			runtime: createRuntime({ storage: journals }),
		});
		try {
			const ordinary = observed(room.visit(person));
			await started;
			const existingOnly = observed(room.visit(person, { arrive: false }));
			expect(await settlesAfterTurn(existingOnly)).toBe(false);
			releaseArrival();
			const [ordinaryVisit, existingVisit] = await Promise.all([ordinary, existingOnly]);
			expect(ordinaryVisit).toBeDefined();
			expect(existingVisit).toBeDefined();
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
			await ordinaryVisit.leave();

			const absentFirst = observed(room.visit(person, { arrive: false }));
			const ordinaryAfter = observed(room.visit(person));
			await expect(absentFirst).resolves.toBeUndefined();
			await expect(ordinaryAfter).resolves.toBeDefined();
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				2,
			);
		} finally {
			releaseArrival();
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('consults recovered departure state before returning an existing-only result', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let failDeparture = false;
		let appended = false;
		const journals = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!failDeparture || phase !== 'after' || kind !== 'message') return;
			failDeparture = false;
			appended = true;
			unreadable.fail(true);
			throw new Error('the disk is full');
		});
		const room = await startRoom({
			name: roomName(`existing-only-recovery-${storage.name}`),
			runtime: createRuntime({ storage: journals }),
		});
		try {
			const visit = await room.visit(person);
			failDeparture = true;
			const departure = observed(visit.leave());
			await expect(departure).rejects.toThrow(/disk is full/);
			const failedRead = observed(room.messages());
			await failedRead.catch(() => {});
			expect(appended).toBe(true);
			expect(unreadable.readFailures()).toBeGreaterThan(0);
			unreadable.fail(false);
			await expect(room.visit(person, { arrive: false })).resolves.toBeUndefined();
			expect((await room.messages()).filter((message) => message.kind === 'left')).toHaveLength(1);
		} finally {
			failDeparture = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('rejects an existing-only read while storage recovery is unreadable, then accepts after healing', async () => {
		const opened = await storage.open();
		const unreadable = unreadableOpener(opened.storage);
		let failSeat = false;
		const journals = tappedJournals(unreadable.storage, (_id, _n, phase, kind) => {
			if (!failSeat || phase !== 'before' || kind !== 'message') return;
			failSeat = false;
			unreadable.fail(true);
			throw new Error('the disk is full');
		});
		const room = await startRoom({
			name: roomName(`existing-only-present-read-failure-${storage.name}`),
			agents: [
				defineAgent({
					name: 'watcher',
					identity: 'Watches the room.',
					instructions: 'Stay quiet.',
					model: 'scripted/watcher',
				}),
			],
			seats: {},
			runtime: createRuntime({ storage: journals }),
		});
		try {
			await room.visit(person);
			failSeat = true;
			const failedWrite = observed(room.seat('watcher'));
			await expect(failedWrite).rejects.toThrow(/disk is full/);
			const failedRead = observed(room.visit(person, { arrive: false }));
			await expect(failedRead).rejects.toThrow(/unreadable/);
			expect(unreadable.readFailures()).toBeGreaterThan(0);

			unreadable.fail(false);
			const existing = await room.visit(person, { arrive: false });
			expect(existing).toBeDefined();
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
			await existing?.leave();
		} finally {
			failSeat = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('keeps an ended handle invalid while explicit reentry retries its original keyed exchange', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`existing-only-key-retry-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			const first = await room.visit(person);
			const original = await first.send({ text: 'same question', key: 'existing-only-question' });
			await first.leave();
			await expect(
				first.send({ text: 'same question', key: 'existing-only-question' }),
			).rejects.toThrow(/ended|leaving/);
			await expect(room.visit(person, { arrive: false })).resolves.toBeUndefined();

			const fresh = await room.visit(person);
			const retry = await fresh.send({ text: 'same question', key: 'existing-only-question' });
			expect(retry.from).toBe(original.from);
			expect(retry.owner).toBe(original.owner);
			expect(
				(await room.messages()).filter(
					(message) => message.kind === 'said' && message.key === 'existing-only-question',
				),
			).toHaveLength(1);
			await fresh.leave();
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('shares existing-only reacquisition authority across handles', async () => {
		const opened = await storage.open();
		const name = roomName(`existing-only-shared-handle-${storage.name}`);
		const firstRuntime = createRuntime({ storage: opened.storage });
		const first = await startRoom({ name, runtime: firstRuntime });
		let room: Awaited<ReturnType<typeof startRoom>> | undefined;
		try {
			await first.visit(person);
			firstRuntime.evict(name);
			room = await resumeRoom(name, {
				agents: [],
				runtime: createRuntime({ storage: opened.storage }),
			});
			const [one, two] = await Promise.all([
				room.visit(person, { arrive: false }),
				room.visit(person, { arrive: false }),
			]);
			expect(one).toBeDefined();
			expect(two).toBeDefined();
			if (one === undefined || two === undefined) throw new Error('existing-only visit was absent');
			await one.leave();
			await expect(two.send({ text: 'after the shared leave' })).rejects.toThrow(/ended|leaving/);
			expect((await room.messages()).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
		} finally {
			await room?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('rejects an existing-only probe from an older host after a newer room resumes', async () => {
		const opened = await storage.open();
		const firstRuntime = createRuntime({ storage: opened.storage });
		const name = roomName(`existing-only-fenced-${storage.name}`);
		const first = await startRoom({ name, runtime: firstRuntime });
		let resumed: Awaited<ReturnType<typeof startRoom>> | undefined;
		try {
			await first.visit(person);
			const secondRuntime = createRuntime({ storage: opened.storage });
			resumed = await resumeRoom(name, { runtime: secondRuntime, agents: [] });
			const stale = observed(first.visit(person, { arrive: false }));
			await expect(stale).rejects.toThrow(/stopped|evicted|gone|superseded/);
			expect(await resumed.visit(person, { arrive: false })).toBeDefined();
		} finally {
			await resumed?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('rejects human visits that collide with an added reserved agent definition after resume', async () => {
		const opened = await storage.open();
		const name = roomName(`existing-only-agent-collision-${storage.name}`);
		const first = await startRoom({ name, runtime: createRuntime({ storage: opened.storage }) });
		let resumed: Awaited<ReturnType<typeof startRoom>> | undefined;
		try {
			await first.stop();
			const collision = defineAgent({
				name: person.name,
				identity: 'An executable seat.',
				instructions: 'Stay quiet.',
				model: 'scripted/collision',
			});
			resumed = await resumeRoom(name, {
				agents: [collision],
				runtime: createRuntime({ storage: opened.storage }),
			});
			const existingOnly = observed(resumed.visit(person, { arrive: false }));
			await expect(existingOnly).rejects.toThrow(/is an agent in this room/);
			const ordinary = observed(resumed.visit(person));
			await expect(ordinary).rejects.toThrow(/is an agent in this room/);
		} finally {
			await resumed?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});
});
