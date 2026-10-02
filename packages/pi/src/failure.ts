/**
 * How a settled submission ends a pass: with no failure, at a length limit,
 * or as a failure the room classifies as permanent or transient.
 */
import type { FailureCause } from '@ambionframework/ambion/hosting';
import { classifyCause, providerMessage } from '@ambionframework/ambion/hosting';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SettledSubmissionRecord } from '@earendil-works/pi-durable';

/** What a settled submission means for its pass. */
export type PassOutcome =
	| { readonly failed: false; readonly stop?: 'length' }
	| { readonly failed: true; readonly cause: FailureCause; readonly error: Error };

const transient = (message: string): PassOutcome => ({
	failed: true,
	cause: 'transient',
	error: new Error(message),
});

/** The text of the detail a settled submission carries. */
const detailText = (detail: unknown): string =>
	typeof detail === 'string' && detail !== '' ? detail : 'The activation failed.';

/**
 * The outcome of one settled input, given the last assistant message of the
 * pass. A failed provider message names the failure and its cause. A model
 * error with no such message is transient. A harness with no model for the
 * conversation is a fault in the configuration, which a retry in the same
 * process does not fix, so it is permanent. Every other reason is transient.
 * A cut pass is no failure.
 */
export function passOutcome(
	settled: SettledSubmissionRecord,
	last: AssistantMessage | undefined,
): PassOutcome {
	if (settled.status === 'done') {
		return last?.stopReason === 'length' ? { failed: false, stop: 'length' } : { failed: false };
	}
	switch (settled.reason) {
		case 'aborted':
			return { failed: false };
		case 'no_model':
			return {
				failed: true,
				cause: 'permanent',
				error: new Error('The conversation has no model.'),
			};
		case 'model_error':
			return last?.stopReason === 'error' ? failureOf(last) : providerFailure(settled.detail);
		default:
			return transient(`The activation ended without an answer: ${settled.reason}.`);
	}
}

/** A model error the conversation reports as text alone. */
function providerFailure(detail: unknown): PassOutcome {
	const text = detailText(detail);
	return {
		failed: true,
		cause: classifyCause({ text }),
		error: new Error(providerMessage(text) || text),
	};
}

/** A failed provider message: name it in the error, and classify its cause. */
function failureOf(message: AssistantMessage): PassOutcome {
	return {
		failed: true,
		cause: providerCause(message),
		error: new Error(providerMessage(message.errorMessage) || 'The activation failed.'),
	};
}

/**
 * Whether a failed provider message is permanent or transient. A credit or an
 * authentication refusal in the text, or a permanent HTTP status a diagnostic
 * reports, is permanent. Every other failure is transient, so an uncertain
 * message retries: a wasted retry costs less than a question the room drops.
 */
function providerCause(message: AssistantMessage): FailureCause {
	return classifyCause({ text: message.errorMessage, status: statusOf(message) });
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
