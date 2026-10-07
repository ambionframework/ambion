/** The events of a conversation as trace steps: over events built by hand, and over a real pass. */
import { defineAgent, defineTool, type Step } from '@ambionframework/ambion';
import { callTool, quiet } from '@ambionframework/ambion/testing';
import { type AssistantMessage, fauxAssistantMessage, type Message } from '@earendil-works/pi-ai';
import type { AgentEvent, EntryRecord, UsageState } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { createPiOpener } from '../src/executor.ts';
import { memorySessions, pi, stubModel } from '../src/index.ts';
import { PiSteps, totalOf } from '../src/pi-trace.ts';
import { scriptedStream } from '../src/testing.ts';
import { stateOf } from './support/activation.ts';
import { viewOf } from './support/two-questions.ts';

const assistant: AssistantMessage = fauxAssistantMessage([
	{ type: 'thinking', thinking: 'Plan.' },
	{ type: 'text', text: 'Answer.' },
]);

const entry = (id: number, kind: string, message?: Message): EntryRecord =>
	({
		id,
		conversationId: 0,
		kind,
		...(message === undefined ? {} : { model: [message] }),
	}) as EntryRecord;

const start = (message: Message = assistant): AgentEvent => ({ type: 'message_start', message });
const end = (message: AssistantMessage = assistant): AgentEvent => ({
	type: 'message_end',
	entry: entry(1, 'pi.assistant', message),
});
const update = (
	...changes: Extract<AgentEvent, { type: 'message_update' }>['changes']
): AgentEvent => ({
	type: 'message_update',
	usage: assistant.usage,
	changes,
});

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const cost = (total: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total });
const spent = (input: number, output = 0, total = 0): AssistantMessage => ({
	...fauxAssistantMessage('Done.'),
	usage: { ...zero, input, output, totalTokens: input + output, cost: cost(total) },
});
const totals = (input: number, output: number, total: number): UsageState => ({
	models: {
		'scripted/x': { ...zero, input, output, totalTokens: input + output, cost: cost(total) },
	},
	tools: {},
});

const all = (events: AgentEvent[], baseline: UsageState = { models: {}, tools: {} }) => {
	const steps = new PiSteps(baseline);
	return events.flatMap((event) => steps.steps(event));
};

const noUsage = (steps: Step[]) => steps.filter((step) => step.type !== 'usage');

describe('the steps of conversation events', () => {
	it('gives streamed deltas, then a closing step with the rest of the block', () => {
		expect(
			noUsage(
				all([
					start(),
					update({
						type: 'thinking_start',
						contentIndex: 0,
						block: { type: 'thinking', thinking: '' },
					}),
					update({ type: 'thinking_delta', contentIndex: 0, delta: 'Pl' }),
					update({ type: 'text_start', contentIndex: 1, block: { type: 'text', text: '' } }),
					update({ type: 'text_delta', contentIndex: 1, delta: 'Answer.' }),
					end(),
				]),
			),
		).toEqual([
			{ type: 'thinking', text: 'Pl', final: false },
			{ type: 'text', text: 'Answer.', final: false },
			{ type: 'thinking', text: 'an.', final: true },
			{ type: 'text', text: '', final: true },
		]);
	});

	it('gives the unsent part of a block that arrives whole, and adds no block at the end', () => {
		expect(
			noUsage(
				all([
					start(),
					update({ type: 'block', contentIndex: 0, block: { type: 'thinking', thinking: 'Pl' } }),
					update({
						type: 'block',
						contentIndex: 0,
						block: { type: 'thinking', thinking: 'Plan.' },
					}),
					update({ type: 'block', contentIndex: 1, block: { type: 'text', text: 'Answer.' } }),
					update({ type: 'message', message: assistant }),
					end(),
				]),
			),
		).toEqual([
			{ type: 'thinking', text: 'Pl', final: false },
			{ type: 'thinking', text: 'an.', final: false },
			{ type: 'text', text: 'Answer.', final: false },
			{ type: 'thinking', text: '', final: true },
			{ type: 'text', text: '', final: true },
		]);
	});

	it('gives the whole message at its end when the stream sent nothing, and no redacted thinking', () => {
		const redacted = fauxAssistantMessage([
			{ type: 'thinking', thinking: 'hidden', redacted: true },
			{ type: 'toolCall', id: 'c', name: 'say', arguments: {} },
		]);
		expect(noUsage(all([start(), end(), start(redacted), end(redacted)]))).toEqual([
			{ type: 'thinking', text: 'Plan.', final: true },
			{ type: 'text', text: 'Answer.', final: true },
		]);
	});

	it('gives nothing for an entry that is not an assistant message', () => {
		const user: Message = { role: 'user', content: 'Hi.', timestamp: 0 };
		expect(
			all([
				start(user),
				{ type: 'message_end', entry: entry(2, 'pi.user', user) },
				{ type: 'message_end', entry: entry(3, 'pi.system') },
				{ type: 'turn_end' },
			]),
		).toEqual([]);
	});

	it('gives one usage step for each assistant message, a message with no spend among them', () => {
		expect(all([end(spent(10, 4, 0.5)), end(spent(0))])).toEqual([
			{ type: 'text', text: 'Done.', final: true },
			{ type: 'usage', input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
			{ type: 'text', text: 'Done.', final: true },
			{ type: 'usage', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		]);
	});

	it('gives the spend that no message accounts for once, and only what grew since the activation began', () => {
		const steps = new PiSteps(totals(100, 10, 1));
		// A request of 20 tokens is in the total at once, and a summary of 7 joins it.
		steps.steps(end(spent(20, 0, 0.25)));
		steps.steps({ type: 'usage_changed', usage: totals(127, 10, 1.3) });
		expect(steps.flush()).toEqual([
			{
				type: 'usage',
				input: 7,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: expect.closeTo(0.05),
			},
		]);
		expect(steps.flush()).toEqual([]);
		// A total that does not grow gives nothing, and a total below the baseline is no spend.
		steps.steps({ type: 'usage_changed', usage: totals(50, 0, 0) });
		expect(steps.flush()).toEqual([]);
		expect(totalOf(totals(5, 3, 0.1))).toEqual({
			input: 5,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.1,
		});
	});

	it('gives a tool call and its result, the text of a failed result, and the call of a result with no start', () => {
		const call = fauxAssistantMessage([
			{ type: 'toolCall', id: 'c2', name: 'book', arguments: { day: 'Monday' } },
		]);
		const result = (id: number, content: Message['content'], isError: boolean, details?: unknown) =>
			entry(id, 'pi.tool-result', {
				role: 'toolResult',
				toolCallId: 'c1',
				toolName: 'book',
				content,
				isError,
				timestamp: 0,
				...(details === undefined ? {} : { details }),
			} as Message);
		const text = [{ type: 'text', text: 'booked' }] as const;
		const refused = [
			{ type: 'image', data: 'x', mimeType: 'image/png' },
			{ type: 'text', text: 'refused' },
		] as const;
		expect(
			all([
				{
					type: 'tool_execution_start',
					toolCallId: 'c1',
					toolName: 'book',
					args: { day: 'Friday' },
				},
				{
					type: 'tool_execution_end',
					toolCallId: 'c1',
					toolName: 'book',
					entry: result(2, [...text], false, { n: 1 }),
				},
				{
					type: 'tool_execution_end',
					toolCallId: 'c1',
					toolName: 'book',
					entry: result(3, [...refused], true),
				},
				{ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'book' },
				end(call),
				{
					type: 'tool_execution_end',
					toolCallId: 'c2',
					toolName: 'book',
					entry: result(4, [...text], false),
				},
			]).filter((step) => step.type !== 'usage'),
		).toEqual([
			{ type: 'tool_call', call: 'c1', name: 'book', input: { day: 'Friday' } },
			{ type: 'tool_result', call: 'c1', output: { content: text, details: { n: 1 } } },
			{ type: 'tool_result', call: 'c1', output: { content: refused }, error: 'refused' },
			{ type: 'tool_result', call: 'c1', output: { content: [] }, error: 'The tool failed.' },
			{ type: 'tool_call', call: 'c2', name: 'book', input: { day: 'Monday' } },
			{ type: 'tool_result', call: 'c2', output: { content: text } },
		]);
	});

	it('remembers the last assistant message of the pass, until a new pass forgets it', () => {
		const steps = new PiSteps({ models: {}, tools: {} });
		expect(steps.last).toBeUndefined();
		steps.steps(end(spent(1)));
		expect(steps.last?.usage.input).toBe(1);
		steps.forget();
		expect(steps.last).toBeUndefined();
	});
});

describe('the steps of a real pass', () => {
	it('records the steps of a pass that calls a tool: the call, the result, the text, and the spend of each request', async () => {
		const book = defineTool({
			name: 'book',
			description: 'Book a day.',
			parameters: Type.Object({ day: Type.String() }),
			execute: ({ day }) => `booked ${day}`,
		});
		const definition = defineAgent({
			name: 'worker',
			identity: 'Works.',
			executor: pi({ instructions: 'Work.', model: 'scripted/worker', tools: [book] }),
		});
		const requests: number[] = [];
		const opener = createPiOpener({
			definition,
			model: stubModel,
			stream: scriptedStream((_context, _agent, request) => {
				requests.push(request);
				return request === 1 ? callTool('book', { day: 'Friday' }) : quiet();
			}),
			now: () => 0,
			sessions: memorySessions(),
		});
		const steps: Step[] = [];
		const session = stateOf(opener, definition, {
			trace: { record: (step) => void steps.push(step) },
		});
		const view = await viewOf('message:1:worker:1');
		await session.pass({ kind: 'view', view: { ...view, spec: { ...view.spec, seat: 'worker' } } });
		expect(steps.map((step) => step.type)).toEqual([
			'session',
			'usage',
			'tool_call',
			'tool_result',
			'text',
			'usage',
		]);
		expect(steps[0]).toEqual({
			type: 'session',
			name: 'pi',
			model: 'scripted/worker',
			session: 'message:1:worker:1',
			tools: expect.arrayContaining(['book', 'say']),
			servers: [],
		});
		expect(steps[2]).toMatchObject({ type: 'tool_call', name: 'book', input: { day: 'Friday' } });
		expect(steps[3]).toMatchObject({
			type: 'tool_result',
			output: { content: [{ type: 'text', text: 'booked Friday' }] },
		});
		expect(steps[4]).toMatchObject({ type: 'text', text: 'nothing to add', final: true });
	});
});
