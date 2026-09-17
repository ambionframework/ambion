import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	createRuntime,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
	type Visit,
} from '../src/index.ts';
import { messagesOf, roomName } from './support/room.ts';
import { gatedJournals, storages, tappedJournals } from './support/storage.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const returnedPerson = defineHuman({ name: 'andrei', identity: 'Founder, returned.' });

it('types visit as an idempotent definite handle', () => {
	const checkTypes = (room: Room) => {
		expectTypeOf(room.visit(person)).toEqualTypeOf<Promise<Visit>>();
	};
	expectTypeOf(checkTypes).returns.toBeVoid();
});

function observed<T>(promise: Promise<T>): Promise<T> {
	void promise.catch(() => {});
	return promise;
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

describe.each(storages)('idempotent visits on $name storage', (storage) => {
	it('shares concurrent same-identity visits and records one arrival', async () => {
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
			name: roomName(`visit-idempotent-race-${storage.name}`),
			runtime: createRuntime({ storage: journals }),
		});
		try {
			const first = observed(room.visit(person));
			await started;
			const second = observed(room.visit(person));
			const third = observed(room.visit(person));
			expect(
				await Promise.race([
					second.then(
						() => true,
						() => true,
					),
					new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
				]),
			).toBe(false);
			releaseArrival();
			const [one, two, three] = await Promise.all([first, second, third]);
			expect(one.human).toEqual(person);
			expect(two.human).toEqual(person);
			expect(three.human).toEqual(person);
			expect((await messagesOf(room)).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);

			const mismatch = observed(room.visit(returnedPerson));
			await expect(mismatch).rejects.toThrow(/different identity/);
			expect((await messagesOf(room)).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
			await one.leave();
		} finally {
			releaseArrival();
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('rejects a cached visit while recovery reads are unavailable, then reuses it after healing', async () => {
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
			name: roomName(`visit-present-read-failure-${storage.name}`),
			agents: [
				{
					name: 'watcher',
					identity: 'Watches the room.',
					instructions: 'Stay quiet.',
					model: 'scripted/watcher',
					tools: [],
				},
			],
			seats: {},
			runtime: createRuntime({ storage: journals }),
		});
		try {
			const first = await room.visit(person);
			failSeat = true;
			const failedWrite = observed(room.seat('watcher'));
			await expect(failedWrite).rejects.toThrow(/disk is full/);
			const failedRead = observed(room.visit(person));
			await expect(failedRead).rejects.toThrow(/unreadable/);
			expect(unreadable.readFailures()).toBeGreaterThan(0);

			unreadable.fail(false);
			const existing = await room.visit(person);
			expect(existing.human).toEqual(first.human);
			expect((await messagesOf(room)).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
			await existing.leave();
		} finally {
			failSeat = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('fences an older host before it can reuse a visit after resume', async () => {
		const opened = await storage.open();
		const firstRuntime = createRuntime({ storage: opened.storage });
		const name = roomName(`visit-fenced-${storage.name}`);
		const first = await startRoom({ name, runtime: firstRuntime });
		let resumed: Awaited<ReturnType<typeof startRoom>> | undefined;
		try {
			await first.visit(person);
			resumed = await resumeRoom(name, {
				agents: [],
				runtime: createRuntime({ storage: opened.storage }),
			});
			const stale = observed(first.visit(person));
			await expect(stale).rejects.toThrow(/stopped|evicted|gone|superseded/);
			expect((await resumed.visit(person)).human).toEqual(person);
			expect(
				(await messagesOf(resumed)).filter((message) => message.kind === 'arrived'),
			).toHaveLength(1);
		} finally {
			await resumed?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('shares resumed visit authority across concurrent reacquisition handles', async () => {
		const opened = await storage.open();
		const name = roomName(`visit-shared-handle-${storage.name}`);
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
			const [one, two] = await Promise.all([room.visit(person), room.visit(person)]);
			await one.leave();
			await expect(two.send({ text: 'after the shared leave' })).rejects.toThrow(/ended|leaving/);
			expect((await messagesOf(room)).filter((message) => message.kind === 'arrived')).toHaveLength(
				1,
			);
		} finally {
			await room?.stop().catch(() => {});
			await first.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('recovers an uncertain departure before recording one explicit reentry', async () => {
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
			name: roomName(`visit-departure-recovery-${storage.name}`),
			runtime: createRuntime({ storage: journals }),
		});
		try {
			const old = await room.visit(person);
			failDeparture = true;
			const departure = observed(old.leave());
			await expect(departure).rejects.toThrow(/disk is full/);
			const failedRead = observed(messagesOf(room));
			await failedRead.catch(() => {});
			expect(appended).toBe(true);
			expect(unreadable.readFailures()).toBeGreaterThan(0);

			unreadable.fail(false);
			const fresh = await room.visit(person);
			expect(fresh).not.toBe(old);
			expect((await messagesOf(room)).filter((message) => message.kind === 'left')).toHaveLength(1);
			expect((await messagesOf(room)).filter((message) => message.kind === 'arrived')).toHaveLength(
				2,
			);
			await expect(old.send({ text: 'old handle is ended' })).rejects.toThrow(/ended|leaving/);
			await fresh.leave();
		} finally {
			failDeparture = false;
			unreadable.fail(false);
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});

	it('keeps an ended handle invalid while keyed retry reuses the original exchange after reentry', async () => {
		const opened = await storage.open();
		const room = await startRoom({
			name: roomName(`visit-key-retry-${storage.name}`),
			runtime: createRuntime({ storage: opened.storage }),
		});
		try {
			const old = await room.visit(person);
			const original = await old.send({ text: 'same question', key: 'visit-question' });
			await old.leave();
			await expect(old.send({ text: 'same question', key: 'visit-question' })).rejects.toThrow(
				/ended|leaving/,
			);

			const fresh = await room.visit(person);
			const retry = await fresh.send({ text: 'same question', key: 'visit-question' });
			expect(fresh).not.toBe(old);
			expect(retry.from).toBe(original.from);
			expect(retry.owner).toBe(original.owner);
			expect(
				(await messagesOf(room)).filter(
					(message) => message.kind === 'said' && message.key === 'visit-question',
				),
			).toHaveLength(1);
			expect((await messagesOf(room)).filter((message) => message.kind === 'arrived')).toHaveLength(
				2,
			);
			await fresh.leave();
		} finally {
			await room.stop().catch(() => {});
			await opened.dispose();
		}
	});
});
