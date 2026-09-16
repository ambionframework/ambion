/**
 * The exchange: a question, and everything the room does until it goes quiet
 * again. The room goes from idle, to active, and back to idle, and one person
 * owns what happens in between.
 *
 * This is the room's own unit of work. A configured writer may read it and
 * write one message per exchange, but it is not the last reader: a client
 * folds the working under the question it answered, and a host
 * measures what an exchange cost. So the rule lives here, on its own, and every reader takes it from the
 * same place.
 *
 * The rule, in three sentences:
 *
 * - **A person's question opens one**, when no exchange is open. Nothing else
 *   does: an agent speaking into a quiet room opens nothing, and arriving or
 *   leaving asks nobody anything.
 * - **Quiescence closes it.** The room reconciles when nothing is live, and
 *   writes a close that names the range the exchange turned out to hold.
 * - **What lands while it is open steers it and changes nothing.** Not the
 *   owner, not the range, not who the answer belongs to.
 *
 * An exchange is a fold over the journal: the first person's question after the
 * last close is the open one. A room resumed mid-exchange continues it.
 *
 * The design contract is `docs/exchange.md`.
 */

import { decodeActivationId } from '../activation-id.ts';
import {
	type Exchange,
	isSpoken,
	isSummary,
	type Message,
	type SpokenMessage,
	type SummaryMessage,
} from '../types.ts';
import type { Close, LeaseHold } from '../wire.ts';

export type SummaryCompletion =
	| { readonly status: 'published'; readonly summary: SummaryMessage }
	| { readonly status: 'pending'; readonly writer?: string }
	| { readonly status: 'silent' | 'failed' };

/** The recorded response outcome, with its writer only while summary work remains owed. */
export function summaryCompletion(
	close: Pick<Close, 'owner' | 'from' | 'through' | 'summary'>,
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseHold>,
): SummaryCompletion {
	const summary = messages.find(
		(message): message is SummaryMessage =>
			isSummary(message) &&
			message.from === close.summary &&
			message.to === close.owner &&
			message.covers.from <= close.from &&
			message.covers.through >= close.through,
	);
	if (summary !== undefined) return { status: 'published', summary };
	const writer = close.summary;
	if (writer === undefined) return { status: 'silent' };
	if (
		messages.some(
			(message) =>
				message.kind === 'unseated' && message.subject === writer && message.seq > close.through,
		)
	)
		return { status: 'failed' };
	const drafts = [...leases.values()].filter((lease) => {
		const parsed = decodeActivationId(lease.id);
		// A terminal lease from another seat cannot settle this close.
		return (
			parsed?.source === 'closed' && parsed.position === close.through && parsed.seat === writer
		);
	});
	const released = drafts.some((lease) => lease.phase === 'ended' && lease.reason === 'released');
	const stoodDown =
		released ||
		drafts.some(
			(lease) =>
				lease.phase === 'ended' && (lease.reason === 'revoked' || lease.reason === 'abandoned'),
		);
	if (!stoodDown) return { status: 'pending', writer };
	// Preserve reads of histories with a running draft beside a terminal one.
	if (drafts.some((lease) => lease.phase === 'running')) return { status: 'pending' };
	if (released) return { status: 'silent' };
	return drafts.length === 0 ? { status: 'pending' } : { status: 'failed' };
}

/**
 * The open exchange, or nothing when nobody has asked since the last close:
 * the first question a person asked after the last close's `through`.
 */
export function openExchange(
	messages: readonly Message[],
	closes: readonly Close[],
	isPerson: (name: string) => boolean,
): Exchange | undefined {
	const closedThrough = closes.at(-1)?.through ?? 0;
	const question = messages.find(
		(message): message is SpokenMessage =>
			message.seq > closedThrough && isSpoken(message) && isPerson(message.from),
	);
	return question && { owner: question.from, from: question.seq, at: question.at };
}
