/**
 * A host can reconnect a person after a process loss, then follow the same
 * exchange by its opening message and retry a delivery by its durable key.
 * The person stays present and holds their identity until they leave.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { hostingOf } from '../src/hosting.ts';
import {
	createRuntime,
	defineHuman,
	isSpoken,
	type Message,
	type Room,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import {
	deferred,
	messagesOf,
	participantsOf,
	roomName,
	scriptedAgent,
	waitForRoom,
} from './support/room.ts';
import { quiet, type Script, scripted } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { gatedJournals, type Storage, storages } from './support/storage.ts';

const watcher = scriptedAgent('watcher', 'Records room activity.');
const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});
const alternatePriya = defineHuman({ name: priya.name, identity: 'A different person.' });
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });
const execution = piExecution({ stream: scripted(() => quiet()) });

/** A storage and a clock that stay open until the test ends. */
async function host(storage: Storage) {
	const opened = await storage.open();
	onTestFinished(() => opened.dispose());
	const clock = fakeClock();
	return { opened, clock, runtime: () => createRuntime({ clock, storage: opened.storage }) };
}

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
	it('keeps recorded presence and identity through eviction, then frees them only on leave', async () => {
		const { runtime: fresh } = await host(storage);
		const runtime = fresh();
		const name = roomName(`reconnect-presence-${storage.name}`);
		const first = await startRoom({
			name,
			agents: [watcher],
			seats: { [watcher.name]: 'none' },
			runtime,
			execution,
		});
		await first.visit(priya);
		await first.visit(sam);
		const before = await messagesOf(first);
		expect(before.map((message) => message.kind)).toEqual(['arrived', 'arrived']);
		expect(before[0]).toMatchObject({
			kind: 'arrived',
			from: priya.name,
			subject: priya.name,
			identity: priya.identity,
			preferences: priya.preferences,
		});

		// no `left` was written, so both are still present, and a visit writes nothing
		hostingOf(runtime).evict(name);
		const resumed = stopAtEnd(
			await resumeRoom(name, {
				agents: [watcher],
				runtime: fresh(),
				execution,
			}),
		);
		const humans = async () =>
			(await participantsOf(resumed)).filter((participant) => participant.kind === 'human');
		expect(await humans()).toEqual([
			{ kind: 'human', name: priya.name, identity: priya.identity, presence: 'present' },
			{ kind: 'human', name: sam.name, identity: sam.identity, presence: 'present' },
		]);
		await expect(resumed.visit(alternatePriya)).rejects.toThrow(/different identity/);
		const reconnected = await resumed.visit(priya);
		const secondHandle = await resumed.visit(priya);
		expect(reconnected.lastDeparture).toBeUndefined();
		expect(secondHandle.human).toEqual(priya);
		expect((await messagesOf(resumed)).map((message) => message.kind)).toEqual([
			'arrived',
			'arrived',
		]);

		await reconnected.leave();
		expect(await humans()).toContainEqual({
			kind: 'human',
			name: priya.name,
			identity: priya.identity,
			presence: 'absent',
		});
		const back = await resumed.visit(alternatePriya);
		expect(back.human.identity).toBe(alternatePriya.identity);
		expect((await messagesOf(resumed)).map((message) => message.kind)).toEqual([
			'arrived',
			'arrived',
			'left',
			'arrived',
		]);
		expect(await humans()).toContainEqual(
			expect.objectContaining({ name: priya.name, identity: alternatePriya.identity }),
		);
	});

	it('persists the visit cursor and reacquires a keyed delivery in its original exchange', async () => {
		const { runtime: fresh } = await host(storage);
		const runtime = fresh();
		const name = roomName(`reconnect-delivery-${storage.name}`);
		const first = await startRoom({ name, agents: [], runtime, execution });
		const visit = await first.visit(priya);
		const sent = await visit.send({ text: 'Can I promise Thursday?', key: 'promise-1' });
		const conversation = await sent.waitForClose();
		await visit.leave();
		const left = (await messagesOf(first)).find((message) => message.kind === 'left');
		expect(left).toBeDefined();
		expect(visit.lastDeparture).toBe(left?.seq);

		hostingOf(runtime).evict(name);
		const resumed = stopAtEnd(await resumeRoom(name, { agents: [], runtime: fresh(), execution }));
		const reconnected = await resumed.visit(priya);
		expect(reconnected.lastDeparture).toBe(left?.seq);
		const missed = await messagesOf(resumed, { since: reconnected.lastDeparture });
		expect(missed.map((message) => message.kind)).toEqual(['arrived']);

		const retry = await reconnected.send({ text: 'Can I promise Thursday?', key: 'promise-1' });
		expect(retry.from).toBe(sent.from);
		expect(await retry.waitForClose()).toEqual(conversation);
		expect(
			(await messagesOf(resumed)).filter((message) => message.key === 'promise-1'),
		).toHaveLength(1);
		expect(reconnected.lastDeparture).toBe(left?.seq);
	});

	it('merges history and live notifications once by message sequence', async () => {
		const { opened, clock } = await host(storage);
		const gate = deferred();
		const entered = deferred();
		onTestFinished(gate.resolve);
		const journals = gatedJournals(opened.storage, (kind) => {
			if (kind !== 'message') return undefined;
			entered.resolve();
			return gate.promise;
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName(`reconnect-overlap-${storage.name}`),
				agents: [],
				runtime: createRuntime({ clock, storage: journals }),
			}),
		);
		const live: Message[] = [];
		const off = room.subscribe((event) => {
			if (event.type === 'message') live.push(event.message);
		});
		const arriving = room.visit(priya);
		await entered.promise;
		const replay = messagesOf(room, { since: 0 });
		gate.resolve();
		const [visit, history] = await Promise.all([arriving, replay]);
		off();

		const merged = new Map<number, Message>();
		for (const message of [...history, ...live]) merged.set(message.seq, message);
		expect(history).toHaveLength(1);
		expect(live).toHaveLength(1);
		expect(live[0]?.seq).toBe(history[0]?.seq);
		expect([...merged.values()]).toHaveLength(1);
		expect(merged.get(history[0]?.seq ?? -1)).toMatchObject({ kind: 'arrived', from: priya.name });
		await visit.leave();
	});
});

describe.each(storages)('exchange waiters across host lifecycle on $name storage', (storage) => {
	it.each(['eviction', 'supersession', 'stop'] as const)(
		'rejects the old waits after %s and completes the reacquired handle',
		async (lifecycle) => {
			const { clock, runtime } = await host(storage);
			const held = deferred();
			onTestFinished(held.resolve);
			const holds: Script = async (_context, _agent, call) => {
				if (call === 1) await held.promise;
				return quiet();
			};
			const firstRuntime = runtime();
			const name = roomName(`reconnect-wait-${storage.name}-${lifecycle}`);
			const first = await startRoom({
				name,
				agents: [watcher],
				seats: { [watcher.name]: 'broadcast' },
				runtime: firstRuntime,
				execution: piExecution({ stream: scripted(holds) }),
			});
			const visit = await first.visit(priya);
			const wakeStarted = started(first, watcher.name);
			const exchange = await visit.send({ text: 'Hold this question.', key: `${lifecycle}-1` });
			await wakeStarted;
			const messages = exchange.waitForClose();
			const response = exchange.waitForSummary();

			const resume = async () =>
				stopAtEnd(await resumeRoom(name, { agents: [watcher], runtime: runtime(), execution }));
			let resumed: Room | undefined;
			if (lifecycle === 'stop') await first.stop();
			else if (lifecycle === 'eviction') hostingOf(firstRuntime).evict(name);
			else {
				resumed = await resume();
				await expect(visit.leave()).rejects.toThrow(/superseded|stopped/i);
			}

			await expect(messages).rejects.toThrow(/stopped|interrupted|evicted/i);
			await expect(response).rejects.toThrow(/stopped|interrupted|evicted/i);
			held.resolve();

			resumed ??= await resume();
			const recovered = resumed.exchange(exchange.from);
			expect(recovered).toBeDefined();
			await clock.advance(60_000);
			await clock.advance(30_000);
			await waitForRoom(resumed);
			expect(await recovered?.waitForClose()).toEqual(expect.any(Array));
			expect((await messagesOf(resumed)).filter(isSpoken)).toHaveLength(1);
		},
	);
});
