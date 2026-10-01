/**
 * A seat with a token limit reads a windowed record. The record keeps every
 * message; the room serves the tail that fits, plus the open exchange whole,
 * in one view. An older closed exchange with no summary falls out of context.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	type AgentDefinition,
	type CreateRuntimeOptions,
	createRuntime,
	type Room,
	resumeRoom,
	type StartRoomOptions,
	startRoom,
} from '../src/index.ts';
import { RoomHost } from '../src/room-host/room.ts';
import { priya, sam } from './support/cast.ts';
import { around } from './support/ports.ts';
import { andrei, messagesOf, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import {
	answersEveryQuestion,
	contextText,
	isClosingContext,
	type PiScript,
	quiet,
	scripted,
	summarise,
} from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';

/** A view one seat read: the count it omitted, and its size. */
interface Page {
	seat: string;
	omitted?: number;
	count: number;
}

/** The estimators of the test runtime: `chars` counts one token per character. */
const estimators = { chars: (text: string) => text.length };

/** A Pi seat that counts one token per character, with this limit when one is given. */
const limited = (name: string, activationTokenLimit?: number) =>
	scriptedAgent(
		name,
		`${name}.`,
		activationTokenLimit === undefined ? {} : { activationTokenLimit, estimateTokens: 'chars' },
	);

/**
 * A room whose view responses and model contexts the test reads. The
 * execution records every view response a seat reads.
 */
async function watched(
	agents: AgentDefinition[],
	script: PiScript,
	options: { limits?: CreateRuntimeOptions['limits'] } & Partial<StartRoomOptions> = {},
) {
	const { limits, ...room } = options;
	const pages: Page[] = [];
	const contexts: { seat: string; text: string }[] = [];
	const stream = scripted((context, name, call) => {
		contexts.push({ seat: name, text: contextText(context) });
		return script(context, name, call);
	});
	const execution = around(piExecution({ sessions: 'memory', stream }), {
		room(protocol, request) {
			const view: typeof protocol.view = async (id, message) => {
				const response = await protocol.view(id, message);
				if ('view' in response) {
					const { omitted, messages } = response.view.context;
					pages.push({
						seat: request.seat,
						...(omitted === undefined ? {} : { omitted }),
						count: messages.length,
					});
				}
				return response;
			};
			return { ...protocol, view };
		},
	});
	const runtime = createRuntime({ limits, estimators, execution });
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
	(people: string[], closings: string[], writes: (context: string) => boolean): PiScript =>
	(context, name, call) => {
		if (name !== 'scribe') return answersEveryQuestion(people)(context, name, call);
		if (!isClosingContext(context) || !writes(context.systemPrompt ?? '')) return quiet();
		closings.push(contextText(context));
		return summarise('done');
	};

const scribeSeats = {
	summary: 'scribe',
	seats: { worker: 'broadcast', scribe: 'broadcast' },
} as const;

describe('a limit windows the record', () => {
	it('drops an older unsummarised exchange, keeps the open one, and windows at the room', async () => {
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
		// The room windowed the view it served: the response over the wire counts
		// what it left out.
		expect(pages.some((page) => page.omitted !== undefined)).toBe(true);
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
		// The token limit windows inside the cap, so each view counts what the cap left out.
		const read = pages.filter((page) => page.seat === 'reader');
		expect(read.length).toBeGreaterThan(0);
		expect(read.every((page) => page.omitted !== undefined)).toBe(true);
		const reading = contexts.filter(
			({ seat, text }) => seat === 'reader' && text.includes('omega marker'),
		);
		expect(reading.length).toBeGreaterThan(0);
		expect(reading.every(({ text }) => !text.includes('alpha marker'))).toBe(true);
		expect(reading.some(({ text }) => /\d+ earlier messages? not shown/.test(text))).toBe(true);
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

	it('fails the start and the resume of a room whose agent names an estimator the runtime lacks', async () => {
		const reader = scriptedAgent('reader', 'reader.', {
			activationTokenLimit: 10,
			estimateTokens: 'words',
		});
		const runtime = createRuntime({ estimators });
		const name = roomName('estimator');
		const refused = { code: 'missing_definition', message: /names estimator 'words'/ };
		await expect(startRoom({ name, runtime, agents: [reader] })).rejects.toMatchObject(refused);
		const room = await startRoom({ name, runtime, agents: [limited('reader', 10)] });
		// A name the room defines no seat for sets no token limit.
		expect(room instanceof RoomHost && room.tokenWindow('nobody')).toBeUndefined();
		await room.stop();
		await expect(resumeRoom(name, { runtime, agents: [reader] })).rejects.toMatchObject(refused);
	});
});
