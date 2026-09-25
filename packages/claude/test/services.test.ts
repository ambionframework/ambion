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

const permanent = { failed: true, cause: 'permanent' };

it.each([
	['a clean result as a pass that did not fail', { stop_reason: 'end_turn' }, { failed: false }],
	[
		'a max_tokens stop as a length stop',
		{ stop_reason: 'max_tokens' },
		{ failed: false, stop: 'length' },
	],
	[
		'a turn limit as a length stop',
		{ subtype: 'error_max_turns', is_error: true, errors: [] },
		{ failed: false, stop: 'length' },
	],
	[
		'a spent budget as a permanent failure',
		{ subtype: 'error_max_budget_usd', is_error: true, errors: ['Budget spent.'] },
		{ ...permanent, message: 'Budget spent.' },
	],
	[
		'a failed result as transient',
		{ is_error: true, result: 'API Error: 529 overloaded' },
		{ failed: true, cause: 'transient', message: 'API Error: 529 overloaded' },
	],
	[
		'a failed result as permanent when its status names a refusal',
		{ is_error: true, result: 'API Error: 401', api_error_status: 401 },
		{ ...permanent, message: 'API Error: 401' },
	],
	[
		'a failed result as permanent when its text names a refusal',
		{
			subtype: 'error_during_execution',
			is_error: true,
			errors: ['Your credit balance is too low'],
		},
		{ ...permanent, message: 'Your credit balance is too low' },
	],
	[
		'a spent usage limit as permanent, in the provider’s words',
		{
			is_error: true,
			result:
				'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}',
			api_error_status: 400,
		},
		{
			...permanent,
			message:
				'API Error: 400 invalid_request_error: You have reached your specified API usage limits.',
		},
	],
])('ends %s', (_what, fields, expected) => {
	expect(passResultOf(result(fields))).toEqual(expected);
});

it('reads a status only from a status, and never from free text', () => {
	expect(causeOf('rate limit: 400000 tokens per minute')).toBe('transient');
	expect(causeOf('bad request', 400)).toBe('permanent');
	expect(causeOf('overloaded', 529)).toBe('transient');
	expect(causeOf('invalid x-api-key')).toBe('permanent');
	expect(causeOf('You have reached your specified API usage limits.', 400)).toBe('permanent');
	expect(causeOf('Claude AI usage limit reached|1790380800', 429)).toBe('permanent');
	expect(causeOf('billing_error: add a payment method')).toBe('permanent');
	expect(causeOf('rate_limit_error: slow down', 429)).toBe('transient');
});
