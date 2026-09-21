/**
 * How a Claude Agent SDK result maps to a pass result: the failure it
 * reports, its cause, and the length stop.
 */
import type { FailureCause, HarnessSession, PassResult } from '@ambionframework/ambion/hosting';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/** HTTP statuses a retry cannot fix: a bad request and the billing and authentication refusals. */
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 422]);

/** Error text that names a credit or an authentication refusal, in phrases a retry cannot clear. */
const PERMANENT_TEXT =
	/credit balance|authentication_error|permission_error|invalid_request_error|invalid[_\s-]?api[_\s-]?key|x-api-key|unauthorized|permission denied|not logged in/i;

/**
 * Whether a failure is permanent or transient. A credit or authentication
 * refusal in the text, or a permanent HTTP status, is permanent. Every
 * other failure is transient, so an uncertain message retries.
 */
export function causeOf(text: string, status?: number | null): FailureCause {
	if (PERMANENT_TEXT.test(text)) return 'permanent';
	return status !== undefined && status !== null && PERMANENT_STATUS.has(status)
		? 'permanent'
		: 'transient';
}

/** The text a failed result gives: its error list, or its result text. */
function failureText(result: SDKResultMessage): string {
	if (result.subtype === 'success') return result.result || 'The activation failed.';
	return result.errors.join('\n') || `The activation ended with ${result.subtype}.`;
}

/** The HTTP status a result reports, or nothing. */
function statusOf(result: SDKResultMessage): number | null | undefined {
	return result.subtype === 'success' ? result.api_error_status : undefined;
}

/**
 * The pass result a `result` message stands for. A spent budget is
 * permanent, because another try spends again. A turn limit or a
 * `max_tokens` stop is a length stop. A failed result is transient unless
 * its text or status names a refusal a retry cannot clear.
 */
export function passResultOf(result: SDKResultMessage): PassResult {
	if (result.subtype === 'error_max_budget_usd') {
		return { failed: true, cause: 'permanent', message: failureText(result) };
	}
	if (result.subtype === 'error_max_turns' || result.stop_reason === 'max_tokens') {
		return { failed: false, stop: 'length' };
	}
	if (result.is_error || result.subtype !== 'success') {
		const message = failureText(result);
		return { failed: true, cause: causeOf(message, statusOf(result)), message };
	}
	return { failed: false };
}

/**
 * The session a `system` init or a `result` message names, or nothing. The
 * SDK generates the id, and the room records it to resume the seat later.
 */
export function sessionOf(message: SDKMessage): HarnessSession | undefined {
	if (message.type !== 'result' && !(message.type === 'system' && message.subtype === 'init'))
		return undefined;
	return message.session_id === '' ? undefined : { harness: 'claude', id: message.session_id };
}
