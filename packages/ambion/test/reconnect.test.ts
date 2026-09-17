/**
 * A host can reconnect a person after a process loss, then follow the same
 * exchange by its opening message and retry a delivery by its durable key.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	type Room,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { deferred, messagesOf, participantsOf, roomName, waitForRoom } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { gatedJournals, storages } from './support/storage.ts';

const watcher = defineAgent({
	name: 'watcher',
	identity: 'Records room activity.',
	instructions: 'Stay quiet.',
	model: 'scripted/watcher',
});

const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});

const alternatePriya = defineHuman({
	name: priya.name,
	identity: 'A different person.',
});

function started(room: Room, agent: string): Promise<void> {
	return new Promise((resolve) => {
		const off = room.subscribe((event) => {
			if (event.type !== 'activation_start' || event.agent !== agent) return;
			off();
			resolve();
		});
	});
}

describe.each(storages)('human reconnect on $name storage', (storage) => {
	it('keeps recorded presence through eviction, then leaves only when the host says so', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const runtime = createRuntime({ clock, storage: opened.storage });
		const name = roomName(`reconnect-presence-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [watcher],
			seats: { [watcher.name]: 'none' },
			runtime,
			streamFn: scripted(() => quiet()),
		});
		try {
			await first.visit(priya);
			const before = await messagesOf(first);
			expect(before).toHaveLength(1);
			expect(before[0]).toMatchObject({
				kind: 'arrived',
				from: priya.name,
				subject: priya.name,
				identity: priya.identity,
				preferences: priya.preferences,
			});

			runtime.evict(name);
			const resumed = await resumeRoom(name, {
				agents: [watcher],
				runtime: createRuntime({ clock, storage: opened.storage }),
				streamFn: scripted(() => quiet()),
			});
			try {
				expect(
					(await messagesOf(resumed)).filter((message) => message.kind === 'arrived'),
				).toHaveLength(1);
				expect(await participantsOf(resumed)).toContainEqual({
					kind: 'human',
					name: priya.name,
					identity: priya.identity,
					presence: 'present',
				});
				await expect(resumed.visit(alternatePriya)).rejects.toThrow(/different identity/);

				const reconnected = await resumed.visit(priya);
				const secondHandle = await resumed.visit(priya);
				expect(reconnected.since).toBeUndefined();
				expect(secondHandle.human).toEqual(priya);
				expect(
					(await messagesOf(resumed)).filter((message) => message.kind === 'arrived'),
				).toHaveLength(1);

				await reconnected.leave();
				expect((await messagesOf(resumed)).map((message) => message.kind)).toEqual([
					'arrived',
					'left',
				]);
				expect(await participantsOf(resumed)).toContainEqual({
					kind: 'human',
					name: priya.name,
					identity: priya.identity,
					presence: 'absent',
				});
			} finally {
				await resumed.stop();
			}
		} finally {
			await opened.dispose();
		}
	});

	it('persists the visit cursor and reacquires a keyed delivery in its original exchange', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const runtime = createRuntime({ clock, storage: opened.storage });
		const name = roomName(`reconnect-delivery-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [],
			runtime,
			streamFn: scripted(() => quiet()),
		});
		try {
			const visit = await first.visit(priya);
			const sent = await visit.send({ text: 'Can I promise Thursday?', key: 'promise-1' });
			const conversation = await sent.waitForClose();
			await visit.leave();
			const left = (await messagesOf(first)).find((message) => message.kind === 'left');
			expect(left).toBeDefined();
			expect(visit.since).toBe(left?.seq);

			runtime.evict(name);
			const resumed = await resumeRoom(name, {
				agents: [],
				runtime: createRuntime({ clock, storage: opened.storage }),
				streamFn: scripted(() => quiet()),
			});
			try {
				const reconnected = await resumed.visit(priya);
				expect(reconnected.since).toBe(left?.seq);
				const missed = await messagesOf(resumed, { since: reconnected.since });
				expect(missed.map((message) => message.kind)).toEqual(['arrived']);

				const retry = await reconnected.send({
					text: 'Can I promise Thursday?',
					key: 'promise-1',
				});
				expect(retry.from).toBe(sent.from);
				expect(await retry.waitForClose()).toEqual(conversation);
				expect(
					(await messagesOf(resumed)).filter((message) => message.key === 'promise-1'),
				).toHaveLength(1);
				expect(reconnected.since).toBe(left?.seq);
			} finally {
				await resumed.stop();
			}
		} finally {
			await opened.dispose();
		}
	});

	it('merges history and live notifications once by message sequence', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const gate = deferred();
		const entered = deferred();
		let holding = true;
		const journals = gatedJournals(opened.storage, (kind) => {
			if (holding && kind === 'message') {
				entered.resolve();
				return gate.promise;
			}
			return undefined;
		});
		const runtime = createRuntime({ clock, storage: journals });
		const name = roomName(`reconnect-overlap-${storage.name}`);
		const room = await startRoom({ name, agents: [], runtime });
		try {
			const live: Message[] = [];
			const off = room.subscribe((event) => {
				if (event.type === 'message') live.push(event.message);
			});
			const arriving = room.visit(priya);
			await entered.promise;
			const replay = messagesOf(room, { since: 0 });
			holding = false;
			gate.resolve();
			const [visit, history] = await Promise.all([arriving, replay]);
			off();

			const merged = new Map<number, Message>();
			for (const message of history) merged.set(message.seq, message);
			for (const message of live) merged.set(message.seq, message);
			expect(history).toHaveLength(1);
			expect(live).toHaveLength(1);
			expect(live[0]?.seq).toBe(history[0]?.seq);
			expect([...merged.values()]).toHaveLength(1);
			expect(merged.get(history[0]?.seq ?? -1)).toMatchObject({
				kind: 'arrived',
				from: priya.name,
			});
			await visit.leave();
		} finally {
			holding = false;
			gate.resolve();
			await room.stop();
			await opened.dispose();
		}
	});
});

describe.each(storages)('exchange waiters across host lifecycle on $name storage', (storage) => {
	it.each(['eviction', 'supersession', 'stop'] as const)(
		'rejects the old waits after %s and completes the reacquired handle',
		async (lifecycle) => {
			const opened = await storage.open();
			const clock = fakeClock();
			const held = deferred();
			const firstRuntime = createRuntime({
				clock,
				storage: opened.storage,
				wake: { expiry: 60_000, resend: 5_000 },
			});
			const name = roomName(`reconnect-wait-${storage.name}-${lifecycle}`);
			const first = await startRoom({
				name,
				agents: [watcher],
				seats: { [watcher.name]: 'broadcast' },
				runtime: firstRuntime,
				streamFn: scripted(async (_context, _agent, call) => {
					if (call === 1) await held.promise;
					return quiet();
				}),
			});
			let resumed: Room | undefined;
			try {
				const visit = await first.visit(priya);
				const wakeStarted = started(first, watcher.name);
				const exchange = await visit.send({ text: 'Hold this question.', key: `${lifecycle}-1` });
				await wakeStarted;
				const messages = exchange.waitForClose();
				const response = exchange.waitForSummary();

				if (lifecycle === 'stop') {
					await first.stop();
				} else if (lifecycle === 'eviction') {
					firstRuntime.evict(name);
				} else {
					const secondRuntime = createRuntime({
						clock,
						storage: opened.storage,
						wake: { expiry: 60_000, resend: 5_000 },
					});
					resumed = await resumeRoom(name, {
						agents: [watcher],
						runtime: secondRuntime,
						streamFn: scripted(() => quiet()),
					});
					await expect(visit.leave()).rejects.toThrow(/superseded|stopped/i);
				}

				await expect(messages).rejects.toThrow(/stopped|interrupted|evicted/i);
				await expect(response).rejects.toThrow(/stopped|interrupted|evicted/i);
				held.resolve();

				if (resumed === undefined) {
					resumed = await resumeRoom(name, {
						agents: [watcher],
						runtime: createRuntime({
							clock,
							storage: opened.storage,
							wake: { expiry: 60_000, resend: 5_000 },
						}),
						streamFn: scripted(() => quiet()),
					});
				}
				const recovered = resumed.exchange(exchange.from);
				expect(recovered).toBeDefined();
				await clock.advance(60_000);
				await clock.advance(30_000);
				await waitForRoom(resumed);
				expect(await recovered?.waitForClose()).toEqual(expect.any(Array));
				expect((await messagesOf(resumed)).filter(isSpoken)).toHaveLength(1);
			} finally {
				held.resolve();
				await resumed?.stop();
				await opened.dispose();
			}
		},
	);
});

describe.each(storages)('planned room shutdown on $name storage', (storage) => {
	it('records departure on stop while eviction leaves the person present', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		try {
			const crashRuntime = createRuntime({ clock, storage: opened.storage });
			const crashName = roomName(`reconnect-stop-crash-${storage.name}`);
			const crashed = await startRoom({ name: crashName, agents: [], runtime: crashRuntime });
			await crashed.visit(priya);
			crashRuntime.evict(crashName);
			expect(
				(await readRoom(crashName, { runtime: createRuntime({ clock, storage: opened.storage }) }))
					.participants,
			).toContainEqual(expect.objectContaining({ name: priya.name, presence: 'present' }));

			const stopRuntime = createRuntime({ clock, storage: opened.storage });
			const stopName = roomName(`reconnect-stop-planned-${storage.name}`);
			const planned = await startRoom({ name: stopName, agents: [], runtime: stopRuntime });
			await planned.visit(priya);
			await planned.stop();
			expect(
				(await readRoom(stopName, { runtime: stopRuntime })).messages.map(
					(message) => message.kind,
				),
			).toEqual(['arrived', 'left']);
		} finally {
			await opened.dispose();
		}
	});
});
