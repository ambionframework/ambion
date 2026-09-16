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
import { closedExchange, deferred, roomName, waitForRoom } from './support/room.ts';
import { contextText, isClosing, quiet, scripted, speak, summarise } from './support/scripted.ts';
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
			if (isClosing(context) && !summarised.has(agent)) {
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
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alpha, beta, assistant],
			streamFn: withSummary(),
		});
		try {
			const visit = await room.visit(priya);
			await waitForRoom(room);
			const exchange = await visit.send({ text: 'Can we ship?', key: 'ship-1' });

			expect(exchange.owner).toBe(priya.name);
			const conversation = await exchange.messages();
			const close = closedExchange(room, exchange.from);
			expect(conversation.filter(isSpoken).length).toBeGreaterThanOrEqual(3);
			expect(close).toMatchObject({ owner: priya.name, from: exchange.from });
			const response = await exchange.response();
			expect(response).toMatchObject({ kind: 'summary', to: priya.name });
			expect(conversation.every((message) => message.kind !== 'summary')).toBe(true);

			await room.stop();
			expect(await exchange.messages()).toEqual(conversation);
			expect(await exchange.response()).toMatchObject({
				kind: 'summary',
				to: priya.name,
				covers: { from: close?.from, through: close?.through },
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
			const conversation = await exchange.messages();
			expect(conversation).toHaveLength(1);
			expect(closedExchange(room, exchange.from)).toMatchObject({ owner: priya.name });
			await expect(exchange.response()).resolves.toBeUndefined();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('resolves a pending response as undefined when no summary is claimed', async () => {
		const { opened, room } = await world(memory, {
			summary: assistant.name,
			seats: { [assistant.name]: 'none' },
			agents: [assistant],
			streamFn: scripted((_context, agent, call) =>
				agent === 'assistant' ? quiet() : call === 2 ? speak('One answer.') : quiet(),
			),
		});
		try {
			const exchange = await (
				await room.visit(priya)
			).send({ text: 'One answer?', key: 'silent-1' });
			await exchange.messages();
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
			const conversation = await first.messages();
			const close = closedExchange(room, first.from);
			const secondMessage = (await room.messages()).find((message) => message.key === 'race-2');

			expect(close?.from).toBe(first.from);
			expect(second.from).toBe(first.from);
			expect(secondMessage).toBeDefined();
			expect(close?.through).toBeGreaterThanOrEqual(secondMessage?.seq ?? 0);
			expect(conversation.map((message) => message.key)).toContain('race-2');
			expect(
				conversation.some((message) => message.kind === 'arrived' && message.from === sam.name),
			).toBe(true);
			expect(conversation.every((message) => message.kind !== 'summary')).toBe(true);
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
			const firstConversation = await first.messages();
			const firstClose = closedExchange(room, first.from);
			const second = await visit.send({ text: 'Second?', key: 'replay-2' });
			await second.messages();

			const retry = await visit.send({ text: 'First?', key: 'replay-1' });
			expect(retry.from).toBe(first.from);
			expect(await retry.messages()).toEqual(firstConversation);
			expect(firstClose).toBeDefined();
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('rejects an exchange conversation wait when the room is stopped before close', async () => {
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
		await expect(exchange.messages()).rejects.toThrow(/stopped|ended/i);
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
			const conversation = await sent.messages();
			const close = closedExchange(first, sent.from);
			expect(close?.from).toBe(sent.from);
			expect(conversation.at(0)?.seq).toBe(sent.from);
			await first.stop();
			const resumed = await resumeRoom(name, {
				runtime,
				agents: [alpha],
				streamFn: scripted(() => quiet()),
			});
			try {
				const recovered = resumed.exchange(sent.from);
				expect(recovered).toBeDefined();
				expect(await recovered?.messages()).toEqual(conversation);
			} finally {
				await resumed.stop();
			}
		} finally {
			await opened.dispose();
		}
	});
});
