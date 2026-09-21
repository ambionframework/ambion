import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	exchangeUri,
	isSpoken,
	isSummary,
	type Message,
	readExchange,
	readRoom,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import { collect, roomName } from './support/room.ts';
import { byAgent, callTool, isClosing, quiet, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const product = defineAgent({
	name: 'product',
	identity: 'Answers questions.',
	executor: pi({ instructions: 'Answer what is asked.', model: 'scripted/product' }),
});
const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the summary.',
	executor: pi({ instructions: 'Summarise once.', model: 'scripted/assistant' }),
});

const answerRefs = ['https://x/a', 'ambion://room/other'];

const spoken = (messages: readonly Message[]) =>
	messages.find((message) => message.kind === 'said' && message.from === 'product');

describe.each(storages)('refs through the room on $name storage', (storage) => {
	it('stores refs on a said and on a summary, and keeps them across a restart', async () => {
		const opened = await storage.open();
		const name = roomName(`refs-room-${storage.name}`);
		let from = 0;
		const stream = scripted(
			byAgent({
				product: (_context, _agent, call) =>
					call === 1 ? callTool('say', { text: 'Answer.', refs: answerRefs }) : quiet(),
				assistant: (context) =>
					isClosing(context)
						? callTool('say', { text: 'Summary.', refs: [exchangeUri(name, from)] })
						: quiet(),
			}),
		);
		const room = await startRoom({
			name,
			goal: 'Cite what is said.',
			agents: [product, assistant],
			seats: { product: 'broadcast', assistant: 'none' },
			summary: assistant.name,
			runtime: createRuntime({ storage: opened.storage }),
			execution: piExecution({ stream }),
		});
		try {
			const events = collect(room);
			const exchange = await (await room.visit(person)).send({ text: 'Question?' });
			from = exchange.from;
			expect(spoken(await exchange.waitForClose())).toMatchObject({ refs: answerRefs });
			const cited = [exchangeUri(name, exchange.from)];
			expect(await exchange.waitForSummary()).toMatchObject({ kind: 'summary', refs: cited });
			const notified = events.flatMap((event) =>
				event.type === 'message' &&
				(isSpoken(event.message) || isSummary(event.message)) &&
				event.message.refs !== undefined
					? [event.message.refs]
					: [],
			);
			expect(notified).toEqual([answerRefs, cited]);
			await room.stop();

			const runtime = createRuntime({ storage: opened.storage });
			const resumed = await resumeRoom(name, {
				agents: [product, assistant],
				runtime,
				execution: piExecution({ stream }),
			});
			try {
				const read = await readExchange(name, exchange.from, { runtime });
				const whole = await readRoom(name, { runtime });
				expect(spoken(read?.messages ?? [])).toMatchObject({ refs: answerRefs });
				expect(spoken(whole.messages)).toMatchObject({ refs: answerRefs });
				const summary = whole.messages.find((message) => message.kind === 'summary');
				expect(summary).toMatchObject({ refs: cited });
				(summary?.refs as string[] | undefined)?.push('https://x/mutated');
				const again = await readRoom(name, { runtime });
				expect(again.messages.find((message) => message.kind === 'summary')?.refs).toEqual(cited);
			} finally {
				await resumed.stop();
			}
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
