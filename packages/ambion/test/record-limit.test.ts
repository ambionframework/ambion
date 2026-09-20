/**
 * A seat with a token limit reads a windowed record. The record keeps every
 * message; the seat pages the tail and reads the part that fits, plus the open
 * exchange whole. An older closed exchange with no summary falls out of context.
 */
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import { inProcessTransport, type SeatRoom, type Transport } from '../src/transport.ts';
import { priya, sam } from './support/cast.ts';
import { andrei, messagesOf, roomName, waitForRoom } from './support/room.ts';
import {
	answersEveryQuestion,
	contextText,
	isClosing,
	quiet,
	type Script,
	scripted,
	summarise,
} from './support/scripted.ts';

/** A page seen by the seat: the record floor it reported, and how many messages it carried. */
interface Page {
	earliest: number | undefined;
	count: number;
}

/** Wrap the in-process transport and record every view response the seat reads. */
function spyTransport(pages: Page[]): Transport {
	const local = inProcessTransport();
	return {
		connect(room, context) {
			const watched: SeatRoom = {
				...room,
				view: async (id, range) => {
					const response = await room.view(id, range);
					if ('view' in response)
						pages.push({
							earliest: response.view.context.earliest,
							count: response.view.context.messages.length,
						});
					return response;
				},
			};
			return local.connect(watched, context);
		},
	};
}

describe('a limit windows the record', () => {
	it('drops an older unsummarised exchange but keeps the open one', async () => {
		const contexts: string[] = [];
		const answer = answersEveryQuestion(['andrei']);
		const capture: Script = (context, name, call) => {
			contexts.push(contextText(context));
			return answer(context, name, call);
		};
		const worker = defineAgent({
			name: 'worker',
			identity: 'Answers a question.',
			instructions: 'Answer the current question.',
			model: 'scripted/worker',
			// A tight limit: one line fits, so only the open exchange stays.
			activationTokenLimit: 40,
			estimateTokens: (text) => text.length,
		});
		const runtime = createRuntime({ stream: scripted(capture) });
		const room = await startRoom({ name: roomName('limit'), runtime, agents: [worker] });

		await (await room.visit(andrei)).send({ text: 'alpha marker' });
		await waitForRoom(room);
		await (await room.visit(andrei)).send({ text: 'omega marker' });
		await waitForRoom(room);

		const answering = contexts.filter((text) => text.includes('omega marker'));
		expect(answering.length).toBeGreaterThan(0);
		// The open exchange is present; the older closed one is windowed out.
		expect(answering.every((text) => !text.includes('alpha marker'))).toBe(true);

		// The record still holds the dropped exchange for human review.
		const all = await messagesOf(room);
		expect(all.some((message) => 'text' in message && message.text === 'alpha marker')).toBe(true);
	});

	it('pages the room over the wire, so a budgeted seat reads bounded responses', async () => {
		const pages: Page[] = [];
		const worker = defineAgent({
			name: 'worker',
			identity: 'Answers a question.',
			instructions: 'Answer the current question.',
			model: 'scripted/worker',
			activationTokenLimit: 40,
			estimateTokens: (text) => text.length,
		});
		const runtime = createRuntime({
			transport: spyTransport(pages),
			stream: scripted(answersEveryQuestion(['andrei'])),
		});
		const room = await startRoom({ name: roomName('limit-wire'), runtime, agents: [worker] });

		await (await room.visit(andrei)).send({ text: 'a question' });
		await waitForRoom(room);

		// The room served a bounded page, not the whole record: a paged response
		// carries the record floor. Without the range reaching the room, none would.
		expect(pages.length).toBeGreaterThan(0);
		expect(pages.some((page) => page.earliest !== undefined)).toBe(true);
		await room.stop();
	});

	it('lets a summary writer with a limit read its whole exchange', async () => {
		const closings: string[] = [];
		const scribeScript: Script = (context) => {
			if (!isClosing(context)) return quiet();
			closings.push(contextText(context));
			return summarise('done');
		};
		const worker = defineAgent({
			name: 'worker',
			identity: 'Answers.',
			instructions: 'Answer.',
			model: 'scripted/worker',
		});
		// A limit small enough to trim the exchange if the closing activation windowed.
		const scribe = defineAgent({
			name: 'scribe',
			identity: 'Writes the closing message.',
			instructions: 'Summarize the exchange.',
			model: 'scripted/scribe',
			activationTokenLimit: 20,
			estimateTokens: (text) => text.length,
		});
		const runtime = createRuntime({
			stream: scripted((context, name, call) =>
				name === 'scribe'
					? scribeScript(context, name, call)
					: answersEveryQuestion(['andrei'])(context, name, call),
			),
		});
		const room = await startRoom({
			name: roomName('limit-summary'),
			runtime,
			agents: [worker, scribe],
			summary: 'scribe',
			seats: { worker: 'broadcast', scribe: 'broadcast' },
		});

		const exchange = await (await room.visit(andrei)).send({ text: 'opening question' });
		await exchange.waitForClose();
		await waitForRoom(room);

		// The closing activation reads its fixed exchange whole, so the opener line
		// is present even though it sits past the writer's token limit. The worker
		// echoes the question text, so the assertion reads the opener's own line,
		// not the substring the echo also carries.
		expect(closings.length).toBeGreaterThan(0);
		expect(closings.every((text) => text.includes('[andrei] opening question'))).toBe(true);
		await room.stop();
	});

	it('windows the background before a closing activation, keeping its own exchange whole', async () => {
		const closings: string[] = [];
		const scribeScript: Script = (context) => {
			if (!isClosing(context)) return quiet();
			// Write only for priya's exchange, so the earlier one closes without a summary.
			if (!context.systemPrompt?.includes('You are writing for priya.')) return quiet();
			closings.push(contextText(context));
			return summarise('done');
		};
		const worker = defineAgent({
			name: 'worker',
			identity: 'Answers.',
			instructions: 'Answer.',
			model: 'scripted/worker',
		});
		// A limit wide enough for priya's own exchange, too tight to also hold sam's.
		const scribe = defineAgent({
			name: 'scribe',
			identity: 'Writes the closing message.',
			instructions: 'Summarize the exchange.',
			model: 'scripted/scribe',
			activationTokenLimit: 60,
			estimateTokens: (text) => text.length,
		});
		const runtime = createRuntime({
			stream: scripted((context, name, call) =>
				name === 'scribe'
					? scribeScript(context, name, call)
					: answersEveryQuestion(['sam', 'priya'])(context, name, call),
			),
		});
		const room = await startRoom({
			name: roomName('limit-summary-background'),
			runtime,
			agents: [worker, scribe],
			summary: 'scribe',
			seats: { worker: 'broadcast', scribe: 'broadcast' },
		});

		const samExchange = await (await room.visit(sam)).send({ text: 'sam question' });
		await samExchange.waitForClose();
		await waitForRoom(room);
		const priyaExchange = await (await room.visit(priya)).send({ text: 'priya question' });
		await priyaExchange.waitForClose();
		await waitForRoom(room);

		// The pinned exchange stays whole; the earlier, unpinned one is windowed
		// out rather than read in full alongside it.
		expect(closings.length).toBeGreaterThan(0);
		expect(closings.every((text) => text.includes('priya question'))).toBe(true);
		expect(closings.every((text) => !text.includes('sam question'))).toBe(true);
		await room.stop();
	});

	it('pages the record across more than one page', async () => {
		const pages: Page[] = [];
		// A limit that wants the whole record, so the seat pages to the floor.
		const reader = defineAgent({
			name: 'reader',
			identity: 'Reads and stays quiet.',
			instructions: 'Stay quiet.',
			model: 'scripted/reader',
			activationTokenLimit: 100_000,
			estimateTokens: () => 1,
		});
		const runtime = createRuntime({
			transport: spyTransport(pages),
			stream: scripted(() => quiet()),
		});
		// The reader starts in the reserve, so the record grows without any read.
		const room = await startRoom({
			name: roomName('limit-pages'),
			runtime,
			agents: [reader],
			seats: {},
		});

		// More messages than one page holds (RECORD_PAGE is 64).
		const visit = await room.visit(andrei);
		for (let index = 0; index < 80; index += 1) await visit.send({ text: `message ${index}` });
		await waitForRoom(room);
		expect(pages).toHaveLength(0);

		// Seat the reader and wake it once: it reads the whole record over pages.
		await room.seat('reader');
		await visit.send({ text: 'wake the reader' });
		await waitForRoom(room);

		const all = await messagesOf(room);
		expect(all.length).toBeGreaterThan(64);
		// No response carried more than one page, and at least one page was full,
		// so the seat assembled the record over several bounded reads.
		expect(pages.length).toBeGreaterThan(0);
		expect(pages.every((page) => page.count <= 64)).toBe(true);
		expect(pages.some((page) => page.count === 64)).toBe(true);
		await room.stop();
	}, 60_000);
});
