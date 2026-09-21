/** The trace mapping, the usage count and the changed paths, on events a real `codex` recorded. */
import type { Step } from '@ambionframework/ambion';
import type { ThreadEvent } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { CodexSteps, changedPaths, usageOf } from '../src/codex-trace.ts';
import { recorded } from './fixtures.ts';

const RUNS = ['plain-answer', 'shell-command', 'file-change'] as const;

function stepsOf(events: readonly ThreadEvent[]): Step[] {
	const steps = new CodexSteps();
	return events.flatMap((event) => steps.steps(event));
}

describe('a plain answer', () => {
	it('gives one closing text step and one usage step', () => {
		expect(stepsOf(recorded('plain-answer'))).toEqual([
			{ type: 'text', text: '2 plus 2 equals 4.', final: true },
			{ type: 'usage', input: 3, output: 12, cacheRead: 0, cacheWrite: 12384 },
		]);
	});

	it('counts the cache writes once', () => {
		// The turn reports 12387 input tokens, and 12384 of them are cache writes.
		const turn = recorded('plain-answer').find((event) => event.type === 'turn.completed');
		if (turn?.type !== 'turn.completed') throw new Error('The fixture has no turn.completed.');
		const usage = usageOf(turn.usage);
		expect(usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)).toBe(
			turn.usage.input_tokens,
		);
	});
});

describe('a shell command', () => {
	it('gives a call when the command starts and a result when it ends', () => {
		const steps = stepsOf(recorded('shell-command'));
		expect(steps.slice(0, 2)).toEqual([
			{
				type: 'tool_call',
				call: 'item_0',
				name: 'command',
				input: { command: "/bin/zsh -lc 'echo hello-from-codex'" },
			},
			{
				type: 'tool_result',
				call: 'item_0',
				output: { output: 'hello-from-codex\n', exitCode: 0 },
			},
		]);
		expect(steps[2]).toEqual({
			type: 'text',
			text: 'It printed `hello-from-codex`.',
			final: true,
		});
	});

	it('counts the usage of the turn', () => {
		expect(stepsOf(recorded('shell-command')).at(-1)).toEqual({
			type: 'usage',
			input: 6,
			output: 80,
			cacheRead: 12399,
			cacheWrite: 12495,
		});
	});
});

describe('a file change', () => {
	const path = '/tmp/codex-cap/file-change/note.txt';

	it('gives a call and a result that carry the changes', () => {
		const changes = [{ path, kind: 'add' }];
		const steps = stepsOf(recorded('file-change'));
		expect(
			steps.filter((step) => step.type === 'tool_call' || step.type === 'tool_result'),
		).toEqual([
			{ type: 'tool_call', call: 'item_1', name: 'file_change', input: { changes } },
			{ type: 'tool_result', call: 'item_1', output: changes },
		]);
	});

	it('reports the changed path once the patch completes, and not before', () => {
		const events = recorded('file-change');
		const reported = events.map((event) => changedPaths(event));
		expect(reported.flat()).toEqual([path]);
		const started = events.findIndex((event) => event.type === 'item.started');
		expect(reported[started]).toEqual([]);
	});
});

describe('every recorded run', () => {
	it.each(RUNS)('%s starts a thread with an id, then a turn', (name) => {
		const [first, second] = recorded(name);
		expect(first).toMatchObject({ type: 'thread.started', thread_id: expect.any(String) });
		expect(second).toEqual({ type: 'turn.started' });
	});

	it.each(RUNS)('%s ends with a usage step above zero', (name) => {
		const usage = stepsOf(recorded(name)).at(-1);
		expect(usage).toMatchObject({ type: 'usage', output: expect.any(Number) });
		expect((usage as { output: number }).output).toBeGreaterThan(0);
	});
});
