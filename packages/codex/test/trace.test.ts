/** Codex thread events as trace steps, and the end of a Codex turn as a pass result. */
import type { Step } from '@ambionframework/ambion';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { CodexSteps, NOTICE_CHARS, usageOf } from '../src/codex-trace.ts';
import { causeOf, passResultOf } from '../src/failure.ts';

const started = (item: ThreadItem): ThreadEvent => ({ type: 'item.started', item });
const updated = (item: ThreadItem): ThreadEvent => ({ type: 'item.updated', item });
const completed = (item: ThreadItem): ThreadEvent => ({ type: 'item.completed', item });

/** Every step of a list of events of the activation `a`, in order. */
function stepsOf(...events: ThreadEvent[]): Step[] {
	const steps = new CodexSteps('a');
	return events.flatMap((event) => steps.steps(event));
}

/** The id of the steps of item `id` in turn `turn` of the activation `a`. */
const idOf = (id: string, turn = 0) => `a:${turn}:${id}`;

describe('text and thinking', () => {
	it('sends the growth of a message as deltas, then a closing step, and a message that arrives whole as one closing step', () => {
		const item = { id: 'm1', type: 'agent_message' as const };
		expect(
			stepsOf(
				started({ ...item, text: '' }),
				updated({ ...item, text: 'The pour' }),
				updated({ ...item, text: 'The pour is Saturday' }),
				completed({ ...item, text: 'The pour is Saturday.' }),
			),
		).toEqual([
			{ type: 'text', text: 'The pour', final: false },
			{ type: 'text', text: ' is Saturday', final: false },
			{ type: 'text', text: '.', final: false },
			{ type: 'text', text: '', final: true },
		]);
		expect(stepsOf(completed({ id: 'm1', type: 'agent_message', text: 'Done.' }))).toEqual([
			{ type: 'text', text: 'Done.', final: true },
		]);
	});

	it('maps reasoning to thinking', () => {
		expect(
			stepsOf(
				updated({ id: 'r1', type: 'reasoning', text: 'Check the log' }),
				completed({ id: 'r1', type: 'reasoning', text: 'Check the log' }),
			),
		).toEqual([
			{ type: 'thinking', text: 'Check the log', final: false },
			{ type: 'thinking', text: '', final: true },
		]);
	});
});

describe('tools', () => {
	it('shows a tool of another server with its server, and marks a failed call', () => {
		const call = {
			id: 't1',
			type: 'mcp_tool_call' as const,
			server: 'lab',
			tool: 'lookup',
			arguments: { id: 'r1' },
		};
		expect(
			stepsOf(
				started({ ...call, status: 'in_progress' }),
				completed({ ...call, status: 'failed', error: { message: 'No such record.' } }),
			),
		).toMatchObject([
			{ type: 'tool_call', name: 'lab__lookup' },
			{ type: 'tool_result', error: 'No such record.' },
		]);
	});

	it('shows a room tool by its plain name', () => {
		const steps = new CodexSteps('a');
		const call = {
			id: 's1',
			type: 'mcp_tool_call' as const,
			server: 'ambion',
			tool: 'say',
			arguments: { text: 'Hi' },
		};
		expect(steps.steps(started({ ...call, status: 'in_progress' }))).toMatchObject([
			{ type: 'tool_call', name: 'say' },
		]);
	});
});

describe('diagnostics', () => {
	it.each([
		['command_execution', { command: 'ls', aggregated_output: '', status: 'completed' }],
		['file_change', { changes: [{ path: '/work/a.md', kind: 'add' }], status: 'completed' }],
		['web_search', { query: 'pour schedule' }],
		['todo_list', { items: [{ text: 'Read the log', completed: true }] }],
	] as const)(
		'maps a completed %s item, which a seat has no tool for, to a warning notice that names it',
		(type, fields) => {
			const item = { id: 'n1', type, ...fields } as ThreadItem;
			expect(stepsOf(started(item), updated(item))).toEqual([]);
			expect(stepsOf(completed(item))).toEqual([
				{
					type: 'notice',
					level: 'warning',
					text: `Codex reported a native ${type} item. A seat has no native tools.`,
				},
			]);
		},
	);

	it('maps an error item and a non-terminal error event to a warning notice', () => {
		const text = 'Codex is ignoring 1 unrecognized configuration setting.';
		expect(
			stepsOf(completed({ id: 'e1', type: 'error', message: text }), {
				type: 'error',
				message: 'Reconnecting... 1/5',
			}),
		).toEqual([
			{ type: 'notice', level: 'warning', text },
			{ type: 'notice', level: 'warning', text: 'Reconnecting... 1/5' },
		]);
		expect(stepsOf(started({ id: 'e1', type: 'error', message: text }))).toEqual([]);
		const long = 'x'.repeat(NOTICE_CHARS + 5);
		expect(stepsOf({ type: 'error', message: long })).toEqual([
			{ type: 'notice', level: 'warning', text: `${'x'.repeat(NOTICE_CHARS)} [5 more characters]` },
		]);
	});

	it('maps the terminal failure of a turn to no step, because the pass result carries it', () => {
		expect(stepsOf({ type: 'turn.failed', error: { message: 'unexpected status 401' } })).toEqual(
			[],
		);
	});
});

it('gives each turn its own ids, though codex numbers the items of each turn again', () => {
	const say = { id: 'item_1', type: 'mcp_tool_call' as const, server: 'ambion', tool: 'say' };
	const turn = (text: string): ThreadEvent[] => [
		{ type: 'turn.started' },
		started({ ...say, arguments: { text }, status: 'in_progress' }),
		completed({ ...say, arguments: { text }, status: 'completed' }),
	];
	const steps = stepsOf(...turn('One.'), ...turn('Two.'));
	expect(steps.flatMap((step) => (step.type === 'tool_call' ? [step.call] : []))).toEqual([
		idOf('item_1', 1),
		idOf('item_1', 2),
	]);
});

describe('usage', () => {
	it('maps the usage of a turn to tokens, and reports no cost', () => {
		const [step] = stepsOf({
			type: 'turn.completed',
			usage: {
				input_tokens: 130,
				cached_input_tokens: 10,
				cache_write_input_tokens: 5,
				output_tokens: 30,
				reasoning_output_tokens: 0,
			},
		});
		expect(step).toEqual({ type: 'usage', input: 115, output: 30, cacheRead: 10, cacheWrite: 5 });
		expect(usageOf({ input_tokens: 1, cached_input_tokens: 4, output_tokens: 0 }).input).toBe(0);
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
