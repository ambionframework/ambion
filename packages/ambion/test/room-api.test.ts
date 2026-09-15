import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { inProcessTransport } from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { deferred, roomName, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted, speak, summarise, toolNames } from './support/scripted.ts';
import { memory, type OpenedStorage, storages } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes one summary for each exchange.',
	instructions: 'Write one summary when the room closes an exchange.',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers questions.',
	instructions: 'Answer each question once.',
	model: 'scripted/alpha',
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Checks answers.',
	instructions: 'Answer each question once.',
	model: 'scripted/beta',
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

const answer = scripted((_context, _agent, call) => (call === 2 ? speak('The answer.') : quiet()));
const withSummary = () => {
	const answers = new Map<string, number>();
	const summarised = new Set<string>();
	return scripted((context, agent) => {
		if (agent === 'assistant') {
			if (toolNames(context).includes('summarise') && !summarised.has(agent)) {
				summarised.add(agent);
				return summarise('The result.');
			}
			return quiet();
		}
		const count = answers.get(agent) ?? 0;
		if (contextText(context).includes('Can we ship?') && count < 2) {
			answers.set(agent, count + 1);
			return speak('The answer.');
		}
		return quiet();
	});
};

interface World {
	readonly opened: OpenedStorage;
	readonly runtime: Runtime;
	readonly room: Room;
}

async function world(
	storage: (typeof storages)[number],
	options: Omit<Parameters<typeof startRoom>[0], 'name' | 'runtime'> = {},
): Promise<World> {
	const opened = await storage.open();
	const runtime = createRuntime({
		storage: opened.storage,
		clock: fakeClock(),
		transport: inProcessTransport(),
	});
	const room = await startRoom({
		name: roomName('room-api'),
		runtime,
		agents: [alpha],
		streamFn: answer,
		...options,
	});
	return { opened, runtime, room };
}

describe('the room API', () => {
	it('opens ready, returns an exchange handle, and reads a durable snapshot', async () => {
		const { opened, runtime, room } = await world(memory, {
			assistant,
			agents: [alpha, beta],
			streamFn: withSummary(),
		});
		try {
			const visit = await room.visit(priya);
			await waitForRoom(room);
			const exchange = await visit.send({ text: 'Can we ship?', key: 'ship-1' });

			expect(exchange.owner).toBe(priya.name);
			const close = await exchange.waitForClose();
			const beforeStop = await room.messages();
			expect(beforeStop.filter(isSpoken).length).toBeGreaterThanOrEqual(3);
			const response = await exchange.response();
			expect(response).toMatchObject({ kind: 'summary', to: priya.name });
			expect(close).toMatchObject({ owner: priya.name, from: exchange.from });

			await room.stop();
			expect(await exchange.response()).toMatchObject({
				kind: 'summary',
				to: priya.name,
				covers: { from: close.from, through: close.through },
			});
			expect(await exchange.response()).toEqual(response);
			const snapshot = await readRoom(room.name, { runtime });
			expect(snapshot.name).toBe(room.name);
			expect(snapshot.exchange).toBeUndefined();
			expect(snapshot.messages.filter(isSpoken).map((message) => message.key)).toContain('ship-1');
			expect(snapshot.messages.some(isSummary)).toBe(true);
		} finally {
			await opened.dispose();
		}
	});

	it('returns no response when the room has no assistant', async () => {
		const { opened, room } = await world(memory);
		try {
			const exchange = await (await room.visit(priya)).send({ text: 'Question?', key: 'none-1' });
			await expect(exchange.waitForClose()).resolves.toMatchObject({ owner: priya.name });
			await expect(exchange.response()).resolves.toBeUndefined();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('resolves a pending response as undefined when no summary is claimed', async () => {
		const { opened, room } = await world(memory, {
			assistant,
			streamFn: scripted((_context, agent, call) =>
				agent === 'assistant' ? quiet() : call === 2 ? speak('One answer.') : quiet(),
			),
		});
		try {
			const exchange = await (
				await room.visit(priya)
			).send({ text: 'One answer?', key: 'silent-1' });
			await exchange.waitForClose();
			await expect(exchange.response()).resolves.toBeUndefined();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('maps a send to its final close when a newer message arrives before close commit', async () => {
		const gate = deferred();
		const { opened, room } = await world(memory, {
			streamFn: scripted(async (_context, _agent, call) => {
				if (call !== 2) return quiet();
				await gate.promise;
				return quiet();
			}),
		});
		try {
			const first = await (await room.visit(priya)).send({ text: 'First?', key: 'race-1' });
			const second = await (await room.visit(sam)).send({ text: 'Second?', key: 'race-2' });
			gate.resolve();
			const close = await first.waitForClose();
			const secondMessage = (await room.messages()).find((message) => message.key === 'race-2');

			expect(close.from).toBe(first.from);
			expect(second.from).toBe(first.from);
			expect(secondMessage).toBeDefined();
			expect(close.through).toBeGreaterThanOrEqual(secondMessage?.seq ?? 0);
			expect(room.exchange(first.from)).toBeDefined();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('retries a delivery into its original exchange after a later exchange closes', async () => {
		const { opened, room } = await world(memory);
		try {
			const visit = await room.visit(priya);
			const first = await visit.send({ text: 'First?', key: 'replay-1' });
			const firstClose = await first.waitForClose();
			const second = await visit.send({ text: 'Second?', key: 'replay-2' });
			await second.waitForClose();

			const retry = await visit.send({ text: 'First?', key: 'replay-1' });
			expect(retry.from).toBe(first.from);
			expect(await retry.waitForClose()).toEqual(firstClose);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects an exchange wait when the room is stopped before close', async () => {
		const held = deferred();
		const { opened, room } = await world(memory, {
			streamFn: scripted(async (_context, _agent, call) => {
				if (call !== 2) return quiet();
				await held.promise;
				return quiet();
			}),
		});
		const exchange = await (await room.visit(priya)).send({ text: 'Hold?', key: 'stop-1' });
		await room.stop();
		held.resolve();
		await opened.dispose();
		await expect(exchange.waitForClose()).rejects.toThrow(/stopped|ended/i);
		await expect(exchange.response()).rejects.toThrow(/stopped|ended/i);
	});

	it.each(storages)('restores exchange handles from $name storage', async (storage) => {
		const opened = await storage.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: inProcessTransport(),
		});
		const name = roomName(`room-api-resume-${storage.name}`);
		const first = await startRoom({
			name,
			runtime,
			agents: [alpha],
			streamFn: scripted(() => quiet()),
		});
		try {
			const sent = await (await first.visit(priya)).send({ text: 'Persist?', key: 'resume-1' });
			const close = await sent.waitForClose();
			expect(close.from).toBe(sent.from);
			await first.stop();
			const resumed = await resumeRoom(name, {
				runtime,
				agents: [alpha],
				streamFn: scripted(() => quiet()),
			});
			try {
				const recovered = resumed.exchange(sent.from);
				expect(recovered).toBeDefined();
				expect(await recovered?.waitForClose()).toEqual(close);
			} finally {
				await resumed.stop();
			}
		} finally {
			await opened.dispose();
		}
	});
});
