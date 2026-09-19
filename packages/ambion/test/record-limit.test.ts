/**
 * A seat with a token limit reads a windowed record. The record keeps every
 * message; the seat pages the tail and reads the part that fits, plus the open
 * exchange whole. An older closed exchange with no summary falls out of context.
 */
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, startRoom } from '../src/index.ts';
import { andrei, messagesOf, roomName, waitForRoom } from './support/room.ts';
import { answersEveryQuestion, contextText, type Script, scripted } from './support/scripted.ts';

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
});
