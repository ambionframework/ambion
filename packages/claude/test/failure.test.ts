/** How a result of the SDK maps to a pass result. */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { STDERR_TAIL } from '../src/executor.ts';
import { passResultOf } from '../src/failure.ts';
import { open, viewOf } from './support.ts';

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

it.each([
	{ what: 'ends with no result', code: 0 },
	{ what: 'exits with an error', code: 1 },
])(
	'puts the end of the standard error in the message of a pass when the process $what, and keeps the cause transient',
	async ({ code }) => {
		// The line holds a word that the shared classifier reads as a refusal. Only the original error classifies.
		const line = 'FATAL: 401 authentication_error from the proxy';
		const flood = 'x'.repeat(STDERR_TAIL * 2);
		const run = open({ turns: [[{ crash: { stderr: `${flood}\n${line}`, code } }]] });
		const result = await run.session.pass({ kind: 'view', view: viewOf() });
		run.session.close?.();
		expect(result).toMatchObject({ failed: true, cause: 'transient' });
		expect(result.message).toContain(line);
		expect(result.message).toContain('The standard error of the process ended with:');
		// The tail holds at most the last characters, so the flood does not fill the message.
		expect(result.message?.split('ended with:')[1]?.trim().length).toBeLessThanOrEqual(STDERR_TAIL);
	},
);
