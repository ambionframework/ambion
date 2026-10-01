/**
 * How a Claude Agent SDK result maps to a pass result: the failure it
 * reports, its cause, and the length stop.
 */
import type { PassResult } from '@ambionframework/ambion/hosting';
import { classifyCause, providerMessage } from '@ambionframework/ambion/hosting';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

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
		return { failed: true, cause: 'permanent', message: providerMessage(failureText(result)) };
	}
	if (result.subtype === 'error_max_turns' || result.stop_reason === 'max_tokens') {
		return { failed: false, stop: 'length' };
	}
	if (result.is_error || result.subtype !== 'success') {
		const message = failureText(result);
		return {
			failed: true,
			cause: classifyCause({ text: message, status: statusOf(result) }),
			message: providerMessage(message),
		};
	}
	return { failed: false };
}

/** The text of the error the SDK reports for a session id it cannot resume. */
const UNRESUMABLE = /No conversation found with session ID/i;

/**
 * Whether a result reports a session that the SDK could not resume. The
 * SDK sends this as an error result after its init message.
 */
export function unresumableResult(result: SDKResultMessage): boolean {
	return (result.is_error || result.subtype !== 'success') && UNRESUMABLE.test(failureText(result));
}

/**
 * The id of the session a `system` init or a `result` message names, or
 * nothing. The SDK generates the id, and the room records it to resume the
 * seat later.
 */
export function sessionOf(message: SDKMessage): string | undefined {
	if (message.type !== 'result' && !(message.type === 'system' && message.subtype === 'init'))
		return undefined;
	return message.session_id === '' ? undefined : message.session_id;
}

/**
 * The oldest Claude Code executable that honors `verbatimPrompts`. An older
 * one ignores `client_composed`, so it reads the file that an `@path` mention
 * in a user message names, and it runs a message that starts with `/` as a
 * command. The executor refuses to run a seat on an executable below this.
 */
export const MIN_CLAUDE_VERSION = '2.1.248';

/** The numbers of a version such as `2.1.284` or `2.1.284-beta.1`, or nothing when it has none. */
function numbersOf(version: string | undefined): number[] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
	return match === null ? undefined : match.slice(1, 4).map(Number);
}

/** Whether a version is at or above the floor. An absent or unreadable version is not. */
export function meetsFloor(version: string | undefined, floor = MIN_CLAUDE_VERSION): boolean {
	const found = numbersOf(version);
	const least = numbersOf(floor);
	if (found === undefined || least === undefined) return false;
	for (const [index, number] of found.entries()) {
		const other = least[index] ?? 0;
		if (number !== other) return number > other;
	}
	return true;
}

/** The refusal for an executable below the floor, or nothing when it meets it. */
export function floorRefusal(version: string | undefined): PassResult | undefined {
	if (meetsFloor(version)) return undefined;
	const found = version === undefined || version === '' ? 'no version' : `version ${version}`;
	return {
		failed: true,
		cause: 'permanent',
		message: `The Claude Code executable reports ${found}. The executor needs Claude Code ${MIN_CLAUDE_VERSION} or later.`,
	};
}
