/**
 * One classifier names a permanent failure for every executor kind. The
 * table holds the failure texts that each harness produces, in the words of
 * its provider, and the status that the harness reads beside the text. A
 * harness test covers only where its status comes from.
 */
import { expect, it } from 'vitest';
import { classifyCause } from '../src/execution/failure.ts';

const USAGE_LIMIT =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}';

it.each([
	// Anthropic, as Pi and Claude receive it.
	['pi', 'Your credit balance is too low', undefined, 'permanent'],
	['pi', 'authentication_error: bad key', undefined, 'permanent'],
	['pi', USAGE_LIMIT, undefined, 'permanent'],
	['pi', 'billing_error: add a payment method', undefined, 'permanent'],
	['pi', 'permission_error: the key cannot use this model', undefined, 'permanent'],
	['pi', 'rate_limit_error: This request would exceed the rate limit.', 429, 'transient'],
	['pi', 'Rate limited at 401 tokens.', undefined, 'transient'],
	['pi', 'Overloaded.', undefined, 'transient'],
	['pi', 'Refused.', 401, 'permanent'],
	['pi', 'Unavailable.', 503, 'transient'],
	// OpenAI, as Pi receives it: a spent quota comes with a 429.
	[
		'pi',
		'You exceeded your current quota, please check your plan. (insufficient_quota)',
		429,
		'permanent',
	],
	[
		'pi',
		'401 {"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}',
		undefined,
		'permanent',
	],
	// Pi on a subscription sign-in: a revoked refresh token, and a provider with no sign-in or key.
	['pi', 'OAuth refresh failed for anthropic: invalid_grant', undefined, 'permanent'],
	['pi', 'Provider is not configured: openai-codex', undefined, 'permanent'],
	// The Claude Agent SDK.
	['claude', 'invalid x-api-key', undefined, 'permanent'],
	['claude', 'Invalid API key · Please run /login', undefined, 'permanent'],
	['claude', 'Not logged in · Please run /login', undefined, 'permanent'],
	['claude', 'You have reached your specified API usage limits.', 400, 'permanent'],
	['claude', 'Claude AI usage limit reached|1790380800', 429, 'permanent'],
	['claude', 'rate_limit_error: slow down', 429, 'transient'],
	['claude', 'rate limit: 400000 tokens per minute', undefined, 'transient'],
	['claude', 'API Error: 529 overloaded', 529, 'transient'],
	['claude', 'bad request', 400, 'permanent'],
	// The Codex SDK: the text is the only evidence.
	['codex', 'unexpected status 401 Unauthorized: invalid api key', undefined, 'permanent'],
	[
		'codex',
		'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
		undefined,
		'permanent',
	],
	['codex', 'You exceeded your current quota, please check your plan.', undefined, 'permanent'],
	['codex', 'Not logged in. Run codex login.', undefined, 'permanent'],
	['codex', 'insufficient_quota', undefined, 'permanent'],
	['codex', "You've hit your usage limit. Try again later.", undefined, 'permanent'],
	['codex', 'unexpected status 429: usage_limit_reached', 429, 'permanent'],
	['codex', 'unexpected status 429: rate_limit_exceeded', 429, 'transient'],
	['codex', 'stream error: 529 overloaded_error: try again later', 529, 'transient'],
	['codex', 'connection reset by peer', undefined, 'transient'],
	['codex', 'something unknown went wrong', undefined, 'transient'],
	['codex', 'The request failed.', 403, 'permanent'],
	['codex', 'The request failed.', 500, 'transient'],
	['codex', 'The request failed.', null, 'transient'],
] as const)(
	'classifies what %s reports: %j with status %s as %s',
	(_harness, text, status, cause) => {
		expect(classifyCause({ text, status })).toBe(cause);
	},
);

it('classifies a failure with no text by its status alone', () => {
	expect(classifyCause({ status: 402 })).toBe('permanent');
	expect(classifyCause({})).toBe('transient');
});
