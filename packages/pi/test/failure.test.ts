/**
 * How a harness run ends a pass. A failed provider message is permanent or
 * transient by its text and by the status its diagnostics report. A run
 * that fails with no such message is transient, and a cut run is no failure.
 */
import type { OperationResultRecord, RunResult } from '@earendil-works/pi-agent-core';
import { LaneBusy } from '@earendil-works/pi-agent-core';
import { type AssistantMessage, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { passOutcome } from '../src/failure.ts';

const run = (
	status: OperationResultRecord['status'],
	error?: OperationResultRecord['error'],
): RunResult => ({
	ok: true,
	value: {
		operationId: 'run',
		kind: 'run',
		status,
		...(error === undefined ? {} : { error }),
		fromTipId: null,
		tipId: null,
		startedAt: 0,
		endedAt: 0,
	},
});

const failed = (text: string, extra: object = {}): AssistantMessage => ({
	...fauxAssistantMessage('', { stopReason: 'error', errorMessage: text }),
	...extra,
});

const assistantError = { code: 'assistant_error', message: 'x' };

describe('the outcome of a run', () => {
	it.each([
		['a credit refusal in the text', 'Your credit balance is too low', {}, 'permanent'],
		['an authentication refusal in the text', 'authentication_error: bad key', {}, 'permanent'],
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
		expect(passOutcome(run('failed', assistantError), failed(text, extra))).toMatchObject({
			failed: true,
			cause,
			error: new Error(text),
		});
	});

	it.each([
		[
			'a failed provider message with no text',
			run('failed', assistantError),
			failed(''),
			{
				failed: true,
				cause: 'transient',
				error: new Error('The activation failed.'),
			},
		],
		[
			'a failed run with no failed provider message, such as a model the harness cannot find',
			run('failed', { code: 'model_unavailable', message: 'The model is unavailable.' }),
			fauxAssistantMessage('Earlier.'),
			{ failed: true, cause: 'transient', error: new Error('The model is unavailable.') },
		],
		[
			'a failed run with no error',
			run('failed'),
			undefined,
			{ failed: true, cause: 'transient', error: new Error('The activation failed.') },
		],
		[
			'a run the lane refused',
			{
				ok: false,
				error: new LaneBusy({
					lane: 'main',
					operationId: 'x',
					operationKind: 'run',
					message: 'busy',
				}),
			},
			undefined,
			{ failed: true, cause: 'transient', error: new Error('busy') },
		],
		[
			'a suspended run',
			{
				ok: true,
				value: {
					operationId: 'x',
					status: 'suspended',
					deferred: { id: 'd', provider: 'p', modelId: 'm', api: 'a' },
				},
			},
			undefined,
			{ failed: true, cause: 'transient', error: new Error('The run suspended.') },
		],
		['a cut run', run('aborted'), failed('aborted'), { failed: false }],
		[
			'a run that stopped at a length limit',
			run('completed'),
			fauxAssistantMessage('Cut.', { stopReason: 'length' }),
			{ failed: false, stop: 'length' },
		],
		['a run that completed', run('completed'), fauxAssistantMessage('Done.'), { failed: false }],
	] as const)('ends %s', (_name, result, last, outcome) => {
		expect(passOutcome(result as RunResult, last)).toEqual(outcome);
	});
});
