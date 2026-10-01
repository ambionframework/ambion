/**
 * The trace mapping and the usage count on events a real `codex` recorded.
 */
import type { Step } from '@ambionframework/ambion';
import type { ThreadEvent } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { CodexSteps, usageOf } from '../src/codex-trace.ts';
import { recorded } from './fixtures.ts';

function stepsOf(events: readonly ThreadEvent[]): Step[] {
	const steps = new CodexSteps('a');
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

it('starts a thread with an id, then a turn, and ends with a usage step above zero', () => {
	const [first, second] = recorded('plain-answer');
	expect(first).toMatchObject({ type: 'thread.started', thread_id: expect.any(String) });
	expect(second).toEqual({ type: 'turn.started' });
	const usage = stepsOf(recorded('plain-answer')).at(-1);
	expect(usage).toMatchObject({ type: 'usage', output: expect.any(Number) });
	expect((usage as { output: number }).output).toBeGreaterThan(0);
});
