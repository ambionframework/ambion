import { describe, expect, it } from 'vitest';
import { inProcessTransport } from '../src/hosting.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	isSummary,
	pi,
	type Room,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from './support/clock.ts';
import { refusal } from './support/errors.ts';
import {
	closedExchange,
	crash,
	deferred,
	messagesOf,
	roomName,
	waitForRoom,
} from './support/room.ts';
import { contextText, isClosing, quiet, scripted, speak, summarise } from './support/scripted.ts';
import { memory, type OpenedStorage, storages } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes one summary for each exchange.',
	executor: pi({
		instructions: 'Write one summary when the room closes an exchange.',
		model: 'scripted/assistant',
	}),
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer each question once.', model: 'scripted/alpha' }),
});
const beta = defineAgent({
	name: 'beta',
	identity: 'Checks answers.',
	executor: pi({ instructions: 'Answer each question once.', model: 'scripted/beta' }),
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
	it.each(storages)('reads one detached projection over $name storage', async (storage) => {
		const opened = await storage.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: inProcessTransport(),
		});
		const missingName = roomName(`room-read-missing-${storage.name}`);
		try {
			const missing = await readRoom(missingName, { runtime, messages: false });
			if (missing.initialized) throw new Error('Expected an uninitialized room.');
			expect(missing.goal).toBeUndefined();
			expect(missing).toEqual({
				name: missingName,
				initialized: false,
				messages: [],
				participants: [],
				exchanges: [],
				exchange: undefined,
				watermark: 0,
			});
			await expect(readRoom(missingName, { runtime, messages: { since: -1 } })).rejects.toThrow(
				/cursor/i,
			);

			const name = roomName(`room-read-${storage.name}`);
			const room = await startRoom({
				name,
				runtime,
				agents: [],
				goal: 'Keep the record coherent.',
			});
			try {
				expect(room).not.toHaveProperty('messages');
				expect(room).not.toHaveProperty('participants');
				const initialized = await readRoom(name, { runtime, messages: false });
				expect(initialized).toMatchObject({ initialized: true, goal: 'Keep the record coherent.' });
				const sent = await (await room.visit(priya)).send({ text: 'A question?', key: 'read-1' });
				expect(sent).not.toHaveProperty('messages');
				expect(sent).not.toHaveProperty('response');
				await messagesOf(room);
				const complete = await readRoom(name, { runtime });
				const closed = complete.exchanges.find((exchange) => exchange.from === sent.from);
				expect(closed).toMatchObject({ status: 'closed', summary: { status: 'silent' } });
				expect(complete.exchange).toBeUndefined();
				expect(complete.watermark).toBeGreaterThan(complete.messages.at(-1)?.seq ?? 0);

				const suffix = await readRoom(name, {
					runtime,
					messages: { since: sent.from },
				});
				expect(suffix.messages.every((message) => message.seq > sent.from)).toBe(true);
				const future = await readRoom(name, {
					runtime,
					messages: { since: Number.MAX_SAFE_INTEGER },
				});
				if (!future.initialized) throw new Error('Expected initialized metadata.');
				expect(future.messages).toEqual([]);
				expect(future.watermark).toBe(complete.watermark);

				const message = complete.messages.find((item) => item.seq === sent.from);
				if (message !== undefined) (message as { text: string }).text = 'mutated';
				const participant = complete.participants.find((item) => item.name === priya.name);
				if (participant !== undefined) (participant as { name: string }).name = 'mutated';
				const detached = await readRoom(name, { runtime });
				const detachedMessage = detached.messages.find((item) => item.seq === sent.from);
				expect(
					detachedMessage !== undefined && isSpoken(detachedMessage)
						? detachedMessage.text
						: undefined,
				).toBe('A question?');
				expect(detached.participants.some((item) => item.name === priya.name)).toBe(true);
			} finally {
				await room.stop();
			}
		} finally {
			await opened.dispose();
		}
	});

	it.each(storages)(
		'keeps an open exchange open after host eviction on $name storage',
		async (storage) => {
			const opened = await storage.open();
			const runtime = createRuntime({
				storage: opened.storage,
				clock: fakeClock(),
				transport: inProcessTransport(),
			});
			const name = roomName(`room-read-open-${storage.name}`);
			const room = await startRoom({ name, runtime, agents: [alpha], streamFn: answer });
			try {
				await (await room.visit(priya)).send({ text: 'Stay open?', key: 'open-1' });
				crash(runtime, room);
				const snapshot = await readRoom(name, { runtime, messages: false });
				expect(snapshot.initialized).toBe(true);
				expect(snapshot.exchange?.status).toBe('open');
			} finally {
				await opened.dispose();
			}
		},
	);

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
			const conversation = await exchange.waitForClose();
			const close = closedExchange(room, exchange.from);
			expect(conversation.filter(isSpoken).length).toBeGreaterThanOrEqual(3);
			expect(close).toMatchObject({ owner: priya.name, from: exchange.from });
			const response = await exchange.waitForSummary();
			expect(response).toMatchObject({ kind: 'summary', to: priya.name });
			expect(conversation.every((message) => message.kind !== 'summary')).toBe(true);

			await room.stop();
			expect(await exchange.waitForClose()).toEqual(conversation);
			expect(await exchange.waitForSummary()).toMatchObject({
				kind: 'summary',
				to: priya.name,
				covers: { from: close?.from, through: close?.through },
			});
			expect(await exchange.waitForSummary()).toEqual(response);
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
			const conversation = await exchange.waitForClose();
			expect(conversation).toHaveLength(1);
			expect(closedExchange(room, exchange.from)).toMatchObject({ owner: priya.name });
			await expect(exchange.waitForSummary()).resolves.toBeUndefined();
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
			await exchange.waitForClose();
			await expect(exchange.waitForSummary()).resolves.toBeUndefined();
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
			const conversation = await first.waitForClose();
			const close = closedExchange(room, first.from);
			const secondMessage = (await messagesOf(room)).find((message) => message.key === 'race-2');

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
			const firstConversation = await first.waitForClose();
			const firstClose = closedExchange(room, first.from);
			const second = await visit.send({ text: 'Second?', key: 'replay-2' });
			await second.waitForClose();

			const retry = await visit.send({ text: 'First?', key: 'replay-1' });
			expect(retry.from).toBe(first.from);
			expect(await retry.waitForClose()).toEqual(firstConversation);
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
		await expect(exchange.waitForClose()).rejects.toThrow(/stopped|ended/i);
		await expect(exchange.waitForClose()).rejects.toEqual(refusal('room_stopped'));
		await expect(exchange.waitForSummary()).rejects.toThrow(/stopped|ended/i);
		await expect(exchange.waitForSummary()).rejects.toEqual(refusal('room_stopped'));
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
			const conversation = await sent.waitForClose();
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
				expect(await recovered?.waitForClose()).toEqual(conversation);
			} finally {
				await resumed.stop();
			}
		} finally {
			await opened.dispose();
		}
	});
});
