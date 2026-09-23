/**
 * A visit is idempotent: one person has one arrival and one handle, across
 * concurrent calls, a storage that fails to read or write, and a resume on
 * a new host.
 */
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
import { observed, openFor } from './support/core-failure.ts';
import { deferred, messagesOf, roomName, scriptedAgent } from './support/room.ts';
import { gatedJournals, type Storage, storages, tappedJournals } from './support/storage.ts';
import { stopAtEnd } from './support/stop.ts';

const person = defineHuman({ name: 'andrei', identity: 'Founder.' });
const returnedPerson = defineHuman({ name: 'andrei', identity: 'Founder, returned.' });

it('types visit as an idempotent definite handle', () => {
	const checkTypes = (room: Room) => {
		expectTypeOf(room.visit(person)).toEqualTypeOf<Promise<Visit>>();
	};
	expectTypeOf(checkTypes).returns.toBeVoid();
});

const count = async (room: Room, kind: 'arrived' | 'left') =>
	(await messagesOf(room)).filter((message) => message.kind === kind).length;

function bodyKind(entry: unknown): string | undefined {
	const body = (entry as { body?: { kind?: unknown } } | null)?.body;
	return typeof body?.kind === 'string' ? body.kind : undefined;
}

/** A storage whose reads fail while `fail(true)` holds. */
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
		readFailures: () => failures,
	};
}

/**
 * A room whose next message write fails at `phase` when `arm()` is called;
 * the failure also makes every read fail until `unreadable.fail(false)`.
 */
async function unreadableRoom(storage: Storage, phase: 'before' | 'after', options = {}) {
	const opened = await openFor(storage);
	const unreadable = unreadableOpener(opened.storage);
	let armed = false;
	let appended = false;
	const journals = tappedJournals(unreadable.storage, (_id, _n, at, kind) => {
		if (!armed || at !== phase || kind !== 'message') return;
		armed = false;
		appended = at === 'after';
		unreadable.fail(true);
		throw new Error('the disk is full');
	});
	const room = stopAtEnd(
		await startRoom({
			name: roomName(`visit-unreadable-${storage.name}`),
			runtime: createRuntime({ storage: journals }),
			...options,
		}),
	);
	return {
		room,
		unreadable,
		arm: () => {
			armed = true;
		},
		appended: () => appended,
	};
}

describe.each(storages)('idempotent visits on $name storage', (storage) => {
	it('shares concurrent same-identity visits and records one arrival', async () => {
		const opened = await openFor(storage);
		const started = deferred();
		const release = deferred();
		const journals = gatedJournals(opened.storage, async (kind, entry) => {
			if (kind !== 'message' || bodyKind(entry) !== 'arrived') return;
			started.resolve();
			await release.promise;
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`visit-idempotent-race-${storage.name}`),
				runtime: createRuntime({ storage: journals }),
			}),
		);
		const first = observed(room.visit(person));
		await started.promise;
		const second = observed(room.visit(person));
		const third = observed(room.visit(person));
		const settled = second.then(
			() => true,
			() => true,
		);
		const pending = new Promise<boolean>((resolve) => setImmediate(() => resolve(false)));
		expect(await Promise.race([settled, pending])).toBe(false);
		release.resolve();
		for (const visit of await Promise.all([first, second, third])) {
			expect(visit.human).toEqual(person);
		}
		expect(await count(room, 'arrived')).toBe(1);

		await expect(observed(room.visit(returnedPerson))).rejects.toThrow(/different identity/);
		expect(await count(room, 'arrived')).toBe(1);
		await (await first).leave();
	});

	it('rejects a cached visit while recovery reads are unavailable, then reuses it after healing', async () => {
		const { room, unreadable, arm } = await unreadableRoom(storage, 'before', {
			agents: [scriptedAgent('watcher', 'Watches the room.', { tools: [] })],
			seats: {},
		});
		const first = await room.visit(person);
		arm();
		await expect(observed(room.seat('watcher'))).rejects.toThrow(/disk is full/);
		await expect(observed(room.visit(person))).rejects.toThrow(/unreadable/);
		expect(unreadable.readFailures()).toBeGreaterThan(0);

		unreadable.fail(false);
		const existing = await room.visit(person);
		expect(existing.human).toEqual(first.human);
		expect(await count(room, 'arrived')).toBe(1);
		await existing.leave();
	});

	it('fences an older host before it can reuse a visit after resume, and shares the resumed visit across concurrent handles', async () => {
		const opened = await openFor(storage);
		const name = roomName(`visit-fenced-${storage.name}`);
		const first = stopAtEnd(
			await startRoom({ name, runtime: createRuntime({ storage: opened.storage }) }),
		);
		await first.visit(person);
		const resumed = stopAtEnd(
			await resumeRoom(name, { agents: [], runtime: createRuntime({ storage: opened.storage }) }),
		);
		await expect(observed(first.visit(person))).rejects.toThrow(/stopped|evicted|gone|superseded/);
		const [one, two] = await Promise.all([resumed.visit(person), resumed.visit(person)]);
		expect(one.human).toEqual(person);
		await one.leave();
		await expect(two.send({ text: 'after the shared leave' })).rejects.toThrow(/ended|leaving/);
		expect(await count(resumed, 'arrived')).toBe(1);
	});

	it('recovers an uncertain departure before recording one explicit reentry', async () => {
		const { room, unreadable, arm, appended } = await unreadableRoom(storage, 'after');
		const old = await room.visit(person);
		arm();
		await expect(observed(old.leave())).rejects.toThrow(/disk is full/);
		await observed(messagesOf(room)).catch(() => {});
		expect(appended()).toBe(true);
		expect(unreadable.readFailures()).toBeGreaterThan(0);

		unreadable.fail(false);
		const fresh = await room.visit(person);
		expect(fresh).not.toBe(old);
		expect(await count(room, 'left')).toBe(1);
		expect(await count(room, 'arrived')).toBe(2);
		await expect(old.send({ text: 'old handle is ended' })).rejects.toThrow(/ended|leaving/);
		await fresh.leave();
	});

	it('keeps an ended handle invalid while keyed retry reuses the original exchange after reentry', async () => {
		const opened = await openFor(storage);
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`visit-key-retry-${storage.name}`),
				runtime: createRuntime({ storage: opened.storage }),
			}),
		);
		const question = { text: 'same question', key: 'visit-question' };
		const old = await room.visit(person);
		const original = await old.send(question);
		await old.leave();
		await expect(old.send(question)).rejects.toThrow(/ended|leaving/);

		const fresh = await room.visit(person);
		const retry = await fresh.send(question);
		expect(fresh).not.toBe(old);
		expect(retry.from).toBe(original.from);
		expect(retry.owner).toBe(original.owner);
		expect(
			(await messagesOf(room)).filter(
				(message) => message.kind === 'said' && message.key === question.key,
			),
		).toHaveLength(1);
		expect(await count(room, 'arrived')).toBe(2);
		await fresh.leave();
	});
});
