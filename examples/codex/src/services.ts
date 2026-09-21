/**
 * How the end of a Codex turn maps to a pass result: the failure it
 * reports, its cause, and the length stop.
 *
 * Codex reports a failed turn as text in a `turn.failed` or `error` event.
 * The text is the only evidence, so the classification reads it.
 */
import type { FailureCause, PassResult } from '@ambionframework/ambion/hosting';

/** HTTP statuses a retry cannot fix: a bad request and the billing and authentication refusals. */
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 422]);

/** Error text that names a quota or an authentication refusal, in phrases a retry cannot clear. */
const PERMANENT_TEXT =
	/insufficient_quota|exceeded your current quota|credit balance|authentication_error|permission_error|invalid_request_error|invalid[_\s-]?api[_\s-]?key|unauthorized|permission denied|not logged in|missing bearer/i;

/** Error text that names a full context window or a spent output limit. */
const LENGTH_TEXT =
	/context[_\s-]?(?:length|window)|max(?:imum)?[_\s-]?output[_\s-]?tokens|exceeds? the (?:model's )?maximum/i;

/** The HTTP status that error text names, or nothing. */
function statusOf(text: string): number | undefined {
	const found = /\b(?:status|http|error)\D{0,12}(\d{3})\b/i.exec(text)?.[1];
	return found === undefined ? undefined : Number(found);
}

/**
 * Whether a failure is permanent or transient. A quota or authentication
 * refusal in the text, or a permanent HTTP status, is permanent. Every
 * other failure is transient, so an uncertain message retries.
 */
export function causeOf(text: string, status?: number | null): FailureCause {
	if (PERMANENT_TEXT.test(text)) return 'permanent';
	const code = status ?? statusOf(text);
	return code !== undefined && PERMANENT_STATUS.has(code) ? 'permanent' : 'transient';
}

/**
 * The pass result a turn stands for. `error` is the text of the failure the
 * turn reported, or nothing when the turn completed. A full context window
 * is a length stop. Any other failure is transient unless its text or
 * status names a refusal a retry cannot clear.
 */
export function passResultOf(error?: string, status?: number | null): PassResult {
	if (error === undefined) return { failed: false };
	if (LENGTH_TEXT.test(error)) return { failed: false, stop: 'length' };
	return { failed: true, cause: causeOf(error, status), message: error };
}
