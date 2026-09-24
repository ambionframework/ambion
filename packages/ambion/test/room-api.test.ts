import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { inProcessTransport } from '../src/hosting.ts';
import {
	createRuntime,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { refusal } from './support/errors.ts';
import {
	assistant,
	closedExchange,
	crash,
	deferred,
	messagesOf,
	roomName,
	scriptedAgent,
	waitForRoom,
} from './support/room.ts';
import {
	contextText,
	isClosing,
	quiet,
	type Script,
	scripted,
	speak,
	summarise,
} from './support/scripted.ts';
import { openFor, stopAtEnd } from './support/stop.ts';
import { memory, type Storage, storages } from './support/storage.ts';

const alpha = scriptedAgent('alpha');
const beta = scriptedAgent('beta');
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

const answer: Script = (_context, _agent, call) => (call === 2 ? speak('The answer.') : quiet());
/** A seat script that holds its second model call until the test opens the gate. */
const heldBy =
	(gate: Promise<void>): Script =>
	async (_context, _agent, call) => {
		if (call === 2) await gate;
		return quiet();
	};
const withSummary = (): Script => {
	const answers = new Map<string, number>();
	let summarised = false;
	return (context, agent) => {
		if (agent === 'assistant') {
			if (!isClosing(context) || summarised) return quiet();
			summarised = true;
			return summarise('The result.');
		}
		const count = answers.get(agent) ?? 0;
		if (!contextText(context).includes('Can we ship?') || count >= 2) return quiet();
		answers.set(agent, count + 1);
		return speak('The answer.');
	};
};

type Options = Omit<Parameters<typeof startRoom>[0], 'name' | 'runtime' | 'execution'>;

/** A runtime on a fake clock over a storage the test disposes at its end. */
async function runtimeOn(storage: Storage): Promise<Runtime> {
	const opened = await openFor(storage);
	return createRuntime({
		storage: opened.storage,
		clock: fakeClock(),
		transport: inProcessTransport(),
	});
}

/** A room of `alpha` that stops at the end of the test. */
async function world(
	script: Script = answer,
	options: Options = {},
	storage: Storage = memory,
): Promise<{ runtime: Runtime; room: Room }> {
	const runtime = await runtimeOn(storage);
	const room = await startRoom({
		name: roomName('room-api'),
		runtime,
		agents: [alpha],
		execution: piExecution({ sessions: 'memory', stream: scripted(script) }),
		...options,
	});
	return { runtime, room: stopAtEnd(room) };
}

describe.each(storages)('the room API over $name storage', (storage) => {
	it('reads one detached projection', async () => {
		const runtime = await runtimeOn(storage);
		const missingName = roomName('room-read-missing');
		const missing = await readRoom(missingName, { runtime, messages: false });
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

		const name = roomName('room-read');
		const room = stopAtEnd(
			await startRoom({ name, runtime, agents: [], goal: 'Keep the record coherent.' }),
		);
		expect(room).not.toHaveProperty('messages');
		expect(room).not.toHaveProperty('participants');
		expect(await readRoom(name, { runtime, messages: false })).toMatchObject({
			initialized: true,
			goal: 'Keep the record coherent.',
		});
		const sent = await (await room.visit(priya)).send({ text: 'A question?', key: 'read-1' });
		expect(sent).not.toHaveProperty('messages');
		expect(sent).not.toHaveProperty('response');
		await messagesOf(room);
		const complete = await readRoom(name, { runtime });
		const closed = complete.exchanges.find((exchange) => exchange.from === sent.from);
		expect(closed).toMatchObject({ status: 'closed', summary: { status: 'silent' } });
		expect(complete.exchange).toBeUndefined();
		expect(complete.watermark).toBeGreaterThan(complete.messages.at(-1)?.seq ?? 0);

		const suffix = await readRoom(name, { runtime, messages: { since: sent.from } });
		expect(suffix.messages.every((message) => message.seq > sent.from)).toBe(true);
		const future = await readRoom(name, {
			runtime,
			messages: { since: Number.MAX_SAFE_INTEGER },
		});
		expect(future).toMatchObject({
			initialized: true,
			messages: [],
			watermark: complete.watermark,
		});

		const message = complete.messages.find((item) => item.seq === sent.from);
		if (message !== undefined) (message as { text: string }).text = 'mutated';
		const participant = complete.participants.find((item) => item.name === priya.name);
		if (participant !== undefined) (participant as { name: string }).name = 'mutated';
		const detached = await readRoom(name, { runtime });
		const detachedMessage = detached.messages.find((item) => item.seq === sent.from);
		expect(
			detachedMessage !== undefined && isSpoken(detachedMessage) ? detachedMessage.text : undefined,
		).toBe('A question?');
		expect(detached.participants.some((item) => item.name === priya.name)).toBe(true);
	});

	it('keeps an open exchange open after host eviction', async () => {
		const { runtime, room } = await world(answer, {}, storage);
		await (await room.visit(priya)).send({ text: 'Stay open?', key: 'open-1' });
		crash(runtime, room);
		const snapshot = await readRoom(room.name, { runtime, messages: false });
		expect(snapshot.initialized).toBe(true);
		expect(snapshot.exchange?.status).toBe('open');
	});

	it('restores exchange handles', async () => {
		const { runtime, room: first } = await world(() => quiet(), {}, storage);
		const sent = await (await first.visit(priya)).send({ text: 'Persist?', key: 'resume-1' });
		const conversation = await sent.waitForClose();
		expect(closedExchange(first, sent.from)?.from).toBe(sent.from);
		expect(conversation.at(0)?.seq).toBe(sent.from);
		await first.stop();
		const resumed = stopAtEnd(
			await resumeRoom(first.name, {
				runtime,
				agents: [alpha],
				execution: piExecution({ sessions: 'memory', stream: scripted(() => quiet()) }),
			}),
		);
		const recovered = resumed.exchange(sent.from);
		expect(recovered).toBeDefined();
		expect(await recovered?.waitForClose()).toEqual(conversation);
	});
});

describe('the room API', () => {
	it('opens ready, returns an exchange handle, and reads a durable snapshot', async () => {
		const { runtime, room } = await world(withSummary(), {
			summary: assistant.name,
			seats: { [alpha.name]: 'broadcast', [beta.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [alpha, beta, assistant],
		});
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
	});

	it.each([
		['the room has no assistant', {}],
		[
			'the assistant claims no summary',
			{ summary: assistant.name, seats: { [assistant.name]: 'none' }, agents: [assistant] },
		],
	] as const)('resolves the response as undefined when %s', async (_case, options) => {
		const { room } = await world(answer, options);
		const exchange = await (await room.visit(priya)).send({ text: 'Question?', key: 'none-1' });
		expect(await exchange.waitForClose()).toHaveLength(1);
		expect(closedExchange(room, exchange.from)).toMatchObject({ owner: priya.name });
		await expect(exchange.waitForSummary()).resolves.toBeUndefined();
	});

	it('maps a send to its final close when a newer message arrives before close commit', async () => {
		const gate = deferred();
		const { room } = await world(heldBy(gate.promise));
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
		expect(first.opened).toBe(true);
		expect(second.opened).toBe(false);
		expect(room.exchange(first.from)?.opened).toBe(false);
	});

	it('retries a delivery into its original exchange after a later exchange closes', async () => {
		const { room } = await world();
		const visit = await room.visit(priya);
		const first = await visit.send({ text: 'First?', key: 'replay-1' });
		const firstConversation = await first.waitForClose();
		await (await visit.send({ text: 'Second?', key: 'replay-2' })).waitForClose();

		const retry = await visit.send({ text: 'First?', key: 'replay-1' });
		expect(retry.from).toBe(first.from);
		expect(retry.opened).toBe(true);
		expect(await retry.waitForClose()).toEqual(firstConversation);
	});

	it('rejects the waits of an exchange when the room stops before close', async () => {
		const held = deferred();
		const { room } = await world(heldBy(held.promise));
		const exchange = await (await room.visit(priya)).send({ text: 'Hold?', key: 'stop-1' });
		await room.stop();
		held.resolve();
		await expect(exchange.waitForClose()).rejects.toThrow(/stopped|ended/i);
		await expect(exchange.waitForClose()).rejects.toEqual(refusal('room_stopped'));
		await expect(exchange.waitForSummary()).rejects.toThrow(/stopped|ended/i);
		await expect(exchange.waitForSummary()).rejects.toEqual(refusal('room_stopped'));
	});

	it('rejects an invalid room name for start, resume, and read', async () => {
		const runtime = await runtimeOn(memory);
		await expect(startRoom({ name: 'Invalid Name', runtime, agents: [alpha] })).rejects.toThrow(
			/name/,
		);
		await expect(resumeRoom('Invalid Name', { runtime, agents: [alpha] })).rejects.toThrow(/name/);
		await expect(readRoom('Invalid Name', { runtime })).rejects.toThrow(/name/);
	});
});
