/** Claude Agent SDK messages become the steps every executor kind shares. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { ClaudeSteps } from '../src/claude-trace.ts';

const wrap = (message: object) =>
	({ parent_tool_use_id: null, uuid: 'u', session_id: 's', ...message }) as unknown as SDKMessage;

const event = (body: object) => wrap({ type: 'stream_event', event: body });

const assistant = (id: string, content: object[], usage?: object) =>
	wrap({ type: 'assistant', message: { id, role: 'assistant', content, usage } });

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

/** The `usage` of a model request, in the field names of the provider. */
const used = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: cacheWrite,
});

const messageStart = (id: string, usage: object) =>
	event({ type: 'message_start', message: { id, usage } });

const messageDelta = (outputTokens: number) =>
	event({
		type: 'message_delta',
		delta: { stop_reason: 'end_turn' },
		usage: { output_tokens: outputTokens },
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

it('gives each top-level model request one usage step, before its tool results and the next request', () => {
	const text = [{ type: 'text', text: 'Saturday.' }];
	const call = { type: 'tool_use', id: 't1', name: 'Read', input: {} };
	expect(
		run([
			messageStart('m1', used(100, 1, 10, 5)),
			...streamed(0, 'text', ['Saturday.']),
			messageDelta(20),
			assistant('m1', text, used(100, 1, 10, 5)),
			assistant('m1', [call], used(100, 1, 10, 5)),
			toolResult('t1', 'ok'),
			messageStart('m2', used(150, 1, 110)),
			...streamed(0, 'text', ['Done.']),
			messageDelta(7),
			assistant('m2', [{ type: 'text', text: 'Done.' }], used(150, 1, 110)),
			result({ total_cost_usd: 0.5, modelUsage: { a: model(260, 30, 120, 5) } }),
		]),
	).toEqual([
		{ type: 'text', text: 'Saturday.', final: false },
		{ type: 'text', text: '', final: true },
		{ type: 'tool_call', call: 't1', name: 'Read', input: {} },
		{ type: 'usage', input: 100, output: 20, cacheRead: 10, cacheWrite: 5 },
		{ type: 'tool_result', call: 't1', output: [{ type: 'text', text: 'ok' }] },
		{ type: 'text', text: 'Done.', final: false },
		{ type: 'text', text: '', final: true },
		{ type: 'usage', input: 160, output: 10, cacheRead: 110, cacheWrite: 0, cost: 0.5 },
	]);
});

it('takes a request from the assistant message when the stream did not send it', () => {
	expect(
		run([
			assistant('m1', [{ type: 'text', text: 'A' }], used(10, 2)),
			assistant('m2', [{ type: 'text', text: 'B' }], used(20, 3)),
			result({ total_cost_usd: 0.1, modelUsage: { a: model(30, 5) } }),
		]),
	).toEqual([
		{ type: 'text', text: 'A', final: true },
		{ type: 'usage', input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
		{ type: 'text', text: 'B', final: true },
		{ type: 'usage', input: 20, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
	]);
});

it('starts each pass of one session with no pending request and no emitted tokens', () => {
	const steps = new ClaudeSteps();
	const pass = (requests: [id: string, input: number][], cost: number, usage: object) =>
		[
			...requests.map(([id, input]) => assistant(id, [], used(input, 1))),
			result({ total_cost_usd: cost, modelUsage: { a: usage } }),
		].flatMap((message) => steps.steps(message));
	expect(
		pass(
			[
				['m1', 10],
				['m2', 10],
			],
			0.25,
			model(30, 5),
		),
	).toEqual([
		{ type: 'usage', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
		{ type: 'usage', input: 20, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
	]);
	expect(pass([['m3', 5]], 0.75, model(40, 8))).toEqual([
		{ type: 'usage', input: 10, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
	]);
	expect(pass([], 0, model(0, 0))).toEqual([]);
});

it('emits no step for a request or a result that used nothing', () => {
	expect(
		run([
			assistant('m1', [], used(0, 0)),
			assistant('m2', [], used(0, 0)),
			result({ modelUsage: { a: model(0, 0) } }),
		]),
	).toEqual([]);
});

it('adds the usage of a subagent through the result, and never to the pending request', () => {
	const steps = run([
		messageStart('m1', used(1, 1)),
		wrap({
			type: 'assistant',
			parent_tool_use_id: 'p',
			message: { id: 'm9', content: [], usage: used(999, 999) },
		}),
		wrap({ type: 'stream_event', parent_tool_use_id: 'p', event: messageDelta(999) }),
		result({ modelUsage: { a: model(8, 4) } }),
	]);
	expect(steps).toEqual([
		{ type: 'usage', input: 8, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0 },
	]);
});

it('records what each result added to the running totals, and sums the models of one result', () => {
	const steps = new ClaudeSteps();
	const totals = (cost: number, ...usage: ReturnType<typeof model>[]) =>
		steps.steps(
			result({ total_cost_usd: cost, modelUsage: Object.fromEntries(usage.map((u, i) => [i, u])) }),
		);
	expect(totals(0.5, model(100, 20, 10, 5))).toEqual([
		{ type: 'usage', input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: 0.5 },
	]);
	expect(totals(0.75, model(100, 20, 10, 5), model(50, 10))).toEqual([
		{ type: 'usage', input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.25 },
	]);
	expect(totals(0.75, model(100, 20, 10, 5), model(50, 10))).toEqual([]);
});
