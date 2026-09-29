/**
 * The record as a seat reads it: one line for each message, and the blocks
 * that fold each summarised range into one. The room windows the record by
 * the tokens of these lines, and the rendering prints them, so both read the
 * same text. Every function is pure.
 */

import {
	isReturned,
	isSpoken,
	isSummary,
	type Message,
	type Seq,
	type SummaryMessage,
} from './types.ts';

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
	if (isReturned(message)) {
		return `[returned → ${message.to}, for ${message.owner}] ${message.text}${refsOf(message)}`;
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

/** One block of the rendered record: a message on its own, or the run one summary stands for. */
export type Block = { line: Message } | { fold: Message[]; by: SummaryMessage };

/**
 * The summary that stands for each seq one covers. A summary is never folded
 * into another one: the message that stands for a range must survive whatever
 * covers it.
 *
 * A summary keeps the fixed range of its closed exchange. A message takes
 * the summary that covers it. Messages between two ranges stay visible.
 */
function foldedBy(record: readonly Message[]): Map<Seq, SummaryMessage> {
	const summaries = record.filter(isSummary);
	const by = new Map<Seq, SummaryMessage>();
	if (summaries.length === 0) return by;
	for (const message of record) {
		if (isSummary(message)) continue;
		const stands = summaries.find(
			({ covers }) => message.seq >= covers.from && message.seq <= covers.through,
		);
		if (stands) by.set(message.seq, stands);
	}
	return by;
}

/** The record as blocks, with each summarised run collapsed into one. */
export function blocks(record: readonly Message[]): Block[] {
	const by = foldedBy(record);
	const out: Block[] = [];
	for (const message of record) {
		const stands = by.get(message.seq);
		if (!stands) {
			out.push({ line: message });
			continue;
		}
		const last = out.at(-1);
		if (last && 'fold' in last && last.by === stands) last.fold.push(message);
		else out.push({ fold: [message], by: stands });
	}
	return out;
}
