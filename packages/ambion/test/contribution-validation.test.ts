import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	type Runtime,
	readRoom,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import { runningRoom, type SeatRoom, type Transport } from '../src/transport.ts';
import { messagesOf, roomName, stateOf } from './support/room.ts';
import { memory, type OpenedStorage, type Storage, storages } from './support/storage.ts';

const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const worker = defineAgent({
	name: 'worker',
	identity: 'Answers questions.',
	instructions: 'Answer the record.',
	model: 'scripted/worker',
});
const writer = defineAgent({
	name: 'writer',
	identity: 'Writes summaries.',
	instructions: 'Summarise the record.',
	model: 'scripted/writer',
});

const passiveTransport: Transport = {
	connect: () => ({
		wake: async () => {},
		steer: async () => {},
		cut: async () => {},
	}),
};

interface World {
	opened: OpenedStorage;
	runtime: Runtime;
	room: Room;
}

async function openWorld(
	storage: Storage,
	options: Omit<StartRoomOptions, 'name' | 'runtime'>,
): Promise<World> {
	const opened = await storage.open();
	const runtime = createRuntime({ storage: opened.storage, transport: passiveTransport });
	const room = await startRoom({
		name: roomName(`contribution-validation-${storage.name}`),
		runtime,
		...options,
	});
	return { opened, runtime, room };
}

async function protocol(runtime: Runtime, name: string): Promise<SeatRoom> {
	const peer = runningRoom(runtime, name);
	if (peer === undefined) throw new Error('The room is absent.');
	return peer;
}

const blankTexts = ['', '\u00a0\u2003\u202f'];

describe.each(storages)('contribution validation on $name storage', (storage) => {
	it.each(blankTexts)(
		'rejects blank visit %j without changing the record, then accepts the same key verbatim',
		async (blank) => {
			const { opened, room, runtime } = await openWorld(storage, { agents: [] });
			try {
				const visit = await room.visit(person);
				const before = await messagesOf(room);
				const beforeSnapshot = await readRoom(room.name, { runtime });
				const key = 'visit-blank';
				await expect(visit.send({ key, text: blank })).rejects.toThrow(/message is empty/i);
				expect(await messagesOf(room)).toEqual(before);
				expect((await readRoom(room.name, { runtime })).exchange).toEqual(beforeSnapshot.exchange);
				expect((await readRoom(room.name, { runtime })).watermark).toBe(beforeSnapshot.watermark);

				const preserved = '  accepted \u00a0 ';
				const exchange = await visit.send({ key, text: preserved });
				const said = (await messagesOf(room)).find((message) => message.key === key);
				expect(said).toMatchObject({ kind: 'said', text: preserved, key });
				expect(exchange.from).toBe(said?.seq);
				const accepted = await messagesOf(room);
				expect((await visit.send({ key, text: blank })).from).toBe(exchange.from);
				expect(await messagesOf(room)).toEqual(accepted);
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it.each(blankTexts)(
		'rejects blank ordinary commit %j without consuming its key, then accepts a corrected retry',
		async (blank) => {
			const { opened, room, runtime } = await openWorld(storage, {
				agents: [worker],
				seats: { [worker.name]: 'broadcast' },
			});
			try {
				const exchange = await (await room.visit(person)).send({ text: 'Question?' });
				const peer = await protocol(runtime, room.name);
				const activation = `message:${exchange.from}:${worker.name}:1`;
				expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
				const key = 'ordinary-blank';
				const view = await peer.view(activation);
				if (!('view' in view)) throw new Error('The ordinary activation is absent.');
				const before = await readRoom(room.name, { runtime });
				const refused = await peer.commit({
					activation,
					key,
					readThrough: view.view.through,
					intent: { kind: 'said', text: blank },
				});
				expect(refused).toMatchObject({ refused: expect.stringMatching(/message is empty/i) });
				expect(await messagesOf(room)).toEqual(before.messages);
				expect((await readRoom(room.name, { runtime })).watermark).toBe(before.watermark);

				const preserved = '  ordinary \u00a0 ';
				const latest = await peer.view(activation);
				if (!('view' in latest)) throw new Error('The ordinary activation is absent.');
				const accepted = await peer.commit({
					activation,
					key,
					readThrough: latest.view.through,
					intent: { kind: 'said', text: preserved },
				});
				expect(accepted).toMatchObject({ committed: { kind: 'said', text: preserved, key } });
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it.each(blankTexts)(
		'rejects blank closing summary %j without consuming its key, then accepts a corrected retry',
		async (blank) => {
			const { opened, room, runtime } = await openWorld(storage, {
				agents: [writer],
				summary: writer.name,
				seats: { [writer.name]: 'none' },
			});
			try {
				const exchange = await (await room.visit(person)).send({ text: 'Question?' });
				await room.reconcile();
				const owed = stateOf(room).due.find((work) => work.source === 'closed');
				if (owed === undefined) throw new Error('The room has no closing assignment.');
				const peer = await protocol(runtime, room.name);
				expect(await peer.lease({ activation: owed.id, operation: 'claim' })).toHaveProperty('ok');
				const key = 'summary-blank';
				const before = await readRoom(room.name, { runtime });
				const refused = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', text: blank },
				});
				expect(refused).toMatchObject({ refused: expect.stringMatching(/message is empty/i) });
				expect(await messagesOf(room)).toEqual(before.messages);
				expect((await readRoom(room.name, { runtime })).watermark).toBe(before.watermark);

				const preserved = '  summary \u00a0 ';
				const accepted = await peer.commit({
					activation: owed.id,
					key,
					intent: { kind: 'said', text: preserved },
				});
				expect(accepted).toMatchObject({
					committed: {
						kind: 'summary',
						text: preserved,
						key,
						to: person.name,
						covers: { from: exchange.from, through: exchange.from },
					},
				});
			} finally {
				await room.stop();
				await opened.dispose();
			}
		},
	);

	it('replays a committed key before validating a replacement blank', async () => {
		const { opened, room, runtime } = await openWorld(storage, {
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const view = await peer.view(activation);
			if (!('view' in view)) throw new Error('The ordinary activation is absent.');
			const original = await peer.commit({
				activation,
				key: 'replay-original',
				readThrough: view.view.through,
				intent: { kind: 'said', text: 'Original text.' },
			});
			expect(original).toMatchObject({ committed: { text: 'Original text.' } });
			const before = await messagesOf(room);
			const replay = await peer.commit({
				activation,
				key: 'replay-original',
				readThrough: view.view.through,
				intent: { kind: 'said', text: '\u00a0\u2003' },
			});
			expect(replay).toEqual(original);
			expect(await messagesOf(room)).toEqual(before);
			expect(
				(await messagesOf(room)).filter((message) => message.key === 'replay-original'),
			).toHaveLength(1);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});

describe('outer protocol authority', () => {
	it('keeps stale and missed refusals ahead of contribution validation', async () => {
		const { opened, room, runtime } = await openWorld(memory, {
			agents: [worker],
			seats: { [worker.name]: 'broadcast' },
		});
		try {
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			const peer = await protocol(runtime, room.name);
			const activation = `message:${exchange.from}:${worker.name}:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const view = await peer.view(activation);
			if (!('view' in view)) throw new Error('The ordinary activation is absent.');
			await (await room.visit(person)).send({ text: 'New context?' });
			const missed = await peer.commit({
				activation,
				key: 'missed-blank',
				readThrough: view.view.through,
				intent: { kind: 'said', text: '\u00a0' },
			});
			expect(missed).toHaveProperty('missed');
			await peer.lease({ activation, operation: 'release', reason: 'released', readThrough: 0 });
			const stale = await peer.commit({
				activation,
				key: 'stale-blank',
				readThrough: view.view.through,
				intent: { kind: 'said', text: '' },
			});
			expect(stale).toHaveProperty('stale');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
