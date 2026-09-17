import type { StreamFn } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	type Message,
	resumeRoom,
	startRoom,
} from '../src/index.ts';
import {
	inProcessTransport,
	type SeatContext,
	type SeatRoom,
	seatSessionId,
	type Transport,
} from '../src/transport.ts';
import { andrei, roomName, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted, speak } from './support/scripted.ts';
import { memory } from './support/storage.ts';

interface Call {
	readonly systemPrompt: string;
	readonly context: string;
	readonly call: number;
}

function definition(identity: string, instructions: string) {
	return defineAgent({
		name: 'writer',
		identity,
		instructions,
		model: 'scripted/writer',
	});
}

function answer(question: string, response: string, calls: Call[]): StreamFn {
	return scripted((context, _agent, call) => {
		calls.push({
			systemPrompt: context.systemPrompt ?? '',
			context: contextText(context),
			call,
		});
		const text = contextText(context);
		return text.includes(question) && !text.includes(response) ? speak(response) : quiet();
	});
}

function messagesOf(room: { messages(): Promise<readonly Message[]> }) {
	return room
		.messages()
		.then((messages) => messages.filter(isSpoken).map((message) => message.text));
}

function forwardingTransport(
	connections: Array<{ room: SeatRoom; context: SeatContext }>,
): Transport {
	const local = inProcessTransport();
	return {
		connect(room, context) {
			connections.push({ room, context });
			return local.connect(room, context);
		},
	};
}

describe('execution composition', () => {
	it('keeps same named definitions and room stream overrides isolated in one runtime', async () => {
		const firstCalls: Call[] = [];
		const secondCalls: Call[] = [];
		let defaultCalls = 0;
		const runtime = createRuntime({
			stream: scripted(() => {
				defaultCalls += 1;
				return quiet();
			}),
		});
		const firstDefinition = definition('First writer.', 'Use the first room instructions.');
		const secondDefinition = definition('Second writer.', 'Use the second room instructions.');
		const firstStream = answer('First question?', 'First answer.', firstCalls);
		const secondStream = answer('Second question?', 'Second answer.', secondCalls);
		const first = await startRoom({
			name: roomName('execution-first'),
			runtime,
			agents: [firstDefinition],
			streamFn: firstStream,
		});
		const second = await startRoom({
			name: roomName('execution-second'),
			runtime,
			agents: [secondDefinition],
			streamFn: secondStream,
		});
		try {
			await Promise.all([
				(await first.visit(andrei)).send({ text: 'First question?' }),
				(await second.visit(andrei)).send({ text: 'Second question?' }),
			]);
			await Promise.all([waitForRoom(first), waitForRoom(second)]);

			expect(await messagesOf(first)).toEqual(['First question?', 'First answer.']);
			expect(await messagesOf(second)).toEqual(['Second question?', 'Second answer.']);
			const firstTranscript = await runtime.transcripts.open(seatSessionId(first.name, 'writer'));
			const secondTranscript = await runtime.transcripts.open(seatSessionId(second.name, 'writer'));
			expect(await firstTranscript.getMetadata()).toMatchObject({ parentSessionId: first.name });
			expect(await secondTranscript.getMetadata()).toMatchObject({ parentSessionId: second.name });
			expect(seatSessionId(first.name, 'writer')).not.toBe(seatSessionId(second.name, 'writer'));
			expect(defaultCalls).toBe(0);
			expect(firstCalls.some((call) => call.systemPrompt.includes(firstDefinition.identity))).toBe(
				true,
			);
			expect(
				firstCalls.every((call) => call.systemPrompt.includes(firstDefinition.instructions)),
			).toBe(true);
			expect(
				secondCalls.some((call) => call.systemPrompt.includes(secondDefinition.identity)),
			).toBe(true);
			expect(
				secondCalls.every((call) => call.systemPrompt.includes(secondDefinition.instructions)),
			).toBe(true);
			expect(
				firstCalls.every((call) => !call.systemPrompt.includes(secondDefinition.instructions)),
			).toBe(true);
			expect(
				secondCalls.every((call) => !call.systemPrompt.includes(firstDefinition.instructions)),
			).toBe(true);
		} finally {
			await Promise.all([first.stop(), second.stop()]);
		}
	});

	it('uses the runtime stream as the default and resumes one room with new execution', async () => {
		const opened = await memory.open();
		const firstCalls: Call[] = [];
		const fallbackCalls: Call[] = [];
		const fallback = answer('Other question?', 'Runtime answer.', fallbackCalls);
		const runtime = createRuntime({ storage: opened.storage, stream: fallback });
		const first = await startRoom({
			name: roomName('execution-resume-first'),
			runtime,
			agents: [definition('Original writer.', 'Use the original instructions.')],
			streamFn: answer('Original question?', 'Original answer.', firstCalls),
		});
		const second = await startRoom({
			name: roomName('execution-resume-second'),
			runtime,
			agents: [definition('Other writer.', 'Keep the other room separate.')],
		});
		let resumed: Awaited<ReturnType<typeof startRoom>> | undefined;
		try {
			const original = await (await first.visit(andrei)).send({ text: 'Original question?' });
			await original.messages();
			await first.stop();

			resumed = await resumeRoom(first.name, {
				runtime,
				agents: [definition('Replacement writer.', 'Use the replacement instructions.')],
				streamFn: answer('Replacement question?', 'Replacement answer.', firstCalls),
			});
			const replacement = await (
				await resumed.visit(defineHuman({ name: 'replacement-person', identity: 'A new visitor.' }))
			).send({ text: 'Replacement question?' });
			const other = await (await second.visit(andrei)).send({ text: 'Other question?' });
			await Promise.all([replacement.messages(), other.messages()]);

			expect(await messagesOf(resumed)).toContain('Replacement answer.');
			expect(await messagesOf(second)).toEqual(['Other question?', 'Runtime answer.']);
			expect(fallbackCalls.length).toBeGreaterThan(0);
			expect(
				fallbackCalls.every((call) => call.systemPrompt.includes('Keep the other room separate.')),
			).toBe(true);
			expect(
				firstCalls.some((call) => call.systemPrompt.includes('Use the replacement instructions.')),
			).toBe(true);
		} finally {
			await resumed?.stop();
			await first.stop();
			await second.stop();
			await opened.dispose();
		}
	});

	it('forwards the default local runner with each room context and transcript namespace', async () => {
		const connections: Array<{ room: SeatRoom; context: SeatContext }> = [];
		const wrappedCalls: Call[] = [];
		const wrappedStream = answer('Wrapped question?', 'Wrapped answer.', wrappedCalls);
		const runtime = createRuntime({
			transport: forwardingTransport(connections),
			stream: wrappedStream,
		});
		const wrapped = definition('Wrapped writer.', 'Use the wrapped room instructions.');
		const room = await startRoom({
			name: roomName('execution-transport'),
			runtime,
			agents: [wrapped],
		});
		try {
			const exchange = await (await room.visit(andrei)).send({ text: 'Wrapped question?' });
			await exchange.messages();

			expect(await messagesOf(room)).toEqual(['Wrapped question?', 'Wrapped answer.']);
			expect(connections).toHaveLength(1);
			const connection = connections[0];
			if (connection === undefined) throw new Error('The runner did not connect.');
			expect(connection.context.room).toBe(room.name);
			expect(connection.context.seat).toBe(wrapped.name);
			expect(connection.context.definition).toEqual(wrapped);
			expect(connection.context.stream).toBe(wrappedStream);
			expect(connection.context.transcripts).toBe(runtime.transcripts);
			expect(wrappedCalls.some((call) => call.systemPrompt.includes(wrapped.instructions))).toBe(
				true,
			);
			const transcript = await runtime.transcripts.open(seatSessionId(room.name, wrapped.name));
			expect(await transcript.getMetadata()).toMatchObject({
				id: seatSessionId(room.name, wrapped.name),
				parentSessionId: room.name,
			});
		} finally {
			await room.stop();
		}
	});
});
