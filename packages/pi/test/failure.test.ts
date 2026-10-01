/**
 * How a settled submission ends a pass. A failed provider message is
 * permanent or transient by its text and by the status its diagnostics
 * report. A model error with no such message is classified by its text. A
 * conversation with no model is permanent, every other refusal is
 * transient, and a cut pass is no failure.
 */

import { providerMessage } from '@ambionframework/ambion/hosting';
import { type AssistantMessage, fauxAssistantMessage } from '@earendil-works/pi-ai';
import {
	type EntryId,
	ROOT_CONVERSATION_ID,
	type SettledSubmissionRecord,
	type SubmissionId,
} from '@earendil-works/pi-durable';
import { describe, expect, it } from 'vitest';
import { passOutcome } from '../src/failure.ts';

/** What a submission settles with. */
type Settling =
	{ status: 'done'; answer: EntryId } | { status: 'unanswered'; reason: string; detail?: string };

/** The record of a settled input. The ids are the ones of a conversation that ran. */
const settled = (outcome: Settling): SettledSubmissionRecord =>
	({
		id: 1 as SubmissionId,
		conversationId: ROOT_CONVERSATION_ID,
		type: 'input',
		entry: 1 as EntryId,
		...outcome,
	}) as SettledSubmissionRecord;

const unanswered = (reason: string, detail?: string) =>
	settled({ status: 'unanswered', reason, ...(detail === undefined ? {} : { detail }) });

const answered = settled({ status: 'done', answer: 2 as EntryId });

const failed = (text: string, extra: object = {}): AssistantMessage => ({
	...fauxAssistantMessage('', { stopReason: 'error', errorMessage: text }),
	...extra,
});

describe('the outcome of a settled input', () => {
	it.each([
		['a credit refusal in the text', 'Your credit balance is too low', {}, 'permanent'],
		[
			'a spent usage limit, as Anthropic words it',
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}',
			{},
			'permanent',
		],
		[
			'a spent quota, as OpenAI words it, with its 429',
			'You exceeded your current quota, please check your plan. (insufficient_quota)',
			{ diagnostics: [{ details: { status: 429 } }] },
			'permanent',
		],
		[
			'a rate limit with its 429',
			'rate_limit_error: This request would exceed the rate limit for your organization.',
			{ diagnostics: [{ details: { status: 429 } }] },
			'transient',
		],
		[
			'a 401 in a diagnostic',
			'Refused.',
			{ diagnostics: [{ details: { status: '401' } }] },
			'permanent',
		],
		[
			'a 403 in a diagnostic code',
			'Refused.',
			{ diagnostics: [{ error: { code: 403 } }] },
			'permanent',
		],
		[
			'a 503 in a diagnostic',
			'Unavailable.',
			{ diagnostics: [{ details: { statusCode: 503 } }] },
			'transient',
		],
		[
			'the last diagnostic with a status',
			'Refused.',
			{ diagnostics: [{ details: { httpStatus: 401 } }, { error: { code: '529' } }, {}] },
			'transient',
		],
		[
			'a status out of the error range, or not whole',
			'Refused.',
			{ diagnostics: [{ details: { status: 200 } }, { error: { code: '4o1' } }] },
			'transient',
		],
		['a number in free text', 'Rate limited at 401 tokens.', {}, 'transient'],
		['an overload with no status', 'Overloaded.', {}, 'transient'],
	] as const)('classifies %s', (_name, text, extra, cause) => {
		expect(passOutcome(unanswered('model_error', text), failed(text, extra))).toMatchObject({
			failed: true,
			cause,
			error: new Error(providerMessage(text)),
		});
	});

	it.each([
		[
			'a failed provider message with no text',
			unanswered('model_error', ''),
			failed(''),
			{ failed: true, cause: 'transient', error: new Error('The activation failed.') },
		],
		[
			'a model error with no failed provider message, by the text of the error',
			unanswered('model_error', 'Your credit balance is too low'),
			fauxAssistantMessage('Earlier.'),
			{ failed: true, cause: 'permanent', error: new Error('Your credit balance is too low') },
		],
		[
			'a model error with no text at all',
			unanswered('model_error'),
			undefined,
			{ failed: true, cause: 'transient', error: new Error('The activation failed.') },
		],
		[
			'a conversation with no model',
			unanswered('no_model'),
			undefined,
			{ failed: true, cause: 'permanent', error: new Error('The conversation has no model.') },
		],
		[
			'a fault of the harness',
			unanswered('faulted', 'The disk failed.'),
			fauxAssistantMessage('Earlier.'),
			{
				failed: true,
				cause: 'transient',
				error: new Error('The activation ended without an answer: faulted.'),
			},
		],
		[
			'an input the harness left stale',
			unanswered('stale'),
			undefined,
			{
				failed: true,
				cause: 'transient',
				error: new Error('The activation ended without an answer: stale.'),
			},
		],
		['a cut pass', unanswered('aborted'), failed('aborted'), { failed: false }],
		[
			'a pass that stopped at a length limit',
			answered,
			fauxAssistantMessage('Cut.', { stopReason: 'length' }),
			{ failed: false, stop: 'length' },
		],
		['a pass that answered', answered, fauxAssistantMessage('Done.'), { failed: false }],
	] as const)('ends %s', (_name, record, last, outcome) => {
		expect(passOutcome(record, last)).toEqual(outcome);
	});
});
