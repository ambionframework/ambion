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

	it('reports the tokens of the request as the usage of the turn, with the cache inside the input', () => {
		const update = recorded('plain-answer').find(
			(note) => note.method === 'thread/tokenUsage/updated',
		);
		if (update?.method !== 'thread/tokenUsage/updated')
			throw new Error('The fixture has no usage.');
		const { last, total } = update.params.tokenUsage;
		// One request: the total of the thread equals the last request.
		expect(total).toEqual(last);
		const usage = stepsOf([update])[0];
		expect(usage).toMatchObject({ type: 'usage' });
		const counted = usage as { input: number; cacheRead: number; cacheWrite: number };
		expect(counted.input + counted.cacheRead + counted.cacheWrite).toBe(last.inputTokens);
	});
});

it('starts a turn, echoes the input with a client id, and ends the turn as completed', () => {
	const notes = recorded('plain-answer');
	expect(notes[0]?.method).toBe('turn/started');
	const echo = notes.find(
		(note) => note.method === 'item/completed' && note.params.item.type === 'userMessage',
	);
	expect(echo).toMatchObject({ params: { item: { clientId: expect.any(String) } } });
	const end = notes.at(-1);
	expect(end).toMatchObject({
		method: 'turn/completed',
		params: { turn: { status: 'completed' } },
	});
});
