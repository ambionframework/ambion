/**
 * The trace mapping and the usage count on notifications that a real
 * `codex app-server` recorded.
 */
import type { Step } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { CodexSteps } from '../src/codex-trace.ts';
import type { Notification } from '../src/protocol.ts';
import { recorded } from './fixtures.ts';

function stepsOf(notes: readonly Notification[]): Step[] {
	const steps = new CodexSteps('a');
	return notes.flatMap((note) => steps.steps(note));
}

describe('a plain answer', () => {
	it('gives one closing thinking step, one closing text step, and one usage step', () => {
		expect(stepsOf(recorded('plain-answer'))).toEqual([
			{ type: 'thinking', text: 'Add the two numbers.', final: true },
			{ type: 'text', text: '2 plus 2 equals 4.', final: true },
			{ type: 'usage', input: 100, output: 30, cacheRead: 20, cacheWrite: 0 },
		]);
	});
});
