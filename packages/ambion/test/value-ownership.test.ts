import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	isSpoken,
	type Message,
	type RoomNotification,
	readRoom,
	startRoom,
} from '../src/index.ts';
import { andrei, roomName } from './support/room.ts';
import { isClosing, quiet, scripted, speak } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const writer = defineAgent({
	name: 'writer',
	identity: 'Writes the closing result.',
	instructions: 'Summarize the discussion.',
	model: 'scripted/writer',
});

function changeMessage(message: Message): void {
	Reflect.set(message, 'from', 'intruder');
	Reflect.set(message, 'text', 'Changed outside the journal.');
	message.wakes?.push('intruder');
	if (message.kind === 'summary') message.covers.through = -1;
}

describe.each(storages)('room value ownership on $name', (storage) => {
	it.each(['messages', 'snapshot', 'exchange'] as const)(
		'detaches %s reads from the room and its replay',
		async (source) => {
			const opened = await storage.open();
			const runtime = createRuntime({ storage: opened.storage });
			const room = await startRoom({ name: roomName('owned-read'), runtime });
			try {
				const exchange = await (await room.visit(andrei)).send({ text: 'Original question.' });
				await exchange.messages();
				const expected = await readRoom(room.name, {
					runtime: createRuntime({ storage: opened.storage }),
				});
				const messages =
					source === 'messages'
						? await room.messages()
						: source === 'snapshot'
							? (await readRoom(room.name, { runtime })).messages
							: await exchange.messages();
				const question = messages.find(isSpoken);
				if (question === undefined) throw new Error('No question was read.');
				changeMessage(question);
				expect(await room.messages()).toEqual(expected.messages);
				expect(await readRoom(room.name, { runtime })).toEqual(expected);
				expect(await exchange.messages()).toEqual(
					expected.messages.filter((message) => message.seq >= exchange.from),
				);
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it('captures read filters and seating options when the caller invokes them', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({
			name: roomName('owned-options'),
			runtime,
			agents: [writer],
			seats: {},
			streamFn: scripted(() => quiet()),
		});
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Original question.' });
			await exchange.messages();
			const filter = { since: 0 };
			const reading = room.messages(filter);
			filter.since = Number.MAX_SAFE_INTEGER;
			expect((await reading).filter(isSpoken).map((message) => message.text)).toEqual([
				'Original question.',
			]);
			const options: { attention: 'none' | 'broadcast' } = { attention: 'none' };
			const seating = room.seat(writer.name, options);
			options.attention = 'broadcast';
			await seating;
			expect(room.participants()).toContainEqual(
				expect.objectContaining({ name: writer.name, attention: 'none' }),
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('detaches each summary response and its nested source range', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({
			name: roomName('owned-response'),
			runtime,
			agents: [writer],
			seats: { writer: 'none' },
			summary: writer.name,
			streamFn: scripted((context) => (isClosing(context) ? speak('Original result.') : quiet())),
		});
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Question?' });
			const response = await exchange.response();
			if (response === undefined) throw new Error('No summary was written.');
			const expected = structuredClone(response);
			changeMessage(response);
			expect(await exchange.response()).toEqual(expected);
			expect((await room.messages()).find((message) => message.kind === 'summary')).toEqual(
				expected,
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('isolates notification listeners from each other and the room', async () => {
		const opened = await storage.open();
		const runtime = createRuntime({ storage: opened.storage });
		const room = await startRoom({ name: roomName('owned-notifications'), runtime });
		const seen: RoomNotification[] = [];
		try {
			const visit = await room.visit(andrei);
			room.subscribe((event) => {
				if (event.type === 'message') changeMessage(event.message);
				if (event.type === 'exchange_opened') Reflect.set(event.exchange, 'owner', 'intruder');
			});
			room.subscribe((event) => seen.push(event));
			const exchange = await visit.send({ text: 'Original question.' });
			await exchange.messages();
			expect(seen).toContainEqual({
				type: 'message',
				message: expect.objectContaining({ from: andrei.name, text: 'Original question.' }),
			});
			expect(seen).toContainEqual({
				type: 'exchange_opened',
				exchange: expect.objectContaining({ owner: andrei.name }),
			});
			expect(exchange.owner).toBe(andrei.name);
			expect(await readRoom(room.name, { runtime })).toEqual(
				await readRoom(room.name, { runtime: createRuntime({ storage: opened.storage }) }),
			);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
