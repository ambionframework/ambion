import { afterEach, describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	pendingFor,
	type Room,
	readRoom,
	type SummaryMessage,
	startRoom,
} from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
import { deferred, messagesOf, roomName, waitForRoom } from './support/room.ts';
import { byAgent, quiet, type Script, scripted, speak } from './support/scripted.ts';

const product = defineAgent({
	name: 'product',
	identity: 'The one product in this room.',
	executor: pi({ instructions: 'answer what is asked', model: 'scripted/product' }),
});
const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	executor: pi({ instructions: 'Answer what was asked, once.', model: 'scripted/assistant' }),
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });
const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

const runtime = createRuntime({ clock: fakeClock() });
const started: Room[] = [];
afterEach(async () => {
	for (const room of started.splice(0)) await room.stop();
});

/** Two people ask in one exchange while the product is still reading. */
async function twoPeopleOneExchange(assistantScript: Script | undefined) {
	const held = deferred();
	const room = await startRoom({
		name: roomName('multi'),
		summary: 'assistant',
		agents: [product, assistant],
		seats: { product: 'broadcast', assistant: 'none' },
		execution: piExecution({
			stream: scripted(
				byAgent({
					product: async (_context, _name, call) => {
						if (call === 1) {
							await held.promise;
							return speak('Saturday works.', 'sam');
						}
						return quiet();
					},
					...(assistantScript === undefined ? {} : { assistant: assistantScript }),
				}),
			),
		}),
		runtime,
	});
	started.push(room);
	const hers = await room.visit(priya);
	const his = await room.visit(sam);
	await hers.send({ text: 'Can I tell the client Thursday?' });
	await his.send({ text: 'What do my crews do at seven?' });
	held.resolve();
	await waitForRoom(room);
	return room;
}

const summariesOf = async (room: Room): Promise<SummaryMessage[]> =>
	(await messagesOf(room)).filter(
		(message): message is SummaryMessage => message.kind === 'summary',
	);

describe('a summary for each person who spoke', () => {
	it('writes one summary to each person and keeps them on the exchange view', async () => {
		const room = await twoPeopleOneExchange((_context, _name, call) => {
			if (call === 1) return speak('For priya.', 'priya');
			if (call === 2) return speak('For sam.', 'sam');
			return quiet();
		});
		const written = await summariesOf(room);
		expect(written.map((message) => message.to)).toEqual(['priya', 'sam']);
		const read = await room.read();
		const [exchange] = read.exchanges;
		expect(exchange).toMatchObject({
			status: 'closed',
			outcome: { kind: 'awaiting', person: 'sam' },
		});
		expect(exchange?.status === 'closed' && exchange.summary).toMatchObject({
			status: 'published',
			summary: { to: 'priya' },
		});
		expect(exchange?.status === 'closed' && exchange.summaries?.map((s) => s.to)).toEqual([
			'priya',
			'sam',
		]);
	});

	it('reports pendingFor for the person the last message asks', async () => {
		const room = await twoPeopleOneExchange(undefined);
		const pending = await room.pendingFor('sam');
		expect(pending).toHaveLength(1);
		expect(pending[0]?.outcome).toEqual({ kind: 'awaiting', person: 'sam' });
		expect(await room.pendingFor('priya')).toEqual([]);
	});

	it('reads the same outcome and pendingFor after a restart', async () => {
		const room = await twoPeopleOneExchange((_context, _name, call) =>
			call === 1 ? speak('For priya.', 'priya') : quiet(),
		);
		const before = await room.read();
		await room.stop();
		const after = await readRoom(room.name, { runtime });
		expect(after.exchanges).toEqual(before.exchanges);
		expect(pendingFor(after, 'sam')).toHaveLength(1);
	});

	it('refuses a second summary for the same person', async () => {
		const room = await twoPeopleOneExchange((_context, _name, call) =>
			call <= 2 ? speak(`For priya ${call}.`, 'priya') : quiet(),
		);
		expect((await summariesOf(room)).map((message) => message.to)).toEqual(['priya']);
	});
});
