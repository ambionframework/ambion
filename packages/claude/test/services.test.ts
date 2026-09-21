/** How a result of the SDK maps to a pass result. */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { causeOf, passResultOf } from '../src/services.ts';

const result = (fields: object) =>
	({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: '',
		...fields,
	}) as SDKResultMessage;

it('ends a clean result as a pass that did not fail', () => {
	expect(passResultOf(result({ stop_reason: 'end_turn' }))).toEqual({ failed: false });
});

it('ends a max_tokens stop and a turn limit as a length stop', () => {
	expect(passResultOf(result({ stop_reason: 'max_tokens' }))).toEqual({
		failed: false,
		stop: 'length',
	});
	expect(passResultOf(result({ subtype: 'error_max_turns', is_error: true, errors: [] }))).toEqual({
		failed: false,
		stop: 'length',
	});
});

it('ends a spent budget as a permanent failure', () => {
	expect(
		passResultOf(
			result({ subtype: 'error_max_budget_usd', is_error: true, errors: ['Budget spent.'] }),
		),
	).toEqual({ failed: true, cause: 'permanent', message: 'Budget spent.' });
});

it('ends a failed result as transient unless its text or status names a refusal', () => {
	expect(
		passResultOf(result({ is_error: true, result: 'API Error: 529 overloaded' })),
	).toMatchObject({
		failed: true,
		cause: 'transient',
	});
	expect(
		passResultOf(result({ is_error: true, result: 'API Error: 401', api_error_status: 401 })),
	).toMatchObject({ failed: true, cause: 'permanent' });
	expect(
		passResultOf(
			result({
				subtype: 'error_during_execution',
				is_error: true,
				errors: ['Your credit balance is too low'],
			}),
		),
	).toMatchObject({ failed: true, cause: 'permanent' });
});

it('reads a status only from a status, and never from free text', () => {
	expect(causeOf('rate limit: 400000 tokens per minute')).toBe('transient');
	expect(causeOf('bad request', 400)).toBe('permanent');
	expect(causeOf('overloaded', 529)).toBe('transient');
	expect(causeOf('invalid x-api-key')).toBe('permanent');
});
