/** App-server notifications as trace steps, and the end of a Codex turn as a pass result. */
import type { Step } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { CodexSteps, NOTICE_CHARS, sessionStep, usageOf } from '../src/codex-trace.ts';
import { causeOf, passResultOf, turnFailure } from '../src/failure.ts';
import { type Notification, notificationOf, type ThreadItem } from '../src/protocol.ts';

/** A notification of the thread `t` in the turn `u1`. */
function note(method: string, params: object): Notification {
	const found = notificationOf(method, { threadId: 't', turnId: 'u1', ...params });
	if (found === undefined) throw new Error(`${method} is not a notification the executor reads.`);
	return found;
}

const started = (item: object) => note('item/started', { item });
const completed = (item: object) => note('item/completed', { item });
const delta = (itemId: string, text: string) =>
	note('item/agentMessage/delta', { itemId, delta: text });

/** Every step of a list of notifications of the activation `a`, in order. */
function stepsOf(...notes: Notification[]): Step[] {
	const steps = new CodexSteps('a');
	return notes.flatMap((one) => steps.steps(one));
}

/** The id of the steps of item `id` in turn `u1` of the activation `a`. */
const idOf = (id: string) => `a:u1:${id}`;

describe('text and thinking', () => {
	it('sends the growth of a message as deltas, then a closing step, and a message that arrives whole as one closing step', () => {
		const item = { id: 'm1', type: 'agentMessage' };
		expect(
			stepsOf(
				started({ ...item, text: '' }),
				delta('m1', 'The pour'),
				delta('m1', ' is Saturday'),
				completed({ ...item, text: 'The pour is Saturday.' }),
			),
		).toEqual([
			{ type: 'text', text: 'The pour', final: false },
			{ type: 'text', text: ' is Saturday', final: false },
			{ type: 'text', text: '.', final: false },
			{ type: 'text', text: '', final: true },
		]);
		expect(stepsOf(completed({ id: 'm2', type: 'agentMessage', text: 'Done.' }))).toEqual([
			{ type: 'text', text: 'Done.', final: true },
		]);
		expect(stepsOf(completed({ id: 'm3', type: 'agentMessage', text: '' }))).toEqual([]);
	});

	it('maps the summary of reasoning to thinking, and starts each part after a blank line', () => {
		const part = (text: string, summaryIndex: number) =>
			note('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: text, summaryIndex });
		expect(
			stepsOf(
				part('Check the log', 0),
				part('Then the plan', 1),
				completed({ id: 'r1', type: 'reasoning', summary: ['Check the log', 'Then the plan'] }),
			),
		).toEqual([
			{ type: 'thinking', text: 'Check the log', final: false },
			{ type: 'thinking', text: '\n\nThen the plan', final: false },
			{ type: 'thinking', text: '', final: true },
		]);
		expect(stepsOf(completed({ id: 'r2', type: 'reasoning', summary: ['One', 'Two'] }))).toEqual([
			{ type: 'thinking', text: 'One\n\nTwo', final: true },
		]);
		expect(stepsOf(completed({ id: 'r3', type: 'reasoning', summary: [] }))).toEqual([]);
	});
});

describe('tools', () => {
	const call = {
		id: 'call_1',
		type: 'dynamicToolCall',
		namespace: null,
		tool: 'say',
		arguments: { text: 'Hi' },
	};

	it('shows a room tool by its plain name, and ties the result to the call', () => {
		expect(
			stepsOf(
				started({ ...call, status: 'inProgress', contentItems: null, success: null }),
				completed({
					...call,
					status: 'completed',
					contentItems: [{ type: 'inputText', text: 'said #2' }],
					success: true,
				}),
			),
		).toEqual([
			{ type: 'tool_call', call: idOf('call_1'), name: 'say', input: { text: 'Hi' } },
			{
				type: 'tool_result',
				call: idOf('call_1'),
				output: [{ type: 'text', text: 'said #2' }],
			},
		]);
	});

	it('shows a tool of a namespace with its namespace, and marks a failed call with its text', () => {
		const other = { ...call, namespace: 'lab', tool: 'lookup' };
		expect(
			stepsOf(
				started({ ...other, status: 'inProgress', contentItems: null, success: null }),
				completed({
					...other,
					status: 'failed',
					contentItems: [{ type: 'inputText', text: 'No such record.' }],
					success: false,
				}),
			),
		).toMatchObject([
			{ type: 'tool_call', name: 'lab__lookup' },
			{ type: 'tool_result', error: 'No such record.' },
		]);
		expect(
			stepsOf(completed({ ...call, status: 'failed', contentItems: null, success: false })),
		).toMatchObject([{ type: 'tool_call' }, { type: 'tool_result', error: 'The tool failed.' }]);
	});

	it('gives a completed item with no start the call step too, once', () => {
		const steps = new CodexSteps('a');
		const done = completed({ ...call, status: 'completed', contentItems: [], success: true });
		expect(steps.steps(done).map((step) => step.type)).toEqual(['tool_call', 'tool_result']);
		expect(steps.steps(done).map((step) => step.type)).toEqual(['tool_result']);
	});

	it('keeps an image as data, and an image at a URL as a URL', () => {
		const [, result] = stepsOf(
			completed({
				...call,
				status: 'completed',
				contentItems: [
					{ type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' },
					{ type: 'inputImage', imageUrl: 'https://example.com/a.png' },
				],
				success: true,
			}),
		);
		expect(result).toMatchObject({
			output: [
				{ type: 'image', mimeType: 'image/png', data: 'AAAA' },
				{ type: 'image', url: 'https://example.com/a.png' },
			],
		});
	});
});

describe('diagnostics', () => {
	it.each([
		['commandExecution', { command: 'ls', status: 'completed' }],
		['fileChange', { changes: [], status: 'completed' }],
		['webSearch', { query: 'pour schedule' }],
		['imageGeneration', { status: 'completed' }],
	])(
		'maps a completed %s item, which a seat has no tool for, to a warning notice that names it',
		(type, fields) => {
			const item = { id: 'n1', type, ...fields };
			expect(stepsOf(started(item))).toEqual([]);
			expect(stepsOf(completed(item))).toEqual([
				{
					type: 'notice',
					level: 'warning',
					text: `Codex reported a native ${type} item. A seat has no native tools.`,
				},
			]);
		},
	);

	it('maps a user message to nothing', () => {
		const item: ThreadItem = { id: 'u', type: 'userMessage' };
		expect(stepsOf(started(item), completed(item))).toEqual([]);
	});

	it('maps a warning, a config warning, a deprecation notice, and an error that Codex retries to a warning notice', () => {
		const text = 'Codex is ignoring 1 unrecognized configuration setting.';
		expect(
			stepsOf(
				note('warning', { message: text }),
				note('configWarning', { summary: 'Unknown key.', details: 'ambion_unknown_setting' }),
				note('deprecationNotice', { summary: 'Old flag.', details: null }),
				note('error', { error: { message: 'Reconnecting... 1/5' }, willRetry: true }),
			),
		).toEqual([
			{ type: 'notice', level: 'warning', text },
			{ type: 'notice', level: 'warning', text: 'Unknown key. ambion_unknown_setting' },
			{ type: 'notice', level: 'warning', text: 'Old flag.' },
			{ type: 'notice', level: 'warning', text: 'Reconnecting... 1/5' },
		]);
		const long = 'x'.repeat(NOTICE_CHARS + 5);
		expect(stepsOf(note('warning', { message: long }))).toEqual([
			{ type: 'notice', level: 'warning', text: `${'x'.repeat(NOTICE_CHARS)} [5 more characters]` },
		]);
	});

	it('keeps a warning once, because Codex reports it again when it opens a thread', () => {
		const warn = () => note('configWarning', { summary: 'Unknown key.', details: null });
		expect(stepsOf(warn(), warn())).toEqual([
			{ type: 'notice', level: 'warning', text: 'Unknown key.' },
		]);
	});

	it('maps the terminal failure of a turn to no step, because the pass result carries it', () => {
		expect(
			stepsOf(note('error', { error: { message: 'unexpected status 401' }, willRetry: false })),
		).toEqual([]);
	});

	it('ignores a method the executor does not read', () => {
		expect(notificationOf('account/rateLimits/updated', {})).toBeUndefined();
	});
});

it('gives each turn its own ids, though two turns can hold the same item id', () => {
	const call = {
		id: 'call_1',
		type: 'dynamicToolCall',
		namespace: null,
		tool: 'say',
		arguments: {},
	};
	const turn = (id: string) =>
		notificationOf('item/started', {
			threadId: 't',
			turnId: id,
			item: { ...call, status: 'inProgress', contentItems: null, success: null },
		});
	const steps = new CodexSteps('a');
	const calls = [turn('u1'), turn('u2')].flatMap((one) => (one ? steps.steps(one) : []));
	expect(calls.flatMap((step) => (step.type === 'tool_call' ? [step.call] : []))).toEqual([
		'a:u1:call_1',
		'a:u2:call_1',
	]);
});

describe('usage', () => {
	const tokens = {
		totalTokens: 160,
		inputTokens: 130,
		cachedInputTokens: 10,
		cacheWriteInputTokens: 5,
		outputTokens: 30,
		reasoningOutputTokens: 0,
	};

	it('maps the tokens of one model request, and reports no cost', () => {
		const [step] = stepsOf(
			note('thread/tokenUsage/updated', { tokenUsage: { total: tokens, last: tokens } }),
		);
		expect(step).toEqual({ type: 'usage', input: 115, output: 30, cacheRead: 10, cacheWrite: 5 });
		expect(
			usageOf({ ...tokens, inputTokens: 1, cachedInputTokens: 4, cacheWriteInputTokens: 0 }).input,
		).toBe(0);
	});

	it('counts the last request and not the thread total', () => {
		const total = { ...tokens, inputTokens: 500, outputTokens: 90 };
		const [step] = stepsOf(
			note('thread/tokenUsage/updated', { tokenUsage: { total, last: tokens } }),
		);
		expect(step).toMatchObject({ output: 30 });
	});
});

describe('the session step', () => {
	it('holds the thread, the policy, the tools, and the servers', () => {
		expect(
			sessionStep(
				{
					thread: { id: 't', path: '/home/rollout.jsonl', cliVersion: '0.160.1' },
					model: 'gpt-5.6-luna',
					cwd: '/work',
					approvalPolicy: 'never',
					sandbox: { type: 'readOnly' },
				},
				{ auth: undefined, tools: ['say'], servers: [{ name: 'node_repl', status: 'disabled' }] },
			),
		).toEqual({
			type: 'session',
			name: 'codex',
			version: '0.160.1',
			model: 'gpt-5.6-luna',
			cwd: '/work',
			session: 't',
			permissionMode: 'never, readOnly',
			tools: ['say'],
			servers: [{ name: 'node_repl', status: 'disabled' }],
		});
	});
});

it.each([
	// The status comes from the text when the text names one.
	['unexpected status 403 Forbidden', undefined, 'permanent'],
	['stream error: 529 overloaded_error: try again later', undefined, 'transient'],
	// The caller can give a status.
	['The request failed.', 403, 'permanent'],
	['The request failed.', 500, 'transient'],
	['The request failed.', null, 'transient'],
] as const)('causeOf names %j with status %s %s', (text, status, cause) => {
	expect(causeOf(text, status)).toBe(cause);
});

it.each([
	['a clean turn as no failure', undefined, { failed: false }],
	[
		'a full context window as a length stop',
		'Codex ran out of room in the model context window.',
		{ failed: false, stop: 'length' },
	],
	[
		'an authentication refusal as a permanent failure',
		'unexpected status 401 Unauthorized',
		{ failed: true, cause: 'permanent', message: 'unexpected status 401 Unauthorized' },
	],
	[
		'an overloaded provider as a transient failure',
		'stream error: 529 overloaded_error',
		{ failed: true, cause: 'transient', message: 'stream error: 529 overloaded_error' },
	],
	[
		'a spent quota as a permanent failure, in the provider’s words',
		'unexpected status 429: {"error":{"message":"You exceeded your current quota.","type":"insufficient_quota"}}',
		{
			failed: true,
			cause: 'permanent',
			message: 'unexpected status 429: insufficient_quota: You exceeded your current quota.',
		},
	],
])('passResultOf reports %s', (_what, error, expected) => {
	expect(passResultOf(error)).toEqual(expected);
});

it.each([
	['no error', undefined, { failed: true, cause: 'transient', message: 'The Codex pass failed.' }],
	[
		'a status in the error info',
		{
			message: 'The request failed.',
			codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
		},
		{ failed: true, cause: 'permanent', message: 'The request failed.' },
	],
	[
		'an error info with no status',
		{ message: 'The request failed.', codexErrorInfo: 'internalServerError' },
		{ failed: true, cause: 'transient', message: 'The request failed.' },
	],
] as const)('turnFailure reports %s', (_what, error, expected) => {
	expect(turnFailure(error)).toEqual(expected);
});
