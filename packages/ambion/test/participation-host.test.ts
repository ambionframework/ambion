import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { type Runtime, runningRoom } from '../src/host/runtime.ts';
import { createRuntime, defineAgent, defineHuman, resumeRoom, startRoom } from '../src/index.ts';
import type { Intent } from '../src/protocol.ts';
import { fakeClock } from '../src/testing.ts';
import { crash, messagesOf, roomName, stateOf } from './support/room.ts';
import { storages } from './support/storage.ts';

const agent = (name: string) =>
	defineAgent({
		name,
		identity: name,
		executor: pi({ instructions: 'Collaborate.', model: `scripted/${name}` }),
	});
const alpha = agent('alpha');
const beta = agent('beta');
const reserve = agent('reserve');
const person = defineHuman({ name: 'priya', identity: 'Asks.' });

function protocol(runtime: Runtime, name: string) {
	const peer = runningRoom(runtime, name);
	if (peer === undefined) throw new Error('The room is absent.');
	return peer;
}

const transport = (cuts: string[]) => ({
	connect: () => ({
		wake: async () => {},
		steer: async () => {},
		cut: async (id: string) => {
			cuts.push(id);
		},
	}),
});

describe.each(storages)('ordinary membership on $name', (storage) => {
	it('commits membership once, preserves acknowledgement, and fences a removed activation after reseating', async () => {
		const opened = await storage.open();
		const cuts: string[] = [];
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: transport(cuts),
		});
		const room = await startRoom({
			name: roomName('membership'),
			agents: [alpha, beta, reserve],
			seats: { alpha: 'broadcast', beta: 'broadcast' },
			runtime,
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Work together.' });
			const peer = protocol(runtime, room.name);
			const first = `message:${exchange.from}:alpha:1`;
			const second = `message:${exchange.from}:beta:1`;
			expect(await peer.lease({ operation: 'claim', activation: first })).toHaveProperty('ok');
			expect(await peer.lease({ operation: 'claim', activation: second })).toHaveProperty('ok');
			const commit = (activation: string, intent: Intent) =>
				peer.commit({ activation, key: crypto.randomUUID(), intent });
			expect(await commit(first, { kind: 'seated', name: 'reserve' })).toHaveProperty('committed');
			const before = await messagesOf(room);
			expect(await commit(second, { kind: 'seated', name: 'reserve' })).toEqual({
				unchanged: { kind: 'seated', name: 'reserve' },
			});
			expect(await messagesOf(room)).toEqual(before);
			expect(stateOf(room).leases.get(second)?.readThrough).toBe(0);
			expect(await commit(first, { kind: 'unseated', name: 'priya' })).toHaveProperty('refused');
			expect(await commit(first, { kind: 'seated', name: 'unknown' })).toHaveProperty('refused');
			expect(await commit(first, { kind: 'unseated', name: 'beta' })).toHaveProperty('committed');
			await room.seat('beta');
			expect(await peer.lease({ operation: 'renew', activation: second })).toHaveProperty('stale');
			const late = await commit(second, { kind: 'seated', name: 'reserve' });
			expect('stale' in late || 'refused' in late).toBe(true);
			await room.reconcile();
			expect(cuts).toContain(second);
			expect(await commit(first, { kind: 'unseated', name: 'alpha' })).toHaveProperty('committed');
			expect(await commit(first, { kind: 'seated', name: 'alpha' })).toHaveProperty('stale');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('settles an unclaimed closing assignment when the host removes its writer, across replay', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const runtime = createRuntime({ storage: opened.storage, clock, transport: transport([]) });
		const room = await startRoom({
			name: roomName('removed-summary'),
			agents: [alpha, beta],
			summary: 'alpha',
			seats: { alpha: 'none', beta: 'broadcast' },
			runtime,
		});
		let resumed: Awaited<ReturnType<typeof resumeRoom>> | undefined;
		try {
			const peer = protocol(runtime, room.name);
			const visit = await room.visit(person);
			const first = await visit.send({ text: 'First question.' });
			const betaFirst = `message:${first.from}:beta:1`;
			await peer.lease({ operation: 'claim', activation: betaFirst });
			await peer.lease({
				operation: 'release',
				activation: betaFirst,
				reason: 'released',
				readThrough: stateOf(room).lastSeq,
			});
			await room.reconcile();
			await first.waitForClose();
			const closing = stateOf(room).due.find((work) => work.seat === 'alpha');
			expect(closing?.source).toBe('closed');
			const second = await visit.send({ text: 'Remove the writer.' });
			const betaSecond = `message:${second.from}:beta:1`;
			await peer.lease({ operation: 'claim', activation: betaSecond });
			await room.unseat('alpha');
			await expect(first.waitForSummary()).rejects.toThrow(/interrupted/);
			await room.seat('alpha', { attention: 'none' });
			if (closing === undefined) throw new Error('Expected closing assignment.');
			expect(await peer.lease({ operation: 'claim', activation: closing.id })).toHaveProperty(
				'stale',
			);
			crash(runtime, room);
			resumed = await resumeRoom(room.name, {
				agents: [alpha, beta],
				runtime: createRuntime({ storage: opened.storage, clock, transport: transport([]) }),
			});
			await expect(resumed.exchange(first.from)?.waitForSummary()).rejects.toThrow(/interrupted/);
			expect(stateOf(resumed).due.some((work) => work.id === closing.id)).toBe(false);
		} finally {
			await resumed?.stop();
			await room.stop();
			await opened.dispose();
		}
	});
});
