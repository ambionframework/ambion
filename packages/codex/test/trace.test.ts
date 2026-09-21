/** Codex thread events as trace steps. */
import type { Step } from '@ambionframework/ambion';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { CodexSteps, changedPaths, isRoomTool, usageOf } from '../src/codex-trace.ts';

const started = (item: ThreadItem): ThreadEvent => ({ type: 'item.started', item });
const updated = (item: ThreadItem): ThreadEvent => ({ type: 'item.updated', item });
const completed = (item: ThreadItem): ThreadEvent => ({ type: 'item.completed', item });

/** Every step of a list of events, in order. */
function stepsOf(...events: ThreadEvent[]): Step[] {
	const steps = new CodexSteps();
	return events.flatMap((event) => steps.steps(event));
}

describe('text and thinking', () => {
	it('sends the growth of a message as deltas, then a closing step', () => {
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
	});

	it('sends a message that arrives whole as one closing step', () => {
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
	it('maps a command to a call and a result', () => {
		const command = {
			id: 'c1',
			type: 'command_execution' as const,
			command: 'ls',
			aggregated_output: '',
		};
		expect(
			stepsOf(
				started({ ...command, status: 'in_progress' }),
				completed({ ...command, aggregated_output: 'a.txt', exit_code: 0, status: 'completed' }),
			),
		).toEqual([
			{ type: 'tool_call', call: 'c1', name: 'command', input: { command: 'ls' } },
			{ type: 'tool_result', call: 'c1', output: { output: 'a.txt', exitCode: 0 } },
		]);
	});

	it('marks a failed command as an error', () => {
		const steps = stepsOf(
			completed({
				id: 'c1',
				type: 'command_execution',
				command: 'false',
				aggregated_output: '',
				exit_code: 1,
				status: 'failed',
			}),
		);
		expect(steps).toMatchObject([
			{ type: 'tool_call', call: 'c1' },
			{ type: 'tool_result', call: 'c1', error: 'The command failed with exit code 1.' },
		]);
	});

	it('gives a file change both steps when it arrives only at its end', () => {
		const changes = [{ path: '/work/a.md', kind: 'update' as const }];
		expect(
			stepsOf(completed({ id: 'f1', type: 'file_change', changes, status: 'completed' })),
		).toEqual([
			{ type: 'tool_call', call: 'f1', name: 'file_change', input: { changes } },
			{ type: 'tool_result', call: 'f1', output: changes },
		]);
	});

	it('maps a web search', () => {
		expect(
			stepsOf(
				started({ id: 'w1', type: 'web_search', query: 'pour schedule' }),
				completed({ id: 'w1', type: 'web_search', query: 'pour schedule' }),
			),
		).toMatchObject([
			{ type: 'tool_call', name: 'web_search', input: { query: 'pour schedule' } },
			{ type: 'tool_result', call: 'w1' },
		]);
	});

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

	it('shows a room tool by its plain name and lets the executor claim its id', () => {
		const steps = new CodexSteps();
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
		expect(steps.claim('say')).toBe('s1');
		expect(steps.claim('say')).toBeUndefined();
		expect(isRoomTool('say') && isRoomTool('seat') && isRoomTool('unseat')).toBe(true);
		expect(isRoomTool('lookup')).toBe(false);
	});
});

describe('usage and paths', () => {
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

	it('reports the paths of a completed patch only', () => {
		const changes = [{ path: '/work/a.md', kind: 'add' as const }];
		const patch = (status: 'completed' | 'failed') =>
			completed({ id: 'f', type: 'file_change', changes, status });
		expect(changedPaths(patch('completed'))).toEqual(['/work/a.md']);
		expect(changedPaths(patch('failed'))).toEqual([]);
		expect(changedPaths({ type: 'turn.started' })).toEqual([]);
	});
});
