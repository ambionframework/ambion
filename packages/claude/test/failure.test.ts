/** How a result of the SDK maps to a pass result. */
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { STDERR_TAIL } from '../src/executor.ts';
import { MIN_CLAUDE_VERSION, meetsFloor, passResultOf } from '../src/failure.ts';
import { open, until, viewOf } from './support.ts';

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

it.each([
	{
		what: 'a transient failed result',
		fail: { status: 529, text: 'API Error: 529 overloaded_error: try again later' },
		cause: 'transient',
	},
	{
		what: 'a permanent failed result',
		fail: { status: 401, text: 'API Error: 401 authentication_error: invalid x-api-key' },
		cause: 'permanent',
	},
])(
	'puts the end of the standard error in the message of $what, and takes the cause from the result',
	async ({ fail, cause }) => {
		// For a transient result, the line holds words that the classifier reads as a refusal.
		const line = 'model catalog: 401 authentication_error is not described here';
		const run = open({ turns: [[{ stderr: line }, { fail }]] });
		const result = await run.session.pass({ kind: 'view', view: viewOf() });
		run.session.close?.();
		expect(result).toMatchObject({ failed: true, cause });
		expect(result.message).toContain(fail.text);
		expect(result.message).toContain(line);
	},
);

const PERMANENT = { status: 401, text: 'API Error: 401 authentication_error: invalid x-api-key' };
const TRANSIENT = { status: 529, text: 'API Error: 529 overloaded_error: try again later' };

it.each([
	{ what: 'a permanent result', fail: PERMANENT, cause: 'permanent', stderr: undefined },
	{ what: 'a transient result', fail: TRANSIENT, cause: 'transient', stderr: undefined },
	{
		what: 'a permanent result with stderr',
		fail: PERMANENT,
		cause: 'permanent',
		stderr: 'proxy: refused',
	},
	{
		what: 'a transient result with stderr',
		fail: TRANSIENT,
		cause: 'transient',
		stderr: 'proxy: 401 refused',
	},
])(
	'keeps the cause of $what when the process exits at once after it',
	async ({ fail, cause, stderr }) => {
		const run = open({ turns: [[{ fail: { ...fail, exit: 1, stderr } }]] });
		const result = await run.session.pass({ kind: 'view', view: viewOf() });
		run.session.close?.();
		expect(result).toMatchObject({ failed: true, cause });
		expect(result.message).toContain(fail.text);
		if (stderr !== undefined) expect(result.message).toContain(stderr);
	},
);

it('settles a parked result when close runs inside the drain, and settles once', async () => {
	const run = open({ turns: [[{ fail: PERMANENT }]] });
	const pass = run.session.pass({ kind: 'view', view: viewOf() });
	// The result arrives, and the pass waits for the end of the stderr. Closing now must not hang it.
	await until(() => run.log().some((line) => 'user' in line), 'the fake reading the prompt');
	await new Promise((resolve) => setTimeout(resolve, 20));
	run.session.close?.();
	expect(await pass).toMatchObject({ failed: true, cause: 'permanent' });
});

it.each([
	{ what: 'an older patch', version: '2.1.247', ok: false },
	{ what: 'an older minor', version: '2.0.999', ok: false },
	{ what: 'the floor', version: MIN_CLAUDE_VERSION, ok: true },
	{ what: 'a newer patch', version: '2.1.284', ok: true },
	{ what: 'a newer major with more digits', version: '10.0.0', ok: true },
	{ what: 'a pre-release suffix', version: '2.1.284-beta.1', ok: true },
	{ what: 'an older pre-release', version: '2.1.100-beta.1', ok: false },
	{ what: 'an absent version', version: undefined, ok: false },
	{ what: 'garbage', version: 'not a version', ok: false },
	{ what: 'two numbers', version: '2.1', ok: false },
])('compares $what with the floor', ({ version, ok }) => {
	expect(meetsFloor(version)).toBe(ok);
});

it('refuses an executable below the floor with a permanent failure, and runs no model turn', async () => {
	const run = open({ turns: [[{ say: 'Saturday.' }]], claudeVersion: '2.1.100' });
	const result = await run.session.pass({ kind: 'view', view: viewOf() });
	run.session.close?.();
	expect(result).toMatchObject({ failed: true, cause: 'permanent' });
	expect(result.message).toContain('version 2.1.100');
	expect(result.message).toContain(`needs Claude Code ${MIN_CLAUDE_VERSION} or later`);
	// The trace shows what ran, and the model did nothing.
	expect(run.steps).toContainEqual(
		expect.objectContaining({ type: 'session', version: '2.1.100' }),
	);
	expect(run.steps.some((step) => step.type === 'tool_call')).toBe(false);
	expect(run.commits).toEqual([]);
});
