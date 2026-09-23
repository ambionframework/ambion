/** Claude Agent SDK messages become the steps every executor family shares. */
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { ClaudeSteps, usageOf } from '../src/claude-trace.ts';

const wrap = (message: object) =>
	({ parent_tool_use_id: null, uuid: 'u', session_id: 's', ...message }) as unknown as SDKMessage;

const event = (body: object) => wrap({ type: 'stream_event', event: body });

const assistant = (id: string, content: object[]) =>
	wrap({ type: 'assistant', message: { id, role: 'assistant', content } });

const result = (fields: object) =>
	wrap({
		type: 'result',
		subtype: 'success',
		total_cost_usd: 0,
		modelUsage: {},
		...fields,
	});

const model = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadInputTokens: cacheRead,
	cacheCreationInputTokens: cacheWrite,
});

const run = (messages: SDKMessage[]) => {
	const steps = new ClaudeSteps();
	return messages.flatMap((message) => steps.steps(message));
};

/** One streamed block at `index`: its start, one delta for each piece, and its stop. */
const streamed = (index: number, kind: 'thinking' | 'text', pieces: string[]) => [
	event({ type: 'content_block_start', index, content_block: { type: kind } }),
	...pieces.map((piece) =>
		event({
			type: 'content_block_delta',
			index,
			delta:
				kind === 'text'
					? { type: 'text_delta', text: piece }
					: { type: 'thinking_delta', thinking: piece },
		}),
	),
	event({ type: 'content_block_stop', index }),
];

const toolResult = (id: string, text: string, isError?: boolean) =>
	wrap({
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: id,
					is_error: isError,
					content: [{ type: 'text', text }],
				},
			],
		},
	});

it('maps streamed text and thinking to deltas and a closing step, once', () => {
	expect(
		run([
			event({ type: 'message_start', message: { id: 'm1' } }),
			...streamed(0, 'thinking', ['Hm ', 'so.']),
			...streamed(1, 'text', ['Sat', 'urday.']),
			assistant('m1', [
				{ type: 'thinking', thinking: 'Hm so.' },
				{ type: 'text', text: 'Saturday.' },
			]),
		]),
	).toEqual([
		{ type: 'thinking', text: 'Hm ', final: false },
		{ type: 'thinking', text: 'so.', final: false },
		{ type: 'thinking', text: '', final: true },
		{ type: 'text', text: 'Sat', final: false },
		{ type: 'text', text: 'urday.', final: false },
		{ type: 'text', text: '', final: true },
	]);
});

it('gives a block the stream did not send whole, from the assistant message', () => {
	expect(
		run([
			assistant('m1', [
				{ type: 'thinking', thinking: 'Think.' },
				{ type: 'text', text: 'Done.' },
			]),
		]),
	).toEqual([
		{ type: 'thinking', text: 'Think.', final: true },
		{ type: 'text', text: 'Done.', final: true },
	]);
});

it('maps a tool use and its result, and shows a room tool without its server prefix', () => {
	const say = { type: 'tool_use', id: 't1', name: 'mcp__ambion__say', input: { text: 'x' } };
	expect(
		run([
			assistant('m1', [say]),
			assistant('m1', [say]),
			toolResult('t1', 'delivered'),
			assistant('m2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a' } }]),
			toolResult('t2', 'No such file.', true),
		]),
	).toEqual([
		{ type: 'tool_call', call: 't1', name: 'say', input: { text: 'x' } },
		{ type: 'tool_result', call: 't1', output: [{ type: 'text', text: 'delivered' }] },
		{ type: 'tool_call', call: 't2', name: 'Read', input: { file_path: 'a' } },
		{
			type: 'tool_result',
			call: 't2',
			output: [{ type: 'text', text: 'No such file.' }],
			error: 'No such file.',
		},
	]);
});

it('ignores the messages of a subagent and the echo of a plain user message', () => {
	expect(
		run([
			wrap({
				type: 'assistant',
				parent_tool_use_id: 'p',
				message: { id: 'm', content: [{ type: 'text', text: 'x' }] },
			}),
			wrap({
				type: 'user',
				isReplay: true,
				message: { role: 'user', content: 'When is the pour?' },
			}),
		]),
	).toEqual([]);
});

it('hands a call id to the handler of the tool the model called, in order', () => {
	const steps = new ClaudeSteps();
	steps.steps(
		assistant('m1', [{ type: 'tool_use', id: 't1', name: 'mcp__ambion__say', input: {} }]),
	);
	steps.steps(
		assistant('m2', [{ type: 'tool_use', id: 't2', name: 'mcp__ambion__say', input: {} }]),
	);
	expect(steps.claim('say')).toBe('t1');
	expect(steps.claim('say')).toBe('t2');
	expect(steps.claim('say')).toBeUndefined();
});

it('records what each result added to the running totals, and sums the models of one result', () => {
	const steps = new ClaudeSteps();
	const totals = (cost: number, usage: ReturnType<typeof model>) =>
		steps.steps(result({ total_cost_usd: cost, modelUsage: { a: usage } }));
	expect(totals(0.5, model(100, 20, 10, 5))).toEqual([
		{ type: 'usage', input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: 0.5 },
	]);
	expect(totals(0.75, model(150, 30, 10, 5))).toEqual([
		{ type: 'usage', input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
	]);
	expect(totals(0.75, model(150, 30, 10, 5))).toEqual([]);
	const { total } = usageOf(
		result({ modelUsage: { a: model(1, 2), b: model(3, 4) } }) as SDKResultMessage,
		undefined,
	);
	expect(total).toMatchObject({ input: 4, output: 6 });
});
