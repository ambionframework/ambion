/**
 * One line of the record, as every participant reads it. `render.ts` builds
 * the prompt around these lines, and the room tools and the runner quote
 * them one at a time.
 */

import { isPosted, isSpoken, isSummary, type Message } from '../types.ts';

/**
 * One line of the record. A presence message has no text, so it reads as an
 * aside; a summary reads like anything else addressed to one person, because
 * that is what it is.
 *
 * A presence line names the author only where it differs from the subject. A
 * person arrives by themselves, and reading "priya arrived by priya" tells a
 * reader nothing.
 *
 * Every line starts with the seq of its message, so a seat can cite any
 * line it reads with the message URI.
 */
export function renderLine(message: Message): string {
	return `#${message.seq} ${lineBody(message)}`;
}

function lineBody(message: Message): string {
	if (message.kind === 'dismissed') {
		return `· ${message.from ?? 'the host'} dismissed say #${message.message}`;
	}
	if (isPosted(message)) {
		const returns = message.returns === undefined ? '' : `, returns #${message.returns}`;
		return `[posted → ${message.to ?? 'the room'}${returns}] ${message.text}${refsOf(message)}`;
	}
	if (isSpoken(message) || isSummary(message)) return spokenLine(message);
	const by = message.from === undefined || message.from === message.subject;
	return `· ${message.subject} ${message.kind}${by ? '' : ` by ${message.from}`}`;
}

/** A said or summary line. A scheduled say names the time it returns. */
function spokenLine(message: Extract<Message, { kind: 'said' | 'summary' }>): string {
	const returns =
		message.kind === 'said' && message.after !== undefined
			? ` (returns at ${new Date(Date.parse(message.at) + message.after * 1000).toISOString()})`
			: '';
	return `[${message.from}${message.to ? ` → ${message.to}` : ''}] ${message.text}${refsOf(message)}${returns}`;
}

export function refsOf(message: { readonly refs?: readonly string[] }): string {
	return message.refs === undefined ? '' : ` (refs: ${message.refs.join(' ')})`;
}
