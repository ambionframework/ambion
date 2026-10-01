/**
 * Whether an executor failure is permanent or transient, from its text and
 * an HTTP status when the provider gave one, and the provider's own words
 * for the failure. One classifier serves every executor family.
 */

import type { FailureCause } from '../types.ts';
import type { PassResult } from './executor.ts';

/** HTTP statuses a retry cannot fix: a bad request and the billing and authentication refusals. */
export const PERMANENT_STATUS: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 422]);

/**
 * Error text that names a refusal a retry cannot clear: a credit, a quota, a
 * usage limit, a credential, a login, or a permission. Each provider names
 * a refusal in its own words, so the list holds the words of each: Anthropic,
 * OpenAI, the Claude Code login, and the Codex login. OpenAI sends a spent
 * quota with a 429, and only its text tells it from a rate limit.
 */
const PERMANENT_TEXT =
	/credit balance|billing_error|usage[_\s-]?limit|insufficient_quota|exceeded your current quota|authentication_error|permission_error|invalid_request_error|invalid[_\s-]?api[_\s-]?key|x-api-key|unauthorized|permission denied|not logged in|missing bearer/i;

/**
 * Whether a failure is permanent or transient. A text that names a refusal
 * a retry cannot clear is permanent. `status` beats an unmatched text: a
 * permanent status from `PERMANENT_STATUS` is permanent even when the text
 * names nothing. Each harness brings its own source of a status. Every other
 * failure is transient, so an uncertain failure retries.
 */
export function classifyCause(input: {
	readonly text?: string;
	readonly status?: number | null;
}): FailureCause {
	if (input.text !== undefined && PERMANENT_TEXT.test(input.text)) return 'permanent';
	const status = input.status;
	return status !== undefined && status !== null && PERMANENT_STATUS.has(status)
		? 'permanent'
		: 'transient';
}

/**
 * A fault of the executor that a retry cannot clear, because the retry runs
 * the same configuration. A model that the registry does not hold is one.
 * `failedPass` gives a thrown `PermanentError` the cause `permanent`. It
 * reads the name, so an error from a second copy of this package counts.
 */
export class PermanentError extends Error {
	override name = 'PermanentError';
}

/**
 * A pass that threw, as a failed `PassResult`. The cause is `permanent` for
 * a `PermanentError` and `transient` for every other value. A value that is
 * no `Error` becomes one, so the result always carries `error`.
 */
export function failedPass(thrown: unknown): PassResult {
	const error = thrown instanceof Error ? thrown : new Error(String(thrown));
	return {
		failed: true,
		cause: error.name === 'PermanentError' ? 'permanent' : 'transient',
		message: error.message,
		error,
	};
}

/** The error body a provider returns, as Anthropic and OpenAI shape it. */
type ErrorBody = {
	error?: { type?: unknown; code?: unknown; message?: unknown };
	request_id?: unknown;
};

/**
 * The provider's own words from a failure text. A provider error often
 * arrives as a status and a JSON body, as in `400 {"type":"error",...}`. This
 * gives `400 invalid_request_error: <message> (request <id>)`. A text with no
 * such body stays as it is. The cause reads the original text.
 */
export function providerMessage(text: string): string;
export function providerMessage(text: string | undefined): string | undefined;
export function providerMessage(text: string | undefined): string | undefined {
	const start = text?.indexOf('{') ?? -1;
	if (text === undefined || start < 0) return text;
	let body: ErrorBody;
	try {
		body = JSON.parse(text.slice(start)) as ErrorBody;
	} catch {
		return text;
	}
	const message = body.error?.message;
	if (typeof message !== 'string' || message === '') return text;
	const kind = [body.error?.type, body.error?.code].find((one) => typeof one === 'string');
	const request = typeof body.request_id === 'string' ? ` (request ${body.request_id})` : '';
	const prefix = text.slice(0, start).trim();
	return `${prefix ? `${prefix} ` : ''}${kind ? `${kind}: ` : ''}${message}${request}`;
}
