/**
 * How a harness run ends a pass: with no failure, at a length limit, or as a
 * failure the room classifies as permanent or transient.
 */
import type { FailureCause } from '@ambionframework/ambion/hosting';
import { classifyCause } from '@ambionframework/ambion/hosting';
import type { RunResult } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

/** What a run means for its pass. */
export type PassOutcome =
	| { readonly failed: false; readonly stop?: 'length' }
	| { readonly failed: true; readonly cause: FailureCause; readonly error: Error };

const transient = (message: string): PassOutcome => ({
	failed: true,
	cause: 'transient',
	error: new Error(message),
});

/**
 * The outcome of one run, given the last assistant message it produced. A
 * failed provider message names the failure and its cause. A run that fails
 * with no such message, such as a model the harness cannot find, is
 * transient. A cut run is no failure.
 */
export function passOutcome(result: RunResult, last: AssistantMessage | undefined): PassOutcome {
	if (!result.ok) return transient(result.error.message);
	const run = result.value;
	if (run.status === 'suspended') return transient('The run suspended.');
	if (run.status === 'aborted') return { failed: false };
	if (run.status === 'failed') {
		if (last?.stopReason === 'error') return failureOf(last);
		return transient(run.error?.message ?? 'The activation failed.');
	}
	return last?.stopReason === 'length' ? { failed: false, stop: 'length' } : { failed: false };
}

/** A failed provider message: name it in the error, and classify its cause. */
function failureOf(message: AssistantMessage): PassOutcome {
	return {
		failed: true,
		cause: providerCause(message),
		error: new Error(message.errorMessage || 'The activation failed.'),
	};
}

/**
 * Whether a failed provider message is permanent or transient. A credit or an
 * authentication refusal in the text, or a permanent HTTP status a diagnostic
 * reports, is permanent. Every other failure is transient, so an uncertain
 * message retries: a wasted retry costs less than a question the room drops.
 */
function providerCause(message: AssistantMessage): FailureCause {
	return classifyCause({
		text: message.errorMessage,
		status: statusOf(message),
		permanent: PERMANENT_TEXT,
	});
}

/** One provider diagnostic, as the classifier reads it. */
type Diagnostic = { error?: { code?: unknown }; details?: Record<string, unknown> };

/**
 * The HTTP status a diagnostic reports, or nothing. The classifier reads a
 * status only from a diagnostic, never from free error text, because a rate
 * limit names a token count that reads like a status. The last diagnostic
 * with a status wins, so a final attempt speaks for the failure.
 */
function statusOf(message: AssistantMessage): number | undefined {
	const diagnostics: Diagnostic[] = message.diagnostics ?? [];
	let status: number | undefined;
	for (const diagnostic of diagnostics) {
		const found = diagnosticStatus(diagnostic);
		if (found !== undefined) status = found;
	}
	return status;
}

/** A status code one diagnostic reports, on its error code or its details. */
function diagnosticStatus(diagnostic: Diagnostic): number | undefined {
	const code = httpStatus(diagnostic.error?.code);
	if (code !== undefined) return code;
	const details = diagnostic.details ?? {};
	for (const key of ['status', 'statusCode', 'httpStatus']) {
		const value = httpStatus(details[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** A whole HTTP status, from a number or a fully numeric string, in the 4xx or 5xx range. */
function httpStatus(value: unknown): number | undefined {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d+$/.test(value.trim())
				? Number(value.trim())
				: undefined;
	if (parsed === undefined || !Number.isInteger(parsed)) return undefined;
	return parsed >= 400 && parsed <= 599 ? parsed : undefined;
}

/** Error text that names a credit or an authentication refusal, in phrases a retry cannot clear. */
const PERMANENT_TEXT =
	/credit balance|authentication_error|permission_error|invalid_request_error|invalid[_\s]?api[_\s]?key|unauthorized|permission denied/i;
