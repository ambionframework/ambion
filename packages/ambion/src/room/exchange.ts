/**
 * The exchange: a question, and everything the room does until it goes quiet
 * again. The room goes from idle, to active, and back to idle, and one person
 * owns what happens in between.
 *
 * This is the room's own unit of work, not the assistant's. An assistant is the first
 * thing that reads it — it writes one message per exchange — and it is not the
 * last: a client folds the working under the question it answered, a host
 * measures what an exchange cost, and a later compactor stands over a stretch of
 * them. So the rule lives here, on its own, and every reader takes it from the
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
 * The design contract is `docs/exchange.md`; `docs/assistant.md` says what an
 * assistant makes of one.
 */
import { type Exchange, isSpoken, type Message } from '../types.ts';
import type { Close } from '../wire.ts';

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
		(message) => message.seq > closedThrough && isSpoken(message) && isPerson(message.from),
	);
	return question && { owner: question.from, from: question.seq, at: question.at };
}
