/**
 * A seat with a token limit reads a windowed record. The record keeps every
 * message; the seat pages the tail and reads the part that fits, plus the open
 * exchange whole. An older closed exchange with no summary falls out of context.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { inProcessTransport, type Transport } from '../src/hosting.ts';
import {
	type AgentDefinition,
	createRuntime,
	type Room,
	type CreateRuntimeOptions,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import { priya, sam } from './support/cast.ts';
import { andrei, messagesOf, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import {
	answersEveryQuestion,
	contextText,
	isClosing,
	quiet,
	type Script,
	scripted,
	summarise,
} from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';

/** A page one seat read: the record floor it reported, the count it omitted, and its size. */
interface Page {
	seat: string;
	earliest: number | undefined;
	omitted?: number;
	count: number;
}

/** A Pi seat that counts one token per character, with this limit when one is given. */
const limited = (name: string, activationTokenLimit?: number) =>
	scriptedAgent(
		name,
		`${name}.`,
		activationTokenLimit === undefined
			? {}
			: { activationTokenLimit, estimateTokens: (text: string) => text.length },
	);

/**
 * A room whose view responses and model contexts the test reads. The transport
 * wraps the in-process one and records every view response a seat reads.
 */
async function watched(
	agents: AgentDefinition[],
	script: Script,
	options: { limits?: CreateRuntimeOptions['limits'] } & Partial<StartRoomOptions> = {},
) {
	const { limits, ...room } = options;
	const pages: Page[] = [];
	const contexts: { seat: string; text: string }[] = [];
	const local = inProcessTransport();
	const transport: Transport = {
		connect(protocol, context) {
			const view: typeof protocol.view = async (id, range) => {
				const response = await protocol.view(id, range);
				if ('view' in response) {
					const { earliest, omitted, messages } = response.view.context;
					pages.push({ seat: context.seat, earliest, omitted, count: messages.length });
				}
				return response;
			};
			return local.connect({ ...protocol, view }, context);
		},
	};
	const stream = scripted((context, name, call) => {
		contexts.push({ seat: name, text: contextText(context) });
		return script(context, name, call);
	});
	const runtime = createRuntime({ transport, limits, execution: piExecution({ stream }) });
	const started = stopAtEnd(await startRoom({ name: roomName('limit'), runtime, agents, ...room }));
	return { room: started, pages, contexts };
}

async function ask(room: Room, texts: string[], who = andrei) {
	for (const text of texts) {
		await (await room.visit(who)).send({ text });
		await waitForRoom(room);
	}
}

async function recorded(room: Room, text: string) {
	return (await messagesOf(room)).some((message) => 'text' in message && message.text === text);
}

/** A worker that answers every question, and a scribe that summarizes when `writes` says so. */
const scribing =
	(people: string[], closings: string[], writes: (context: string) => boolean): Script =>
	(context, name, call) => {
		if (name !== 'scribe') return answersEveryQuestion(people)(context, name, call);
		if (!isClosing(context) || !writes(context.systemPrompt ?? '')) return quiet();
		closings.push(contextText(context));
		return summarise('done');
	};

const scribeSeats = {
	summary: 'scribe',
	seats: { worker: 'broadcast', scribe: 'broadcast' },
} as const;

describe('a limit windows the record', () => {
	it('drops an older unsummarised exchange, keeps the open one, and pages the room over the wire', async () => {
		const { room, pages, contexts } = await watched(
			[limited('worker', 40)],
			answersEveryQuestion(['andrei']),
		);
		await ask(room, ['alpha marker', 'omega marker']);

		const answering = contexts.filter(({ text }) => text.includes('omega marker'));
		expect(answering.length).toBeGreaterThan(0);
		// The open exchange is present; the older closed one is windowed out.
		expect(answering.every(({ text }) => !text.includes('alpha marker'))).toBe(true);
		expect(answering.every(({ text }) => text.includes('earlier message'))).toBe(true);
		// The record still holds the dropped exchange for human review.
		expect(await recorded(room, 'alpha marker')).toBe(true);
		// The room served a bounded page: a paged response carries the record
		// floor. Without the range reaching the room, none would.
		expect(pages.some((page) => page.earliest !== undefined)).toBe(true);
	});

	it('caps the record at the room for a seat with no token limit, and a token-limited seat stops at the room floor', async () => {
		const { room, pages, contexts } = await watched(
			[limited('worker'), limited('reader', 4000)],
			(context, name, call) =>
				name === 'worker' ? answersEveryQuestion(['andrei'])(context, name, call) : quiet(),
			{ limits: { context: { messages: 1 } } },
		);
		await ask(room, ['alpha marker', 'omega marker']);

		const answering = contexts.filter(
			({ seat, text }) => seat === 'worker' && text.includes('omega marker'),
		);
		expect(answering.length).toBeGreaterThan(0);
		expect(answering.every(({ text }) => !text.includes('alpha marker'))).toBe(true);
		expect(answering.every(({ text }) => /\d+ earlier messages? not shown/.test(text))).toBe(true);
		expect(await recorded(room, 'alpha marker')).toBe(true);
		// Every page of the token-limited seat reports the count the cap omits.
		const read = pages.filter((page) => page.seat === 'reader');
		expect(read.length).toBeGreaterThan(0);
		expect(read.every((page) => page.omitted !== undefined)).toBe(true);
		expect(read.some((page) => (page.omitted ?? 0) > 0)).toBe(true);
	});

	it('lets a summary writer with a limit read its whole exchange', async () => {
		const closings: string[] = [];
		// A limit small enough to trim the exchange if the closing activation windowed.
		const { room } = await watched(
			[limited('worker'), limited('scribe', 20)],
			scribing(['andrei'], closings, () => true),
			scribeSeats,
		);
		await ask(room, ['opening question']);

		// The closing activation reads its fixed exchange whole, so the opener line
		// is present even though it sits past the writer's token limit. The worker
		// echoes the question text, so the assertion reads the opener's own line.
		expect(closings.length).toBeGreaterThan(0);
		expect(closings.every((text) => text.includes('[andrei] opening question'))).toBe(true);
	});

	it('windows the background before a closing activation, keeping its own exchange whole', async () => {
		const closings: string[] = [];
		// A limit wide enough for priya's own exchange, too tight to also hold sam's.
		// The scribe writes only for priya, so the earlier exchange closes without a summary.
		const { room } = await watched(
			[limited('worker'), limited('scribe', 60)],
			scribing(['sam', 'priya'], closings, (prompt) =>
				prompt.includes('You are writing for priya.'),
			),
			scribeSeats,
		);
		await ask(room, ['sam question'], sam);
		await ask(room, ['priya question'], priya);

		expect(closings.length).toBeGreaterThan(0);
		expect(closings.every((text) => text.includes('priya question'))).toBe(true);
		expect(closings.every((text) => !text.includes('sam question'))).toBe(true);
	});

	it('pages the record across more than one page', async () => {
		// A limit that wants the whole record, so the seat pages to the floor.
		// The reader starts in the reserve, so the record grows without any read.
		const { room, pages } = await watched(
			[
				scriptedAgent('reader', 'reader.', {
					activationTokenLimit: 100_000,
					estimateTokens: () => 1,
				}),
			],
			() => quiet(),
			{ seats: {} },
		);

		// More messages than one page holds (RECORD_PAGE is 64).
		const visit = await room.visit(andrei);
		for (let index = 0; index < 80; index += 1) await visit.send({ text: `message ${index}` });
		await waitForRoom(room);
		expect(pages).toHaveLength(0);

		// Seat the reader and wake it once: it reads the whole record over pages.
		await room.seat('reader');
		await visit.send({ text: 'wake the reader' });
		await waitForRoom(room);

		expect((await messagesOf(room)).length).toBeGreaterThan(64);
		// No response carried more than one page, and at least one page was full,
		// so the seat assembled the record over several bounded reads.
		expect(pages.length).toBeGreaterThan(0);
		expect(pages.every((page) => page.count <= 64)).toBe(true);
		expect(pages.some((page) => page.count === 64)).toBe(true);
	}, 60_000);
});
