/**
 * Whether an executor failure is permanent or transient, from the text a
 * harness matched and an HTTP status when the provider gave one, and the
 * provider's own words for the failure.
 */

import type { FailureCause } from '../types.ts';

/** HTTP statuses a retry cannot fix: a bad request and the billing and authentication refusals. */
export const PERMANENT_STATUS: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 422]);

/**
 * Whether a failure is permanent or transient. `permanent` is the text a
 * harness matches for a refusal a retry cannot clear; each harness brings
 * its own, because each provider names a refusal in its own words.
 * `status` beats an unmatched text: a permanent status from `PERMANENT_STATUS`
 * is permanent even when the text names nothing. Every other failure is
 * transient, so an uncertain failure retries rather than gives up.
 */
export function classifyCause(input: {
	readonly text?: string;
	readonly status?: number | null;
	readonly permanent: RegExp;
}): FailureCause {
	if (input.text !== undefined && input.permanent.test(input.text)) return 'permanent';
	const status = input.status;
	return status !== undefined && status !== null && PERMANENT_STATUS.has(status)
		? 'permanent'
		: 'transient';
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
