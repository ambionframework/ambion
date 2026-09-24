/** Pi harness events as trace steps, over events built by hand. */
import type { HarnessEvent } from '@earendil-works/pi-agent-core';
import { type AssistantMessage, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { PiSteps } from '../src/pi-trace.ts';

const at = { lane: 'main', runId: 'run' };

const assistant: AssistantMessage = fauxAssistantMessage([
	{ type: 'thinking', thinking: 'Plan.' },
	{ type: 'text', text: 'Answer.' },
]);

const start = (message = assistant) => ({ type: 'message_start', ...at, message }) as HarnessEvent;
const end = (message = assistant) => ({ type: 'message_end', ...at, message }) as HarnessEvent;
const update = (event: object) =>
	({ type: 'message_update', ...at, message: assistant, event }) as HarnessEvent;

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usage = {
	type: 'usage',
	lane: 'main',
	row: {
		usage: {
			input: 10,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 17,
			cost: { ...zero, total: 0.5 },
		},
	},
	totals: {},
} as unknown as HarnessEvent;

const toolEnd = (result: unknown, isError: boolean) =>
	({
		type: 'tool_end',
		...at,
		turnId: 't',
		toolCallId: 'c1',
		toolName: 'book',
		result,
		isError,
		terminate: false,
	}) as HarnessEvent;

const all = (events: HarnessEvent[]) => {
	const steps = new PiSteps();
	return events.flatMap((event) => steps.steps(event));
};

describe('the steps of harness events', () => {
	it('gives streamed deltas, then a closing step with no text, and adds no block at the end', () => {
		expect(
			all([
				start(),
				update({ type: 'thinking_delta', contentIndex: 0, delta: 'Pl' }),
				update({ type: 'thinking_end', contentIndex: 0, content: 'Plan.' }),
				update({ type: 'text_delta', contentIndex: 1, delta: 'Answer.' }),
				update({ type: 'text_end', contentIndex: 1, content: 'Answer.' }),
				update({ type: 'text_start', contentIndex: 1 }),
				update({ type: 'start' }),
				end(),
			]),
		).toEqual([
			{ type: 'thinking', text: 'Pl', final: false },
			{ type: 'thinking', text: '', final: true },
			{ type: 'text', text: 'Answer.', final: false },
			{ type: 'text', text: '', final: true },
		]);
	});

	it('gives a whole block at its end when the stream sent no delta', () => {
		expect(
			all([start(), update({ type: 'text_end', contentIndex: 1, content: 'Answer.' }), end()]),
		).toEqual([
			{ type: 'text', text: 'Answer.', final: true },
			{ type: 'thinking', text: 'Plan.', final: true },
		]);
	});

	it('gives the blocks of an assistant message that streamed nothing, and no redacted thinking', () => {
		const redacted = fauxAssistantMessage([
			{ type: 'thinking', thinking: 'hidden', redacted: true },
			{ type: 'toolCall', id: 'c', name: 'say', arguments: {} },
		]);
		expect(all([start(), end(), start(redacted), end(redacted)])).toEqual([
			{ type: 'thinking', text: 'Plan.', final: true },
			{ type: 'text', text: 'Answer.', final: true },
		]);
	});

	it('gives nothing for a message that is not the assistant', () => {
		const user = { role: 'user', content: 'Hi.', timestamp: 0 } as const;
		expect(all([start(user as never), end(user as never)])).toEqual([]);
	});

	it('gives one usage step for each provider request', () => {
		expect(all([usage, usage])).toEqual([
			{ type: 'usage', input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.5 },
			{ type: 'usage', input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.5 },
		]);
	});

	it('gives a tool call and its result, and the text of a failed result', () => {
		const call = {
			type: 'tool_start',
			...at,
			turnId: 't',
			toolCallId: 'c1',
			toolName: 'book',
			args: { day: 'Friday' },
		} as HarnessEvent;
		const done = { content: [{ type: 'text', text: 'booked' }], details: {} };
		const refused = {
			content: [
				{ type: 'image', data: 'x', mimeType: 'image/png' },
				{ type: 'text', text: 'refused' },
			],
			details: {},
		};
		expect(
			all([
				call,
				toolEnd(done, false),
				toolEnd(refused, true),
				toolEnd({ content: [] }, true),
				toolEnd(undefined, true),
				{ type: 'turn_end', ...at } as HarnessEvent,
			]),
		).toEqual([
			{ type: 'tool_call', call: 'c1', name: 'book', input: { day: 'Friday' } },
			{ type: 'tool_result', call: 'c1', output: done },
			{ type: 'tool_result', call: 'c1', output: refused, error: 'refused' },
			{ type: 'tool_result', call: 'c1', output: { content: [] }, error: 'The tool failed.' },
			{ type: 'tool_result', call: 'c1', output: undefined, error: 'The tool failed.' },
		]);
	});
});
